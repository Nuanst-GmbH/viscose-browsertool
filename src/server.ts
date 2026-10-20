import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addCookies, closeAll, getPage, hasPage } from "./browser.js";
import { cdpSend, probeTabStatus, requestBrowserTab, requestCookies } from "./bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  // stderr only — stdout is the MCP protocol channel.
  process.stderr.write(`[browser-tool] ${msg}\n`);
}

type ToolResult =
  | { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] }
  | { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError: true };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const TRUNC_TEXT = 20_000;
const TRUNC_HTML = 50_000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n[truncated — ${s.length - max} chars omitted]` : s;
}

function validateUrl(url: string): { href?: string; error?: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: `only http/https URLs are supported (got ${u.protocol})` };
    }
    return { href: u.href };
  } catch {
    return { error: `invalid URL: ${url}` };
  }
}

const NO_PAGE = "No page open. Call open_url first.";

// Wraps a tool handler: normalizes args typing and turns thrown errors into
// MCP error results instead of crashing the protocol.
function wrap<T>(fn: (args: T) => Promise<ToolResult>): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

// Shared note appended to results: which surface a tool actually drives (the
// integrated tab when available, else the headless twin).
const ENGINE_NOTE =
  "Tools act on the VS Code integrated browser tab while it is open with its CDP session attached " +
  "(results match the page you see, including SSO/Kerberos logins); otherwise they fall back to the " +
  "headless twin, which keeps its own session.";
const TWIN_NOTE = ENGINE_NOTE; // alias kept for existing descriptions
const TAB_NOTE = ENGINE_NOTE; // alias kept for existing descriptions

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
// The VS Code integrated browser tab is the primary automation surface — it is
// the real, SSO-authenticated page the user is watching. The headless Playwright
// twin is a pure fallback for when the tab is unavailable. Both implement the
// same Engine interface so every tool is engine-agnostic.

const TAB_LABEL = "via integrated tab";
const TWIN_LABEL = "via headless twin (tab unavailable)";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Engine {
  readonly label: string;
  goto(url: string): Promise<{ url: string; title: string }>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string, submit: boolean): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  text(selector?: string): Promise<string>;
  html(selector?: string): Promise<string>;
  url(): Promise<string>;
  title(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  waitFor(selector: string | undefined, timeoutMs: number): Promise<number>;
  screenshot(fullPage: boolean): Promise<string>;
}

// Headless Playwright twin — the pre-existing behaviour, wrapped verbatim.
class TwinEngine implements Engine {
  readonly label = TWIN_LABEL;

  async goto(url: string): Promise<{ url: string; title: string }> {
    const pg = await getPage();
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return { url: pg.url(), title: await pg.title().catch(() => "") };
  }
  async click(selector: string): Promise<void> {
    const pg = await getPage();
    const el = await pg.$(selector);
    if (!el) throw new Error(`No element found for selector: ${selector}`);
    await pg.click(selector, { timeout: 15_000 });
  }
  async fill(selector: string, value: string, submit: boolean): Promise<void> {
    const pg = await getPage();
    await pg.fill(selector, value, { timeout: 15_000 });
    if (submit) await pg.press(selector, "Enter");
  }
  async select(selector: string, value: string): Promise<void> {
    const pg = await getPage();
    await pg.selectOption(selector, value, { timeout: 15_000 });
  }
  async text(selector?: string): Promise<string> {
    const pg = await getPage();
    return selector
      ? await pg.$eval(selector, (el) => el.innerText)
      : await pg.$eval("body", (el) => el.innerText);
  }
  async html(selector?: string): Promise<string> {
    const pg = await getPage();
    return selector
      ? await pg.$eval(selector, (el) => el.outerHTML)
      : await pg.evaluate("document.documentElement.outerHTML");
  }
  async url(): Promise<string> {
    const pg = await getPage();
    return pg.url();
  }
  async title(): Promise<string> {
    const pg = await getPage();
    return pg.title();
  }
  async evaluate(expression: string): Promise<unknown> {
    const pg = await getPage();
    return pg.evaluate(expression as string);
  }
  async waitFor(selector: string | undefined, timeoutMs: number): Promise<number> {
    const pg = await getPage();
    const started = Date.now();
    if (selector) await pg.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
    else await pg.waitForLoadState("load", { timeout: timeoutMs });
    return Date.now() - started;
  }
  async screenshot(fullPage: boolean): Promise<string> {
    const pg = await getPage();
    return (await pg.screenshot({ type: "png", fullPage })).toString("base64");
  }
}

// Integrated tab driven over CDP through the pipe (see cdpSend in bridge.ts).
class TabEngine implements Engine {
  readonly label = TAB_LABEL;

  private async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await cdpSend(method, params);
    if (!res.ok) throw new Error(res.error);
    return res.result as T;
  }

  async evaluate(expression: string): Promise<unknown> {
    const res = await this.cdp<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  }

  private asString(v: unknown): string {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  async url(): Promise<string> {
    return this.asString(await this.evaluate("location.href"));
  }
  async title(): Promise<string> {
    return this.asString(await this.evaluate("document.title"));
  }
  async text(selector?: string): Promise<string> {
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ""; })()`
      : "document.body.innerText";
    return this.asString(await this.evaluate(expr));
  }
  async html(selector?: string): Promise<string> {
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : ""; })()`
      : "document.documentElement.outerHTML";
    return this.asString(await this.evaluate(expr));
  }
  async goto(url: string): Promise<{ url: string; title: string }> {
    await this.cdp("Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await this.evaluate("document.readyState");
      if (state === "complete" || state === "interactive") break;
      if (Date.now() > deadline) break;
      await sleep(150);
    }
    const [u, t] = await Promise.all([this.url(), this.title()]);
    return { url: u, title: t };
  }
  async click(selector: string): Promise<void> {
    const box = (await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ` +
        `el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); ` +
        `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    )) as { x: number; y: number } | null;
    if (!box || typeof box.x !== "number" || typeof box.y !== "number") {
      throw new Error(`No element found for selector: ${selector}`);
    }
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }
  async fill(selector: string, value: string, submit: boolean): Promise<void> {
    // Set through the native value setter + dispatch input/change so framework
    // state (React, etc.) updates; a plain el.value = won't fire handlers.
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("no element");
        el.focus();
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        const v = ${JSON.stringify(value)};
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
    if (submit) {
      await this.cdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await this.cdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
  }
  async select(selector: string, value: string): Promise<void> {
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("no element");
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
  }
  async waitFor(selector: string | undefined, timeoutMs: number): Promise<number> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    for (;;) {
      if (selector) {
        const visible = await this.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
            `return !!(el && el.offsetParent !== null); })()`,
        );
        if (visible) return Date.now() - started;
      } else {
        const state = await this.evaluate("document.readyState");
        if (state === "complete") return Date.now() - started;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting for ${selector ?? "page load"}`);
      }
      await sleep(100);
    }
  }
  async screenshot(fullPage: boolean): Promise<string> {
    const res = await this.cdp<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    if (!res?.data) throw new Error("screenshot returned no data");
    return res.data;
  }
}

// Engine selection + fallback seeding.
let tabEngine: Engine | null = null;
let twinEngine: Engine | null = null;
let lastUrl: string | null = null;

function getTab(): Engine {
  if (!tabEngine) tabEngine = new TabEngine();
  return tabEngine;
}
function getTwin(): Engine {
  if (!twinEngine) twinEngine = new TwinEngine();
  return twinEngine;
}

// Use the tab when it is open with a live CDP session, else the twin.
async function resolveEngine(): Promise<Engine> {
  const s = await probeTabStatus();
  if (s.ok && s.present && s.cdp) return getTab();
  return getTwin();
}

// Resolve an engine for a non-navigation tool. On the twin with no page yet,
// restore the last URL we saw (so a tab close doesn't drop into a blank page);
// with no URL to restore, report noPage so the caller can hint to open_url.
async function acquireEngine(): Promise<{ engine: Engine } | { noPage: true }> {
  const e = await resolveEngine();
  if (!(e instanceof TwinEngine) || hasPage()) return { engine: e };
  if (lastUrl) {
    const seed = lastUrl;
    await getPage()
      .then((pg) => pg.goto(seed, { waitUntil: "domcontentloaded", timeout: 60_000 }))
      .catch(() => undefined);
    return { engine: e };
  }
  return { noPage: true };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "browser-tool", version: "0.3.0" });

server.registerTool(
  "open_url",
  {
    title: "Open URL in browser",
    description:
      "Open a URL in the tool's headless browser (the engine that performs all actions). " +
      "Replaces the current page. Use for the first URL in a session or to switch to a new site. " +
      TAB_NOTE + " " + TWIN_NOTE,
    inputSchema: { url: z.string().min(1) },
  },
  wrap(async ({ url }) => {
    const v = validateUrl(url);
    if (v.error) return fail(v.error);
    const e = await resolveEngine();
    const r = await e.goto(v.href!);
    lastUrl = r.url;
    if (!(e instanceof TabEngine)) void requestBrowserTab(v.href!);
    return ok(`Opened ${r.url}${r.title ? ` — "${r.title}"` : ""} ${e.label}.`);
  }),
);

server.registerTool(
  "navigate",
  {
    title: "Navigate",
    description:
      "Navigate the current page to a new URL. " + TAB_NOTE,
    inputSchema: { url: z.string().min(1) },
  },
  wrap(async ({ url }) => {
    const v = validateUrl(url);
    if (v.error) return fail(v.error);
    const e = await resolveEngine();
    const r = await e.goto(v.href!);
    lastUrl = r.url;
    if (!(e instanceof TabEngine)) void requestBrowserTab(v.href!);
    return ok(`Navigated to ${r.url}${r.title ? ` — "${r.title}"` : ""} ${e.label}.`);
  }),
);

server.registerTool(
  "sync_cookies",
  {
    title: "Sync cookies from integrated tab",
    description:
      "Copy cookies from VS Code's integrated browser tab (read via its live CDP session) into the headless " +
      "twin, so an SSO/Kerberos login you already did in the tab applies to automated actions. Requires the " +
      "browserTool.browserTab setting enabled and a tab that is already signed in to the site. Optionally " +
      "pass url to navigate the twin there afterwards and verify the login took effect.",
    inputSchema: { url: z.string().optional() },
  },
  wrap(async ({ url }) => {
    const res = await requestCookies();
    if (!res.ok) return fail(`Cookie sync failed: ${res.error}`);
    const r = await addCookies(res.cookies);
    let msg = `Synced ${r.added}/${r.total} cookies from the integrated tab into the headless twin.`;
    if (r.errors.length) msg += ` Skipped ${r.errors.length}: ${r.errors.slice(0, 3).join("; ")}`;
    if (url) {
      const v = validateUrl(url);
      if (v.error) return fail(v.error);
      const pg = await getPage();
      await pg.goto(v.href!, { waitUntil: "domcontentloaded", timeout: 60_000 });
      void requestBrowserTab(v.href!);
      const title = await pg.title().catch(() => "");
      msg += ` Navigated to ${pg.url()}${title ? ` — "${title}"` : ""}.`;
    }
    return ok(msg + " " + TWIN_NOTE);
  }),
);

server.registerTool(
  "click",
  {
    title: "Click",
    description: "Click an element by CSS selector on the current page.",
    inputSchema: { selector: z.string().min(1) },
  },
  wrap(async ({ selector }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    await ac.engine.click(selector);
    return ok(`Clicked ${selector} ${ac.engine.label}.`);
  }),
);

server.registerTool(
  "type",
  {
    title: "Type text",
    description:
      "Type a value into an input/textarea by CSS selector (clears it first). " +
      "Set submit=true to press Enter afterwards (e.g. to submit a form).",
    inputSchema: {
      selector: z.string().min(1),
      value: z.string(),
      submit: z.boolean().default(false),
    },
  },
  wrap(async ({ selector, value, submit }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    await ac.engine.fill(selector, value, submit);
    return ok(
      `Typed ${JSON.stringify(value)} into ${selector}${submit ? " and pressed Enter" : ""} ${ac.engine.label}.`,
    );
  }),
);

server.registerTool(
  "select",
  {
    title: "Select option",
    description: "Select an option in a <select> element by CSS selector, matching on option value, label, or index.",
    inputSchema: {
      selector: z.string().min(1),
      value: z.string().min(1),
    },
  },
  wrap(async ({ selector, value }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    await ac.engine.select(selector, value);
    return ok(`Selected ${JSON.stringify(value)} in ${selector} ${ac.engine.label}.`);
  }),
);

server.registerTool(
  "get_text",
  {
    title: "Get text",
    description:
      "Read visible text (innerText) of an element by CSS selector, or of the whole page body if no selector given.",
    inputSchema: { selector: z.string().optional() },
  },
  wrap(async ({ selector }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    const text = await ac.engine.text(selector);
    return ok(truncate(text, TRUNC_TEXT));
  }),
);

server.registerTool(
  "get_html",
  {
    title: "Get HTML",
    description:
      "Read the outerHTML of an element by CSS selector, or of the whole document if no selector given. " +
      "Use for inspecting structure, attributes, and building selectors.",
    inputSchema: { selector: z.string().optional() },
  },
  wrap(async ({ selector }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    const html = await ac.engine.html(selector);
    return ok(truncate(html, TRUNC_HTML));
  }),
);

server.registerTool(
  "get_url",
  {
    title: "Get URL",
    description: "Return the current URL of the page.",
    inputSchema: {},
  },
  wrap(async () => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    return ok(`${await ac.engine.url()} ${ac.engine.label}`);
  }),
);

server.registerTool(
  "get_title",
  {
    title: "Get title",
    description: "Return the current page title.",
    inputSchema: {},
  },
  wrap(async () => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    return ok(`${await ac.engine.title()} ${ac.engine.label}`);
  }),
);

server.registerTool(
  "eval_js",
  {
    title: "Evaluate JavaScript",
    description:
      "Evaluate a JavaScript expression in the page context and return the (JSON-serialized) result. " +
      "Use for reading page state, querying the DOM, or anything the other tools don't cover.",
    inputSchema: { expression: z.string().min(1) },
  },
  wrap(async ({ expression }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    const value: unknown = await ac.engine.evaluate(expression);
    const text =
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value) ?? "undefined");
    return ok(truncate(text, TRUNC_TEXT));
  }),
);

server.registerTool(
  "wait_for",
  {
    title: "Wait for",
    description:
      "Wait until an element (CSS selector) is visible, or for page load if no selector given. " +
      "Returns how long the wait took.",
    inputSchema: {
      selector: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(120_000).default(15_000),
    },
  },
  wrap(async ({ selector, timeoutMs }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    const ms = await ac.engine.waitFor(selector, timeoutMs);
    return ok(
      selector
        ? `Selector ${selector} visible after ${ms} ms. ${ac.engine.label}`
        : `Page load complete after ${ms} ms. ${ac.engine.label}`,
    );
  }),
);

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      "Capture a PNG screenshot of the current page (headless twin) and return it as an image. " +
      "Set fullPage=true to capture below the fold. " + TWIN_NOTE,
    inputSchema: { fullPage: z.boolean().default(false) },
  },
  wrap(async ({ fullPage }) => {
    const ac = await acquireEngine();
    if ("noPage" in ac) return fail(NO_PAGE);
    const e = ac.engine;
    const [data, u] = await Promise.all([e.screenshot(fullPage), e.url()]);
    return {
      content: [
        { type: "image", data, mimeType: "image/png" },
        {
          type: "text",
          text: `screenshot of ${u} (${fullPage ? "full page" : "viewport"}) ${e.label}. ${ENGINE_NOTE}`,
        },
      ],
    };
  }),
);

server.registerTool(
  "close",
  {
    title: "Close browser",
    description: "Close the page, context, and browser, freeing all resources. Call open_url to start again.",
    inputSchema: {},
  },
  wrap(async () => {
    await closeAll();
    return ok("Browser session closed.");
  }),
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("browser-tool MCP server running on stdio");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void closeAll().catch(() => undefined).finally(() => process.exit(0));
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
