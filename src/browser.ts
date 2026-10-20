import { Browser, BrowserContext, Page, chromium, type Cookie } from "playwright";

// The "twin": a single headless Chromium that performs all automated
// interaction. One context/page for the server's lifetime so cookies and
// SSO state persist across tool calls within a Claude session.
const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export async function getPage(): Promise<Page> {
  if (!browser || !browser.isConnected()) {
    const opts: Parameters<typeof chromium.launch>[0] = {
      headless: true,
      // BROWSER_TOOL_CHANNEL lets the user point at a local Chrome/Edge
      // install (e.g. "msedge") when Playwright's own browser download
      // is unavailable on a corporate network.
      ...(process.env.BROWSER_TOOL_CHANNEL
        ? { channel: process.env.BROWSER_TOOL_CHANNEL }
        : {}),
      // BROWSER_TOOL_GL=swiftshader fixes blank <canvas> in some SPAs.
      ...(process.env.BROWSER_TOOL_GL === "swiftshader"
        ? { args: ["--use-gl=swiftshader"] }
        : {}),
    };
    browser = await chromium.launch(opts);
  }
  if (!context || context.isClosed()) {
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "en-US",
    });
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
  return page;
}

export function hasPage(): boolean {
  return !!page && !page.isClosed();
}

export async function closeAll(): Promise<void> {
  try {
    if (context && !context.isClosed()) await context.close();
  } catch {
    /* already gone */
  }
  try {
    if (browser && browser.isConnected()) await browser.close();
  } catch {
    /* already gone */
  }
  browser = null;
  context = null;
  page = null;
}

// Fields the twin needs to re-create a cookie; mirrors BridgeCookie in
// bridge.ts (kept structural so the two files stay decoupled).
export interface SyncedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

const VALID_SAMESITE = new Set(["Strict", "Lax", "None"]);

// Inject cookies into the twin's context so an SSO/Kerberos login done in the
// integrated tab carries over. Malformed cookies are dropped; a batch failure
// falls back to per-cookie inserts so one bad cookie can't lose the rest.
export async function addCookies(
  cookies: SyncedCookie[],
): Promise<{ added: number; total: number; errors: string[] }> {
  const pg = await getPage();
  const ctx = pg.context();

  const mapped: Cookie[] = [];
  for (const c of cookies) {
    if (!c || typeof c.name !== "string" || !c.name || typeof c.value !== "string") continue;
    if (typeof c.domain !== "string" || !c.domain) continue;
    const cookie: Cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === "string" && c.path ? c.path : "/",
      expires: 0, // <= 0 means a session cookie
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    if (typeof c.expires === "number" && c.expires > 0) cookie.expires = Math.floor(c.expires);
    if (c.httpOnly) cookie.httpOnly = true;
    if (c.secure) cookie.secure = true;
    if (typeof c.sameSite === "string" && VALID_SAMESITE.has(c.sameSite)) {
      cookie.sameSite = c.sameSite as Cookie["sameSite"];
    }
    mapped.push(cookie);
  }

  let added = 0;
  const errors: string[] = [];
  try {
    if (mapped.length) await ctx.addCookies(mapped);
    added = mapped.length;
  } catch {
    for (const cookie of mapped) {
      try {
        await ctx.addCookies([cookie]);
        added++;
      } catch (err) {
        errors.push(`${cookie.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { added, total: cookies.length, errors };
}
