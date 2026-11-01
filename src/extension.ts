import * as vscode from "vscode";
import * as net from "node:net";
import * as fs from "node:fs";
import { hostPipePath } from "./bridge.js";
import { runDoctor } from "./doctor.js";

// Extension host side of the browser-tab bridge.
//
// The MCP server (a plain Node child process) cannot call the vscode API, so
// when the user enables the `browserTool.browserTab` setting, this extension
// listens on the named pipe and opens/navigates VS Code's integrated browser
// tab on request.
//
// IMPORTANT — proposed API rules: reading `vscode.window.openBrowserTab` is
// harmless, but CALLING it or SUBSCRIBING to the tab events triggers VS Code's
// proposal check. On a stable VS Code build, the manifest's
// `enabledApiProposals` is honored only in extension-development mode; for a
// normally installed extension the user must start VS Code with
// `--enable-proposed-api nuanst-one.vscode-browser-tool` (or the
// `enable-proposed-api` entry in argv.json). Therefore NOTHING proposed is
// touched unless the setting is on, and even then the whole start is wrapped
// so an unavailable proposal degrades to a warning + one-click fix instead of
// crashing activation.

const SETTING = "browserTool.browserTab";
const PROPOSAL_KEY = "enable-proposed-api";

function cookieNames(cookies: unknown[]): string {
  const names = cookies
    .map((c) => {
      if (!c || typeof c !== "object" || !("name" in c)) return "";
      const name = (c as { name?: unknown }).name;
      return typeof name === "string" ? name : "";
    })
    .filter(Boolean);
  return names.length ? names.join(", ") : "none";
}

// document.cookie is "a=b; c=d" for the current document only, with no domain,
// path, or HttpOnly bit. The hostname comes from the tab URL so the twin can
// store them. Values are not logged.
function documentCookies(raw: string, pageUrl: string | undefined): { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }[] {
  let domain = "";
  let secure = false;
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      domain = u.hostname;
      secure = u.protocol === "https:";
    } catch {
      /* unusable url */
    }
  }
  if (!domain) return [];
  const out: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }[] = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim();
    const value = eq < 0 ? "" : trimmed.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain, path: "/", secure, httpOnly: false });
  }
  return out;
}

type OpenTabFn = (url: string, options?: { preserveFocus?: boolean }) => Thenable<vscode.BrowserTab>;

// ---------------------------------------------------------------------------
// Proposal enablement (guided, via VS Code's own argv.json command)
// ---------------------------------------------------------------------------

// We deliberately do NOT locate or rewrite argv.json ourselves — path guessing
// and JSON surgery on a global config file is exactly the kind of thing an
// extension shouldn't do. Instead we use VS Code's built-in
// "Configure Runtime Arguments" command (which knows the right file for any
// build), then — read-only, from the document that command just opened — pick
// the right paste-ready snippet: the whole key if the list is absent, just
// the entry line if other extensions are already listed (so a naive paste can
// never create a duplicate key).
// Command id differs across VS Code builds ("Arguments" vs "Args"); try both.
const OPEN_ARGV_COMMANDS = [
  "workbench.action.configureRuntimeArguments",
  "workbench.action.configureRuntimeArgs",
] as const;

async function enableProposal(extId: string, out: vscode.OutputChannel): Promise<void> {
  let opened = false;
  for (const id of OPEN_ARGV_COMMANDS) {
    try {
      await vscode.commands.executeCommand(id);
      opened = true;
      break;
    } catch {
      /* try the next id */
    }
  }
  if (!opened) {
    out.appendLine("Could not open argv.json via command; asked the user to use the palette.");
  }

  // The document opens asynchronously; give it a moment.
  let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("argv.json"));
  for (let i = 0; i < 20 && !doc; i++) {
    await new Promise((r) => setTimeout(r, 100));
    doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("argv.json"));
  }

  const text = doc?.getText() ?? "";
  let snippet: string;
  let message: string;
  if (text.includes(extId)) {
    snippet = "";
    message = `${extId} is already in ${PROPOSAL_KEY} — nothing to add, just fully restart VS Code.`;
  } else if (new RegExp(`"${PROPOSAL_KEY}"\\s*:`).test(text)) {
    // Other extensions already use the proposal: add our id inside their array.
    snippet = `    "${extId}",`;
    message =
      `argv.json already lists other extensions — add this line INSIDE the existing ` +
      `${PROPOSAL_KEY} array (on your clipboard), and fully restart VS Code:\n${snippet}`;
  } else {
    snippet = `"${PROPOSAL_KEY}": [\n    "${extId}"\n  ]`;
    message = `argv.json is open — merge this (already on your clipboard) and fully restart VS Code:\n${snippet}`;
  }

  if (snippet) {
    try {
      await vscode.env.clipboard.writeText(snippet);
    } catch {
      /* clipboard unavailable; the snippet is shown in the message too */
    }
  }
  if (!opened) {
    message =
      `Couldn't open argv.json automatically — open it from the command palette` +
      ` ("Preferences: Configure Runtime Arguments"), then follow the rest:\n${message}`;
  }
  out.appendLine(`${opened ? "Opened" : "Could not open"} argv.json for ${PROPOSAL_KEY} setup (${extId}).`);
  vscode.window.showInformationMessage(message);
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

class TabBridge {
  private ourTab: vscode.BrowserTab | undefined;
  private cdp: vscode.BrowserCDPSession | undefined;
  private cdpSeq = 1;
  private server: net.Server | null = null;

  constructor(
    private readonly out: vscode.OutputChannel,
    private readonly openTab: OpenTabFn,
    private readonly disposables: vscode.Disposable[],
  ) {
    // Subscribing triggers the proposal check — only called when the setting
    // is on, and inside activate()'s try/catch.
    this.disposables.push(
      (vscode.window as { onDidCloseBrowserTab?: vscode.Event<vscode.BrowserTab> })
        .onDidCloseBrowserTab!((t) => {
          if (t === this.ourTab) {
            this.ourTab = undefined;
            this.closeCdp();
          }
        }),
    );
  }

  private closeCdp(): void {
    if (!this.cdp) return;
    const session = this.cdp;
    this.cdp = undefined;
    Promise.resolve(session.close()).catch(() => undefined);
  }

  // One tab at a time. Prefer steering the existing tab via CDP (Page.navigate)
  // so the user's view doesn't flicker; fall back to close + reopen.
  async handle(url: string): Promise<void> {
    if (this.ourTab && this.cdp) {
      try {
        await this.cdp.sendMessage({ id: this.cdpSeq++, method: "Page.navigate", params: { url } });
        return;
      } catch {
        this.closeCdp();
      }
    }
    if (this.ourTab) {
      const old = this.ourTab;
      this.ourTab = undefined;
      await Promise.resolve(old.close()).catch(() => undefined);
    }
    const tab = await this.openTab(url, { preserveFocus: true });
    this.ourTab = tab;
    this.out.appendLine(`Opened browser tab: ${tab.url}`);
    if (typeof tab.startCDPSession === "function") {
      try {
        const session = await tab.startCDPSession();
        this.cdp = session;
        this.disposables.push(session.onDidClose(() => (this.cdp = undefined)));
        this.out.appendLine("CDP session attached; subsequent navigates reuse the tab.");
      } catch (e) {
        this.cdp = undefined;
        this.out.appendLine(
          `CDP session unavailable (will reopen the tab on navigate): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  // Correlate a CDP command with its async response. sendMessage() resolves
  // when the message is *sent*, not answered — the result arrives on
  // onDidReceiveMessage, so we subscribe first, then send, then wait for the
  // message whose `id` matches. Non-matching messages (CDP events, other
  // commands' responses) are ignored.
  private cdpRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<T> {
    const session = this.cdp;
    if (!session) return Promise.reject(new Error("no CDP session attached to the integrated tab"));
    const id = this.cdpSeq++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const dispose = session.onDidReceiveMessage((msg) => {
        const m = msg as { id?: number; result?: T; error?: { message?: string } };
        if (!m || typeof m.id !== "number" || m.id !== id) return;
        if (settled) return;
        settled = true;
        dispose.dispose();
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message ?? "CDP command failed"));
        else resolve(m.result as T);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        dispose.dispose();
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // sendMessage returns a Thenable (no .catch) — wrap to reject on send failure.
      Promise.resolve(session.sendMessage({ id, method, params })).catch((e: unknown) => {
        if (settled) return;
        settled = true;
        dispose.dispose();
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // Pull cookies the integrated tab can see. WebView2 (the Windows integrated
  // browser) does not implement Storage.getCookies — that is the "Method not
  // found" line. Network.getCookies is the method that usually exists; it
  // needs the page URL. document.cookie is the last resort and cannot see
  // HttpOnly cookies, which is what an SSO session cookie usually is.
  private async fetchCookies(): Promise<unknown[]> {
    const url = this.ourTab?.url;
    await this.cdpRequest("Network.enable", {}, 2000).catch(() => undefined);

    const attempts: { method: string; params: Record<string, unknown> }[] = [
      { method: "Network.getCookies", params: url ? { urls: [url] } : {} },
      { method: "Network.getAllCookies", params: {} },
      { method: "Storage.getCookies", params: {} },
    ];
    let best: unknown[] | null = null;
    let bestMethod = "";
    for (const attempt of attempts) {
      this.out.appendLine(`Cookie read: ${attempt.method}`);
      try {
        const result = await this.cdpRequest<{ cookies?: unknown[] }>(attempt.method, attempt.params);
        const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
        this.out.appendLine(`Cookie read: ${attempt.method} returned ${cookies.length} (${cookieNames(cookies)})`);
        if (best === null || cookies.length > best.length) {
          best = cookies;
          bestMethod = attempt.method;
        }
        if (cookies.length > 0) break;
      } catch (e) {
        this.out.appendLine(
          `Cookie read: ${attempt.method} failed (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    if (best && best.length > 0) {
      this.out.appendLine(`Cookie read: using ${best.length} from ${bestMethod}.`);
      return best;
    }

    this.out.appendLine("Cookie read: CDP returned none. Trying document.cookie (HttpOnly cookies are invisible).");
    try {
      const result = await this.cdpRequest<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "document.cookie",
        returnByValue: true,
      });
      const raw = typeof result?.result?.value === "string" ? result.result.value : "";
      const cookies = documentCookies(raw, url);
      this.out.appendLine(
        `Cookie read: document.cookie returned ${cookies.length} (${cookieNames(cookies)}). HttpOnly SSO cookies are not included.`,
      );
      if (cookies.length > 0 || best) return cookies.length > 0 ? cookies : best!;
    } catch (e) {
      this.out.appendLine(
        `Cookie read: document.cookie failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (best) return best;
    throw new Error("no cookie API answered (Storage.getCookies and Network.getCookies are missing, and document.cookie failed)");
  }

  start(): void {
    if (this.server) return;
    // This window's extension host serves this window's MCP server (which finds
    // us by walking up to this PID), so the pipe is named per our own PID —
    // one per window, no cross-window EADDRINUSE.
    const p = hostPipePath(process.pid);
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(p); // stale socket from a crashed VS Code
      } catch {
        /* absent */
      }
    }
    this.server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: { url?: unknown; action?: unknown; method?: unknown; params?: unknown };
        try {
          req = JSON.parse(line);
        } catch {
          this.reply(sock, false, "invalid JSON");
          return;
        }
        if (req.action === "status") {
          this.replyRaw(sock, {
            ok: true,
            present: !!this.ourTab,
            cdp: !!this.cdp,
            url: this.ourTab?.url,
          });
          return;
        }
        if (req.action === "cdp") {
          const method = typeof req.method === "string" ? req.method : "";
          if (!method) {
            this.replyRaw(sock, { ok: false, error: "cdp action missing method" });
            return;
          }
          const params =
            req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
          // Generous timeout: screenshots and heavy evaluates can take a while.
          this.cdpRequest(method, params, 30_000)
            .then((result) => this.replyRaw(sock, { ok: true, result }))
            .catch((e) => this.replyRaw(sock, { ok: false, error: e instanceof Error ? e.message : String(e) }));
          return;
        }
        if (req.action === "getCookies") {
          this.fetchCookies()
            .then((cookies) => {
              this.out.appendLine(`Cookie sync: handing ${cookies.length} cookie(s) to the headless twin.`);
              this.replyRaw(sock, { ok: true, cookies });
            })
            .catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              this.out.appendLine(`Cookie sync failed: ${msg}`);
              this.replyRaw(sock, { ok: false, error: msg });
            });
          return;
        }
        if (typeof req.url !== "string" || !req.url) {
          this.reply(sock, false, "missing url");
          return;
        }
        this.handle(req.url)
          .then(() => this.reply(sock, true))
          .catch((e) => this.reply(sock, false, e instanceof Error ? e.message : String(e)));
      });
      sock.on("error", () => undefined);
    });
    this.server.on("error", (e) => {
      this.out.appendLine(`Bridge listen error: ${e.message}`);
      this.server = null;
    });
    this.server.listen(p, () => this.out.appendLine(`Browser-tab bridge listening on ${p}`));
  }

  private reply(sock: net.Socket, ok: boolean, error?: string): void {
    this.replyRaw(sock, ok ? { ok } : { ok, error });
  }

  private replyRaw(sock: net.Socket, obj: unknown): void {
    try {
      sock.end(JSON.stringify(obj) + "\n");
    } catch {
      /* client gone */
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.closeCdp();
    if (this.ourTab) {
      const old = this.ourTab;
      this.ourTab = undefined;
      Promise.resolve(old.close()).catch(() => undefined);
    }
    this.out.appendLine("Browser-tab bridge stopped.");
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Browser Tool");
  const disposables: vscode.Disposable[] = [];
  const extId = context.extension.id;

  // Reading the proposed member is safe; the check happens on call. If it is
  // missing entirely (older/changed VS Code) we simply never start the bridge.
  const openTab = (vscode.window as { openBrowserTab?: OpenTabFn }).openBrowserTab;

  let bridge: TabBridge | null = null;

  const enable = (): Thenable<void> => enableProposal(extId, out);
  disposables.push(vscode.commands.registerCommand("browserTool.enableBrowserTabApi", enable));
  disposables.push(
    vscode.commands.registerCommand("browserTool.doctor", async () => {
      out.show(true);
      out.appendLine("");
      out.appendLine("-------- /doctor --------");
      const report = await runDoctor({
        extensionId: extId,
        extensionVersion: context.extension.packageJSON.version ?? "",
        extensionPath: context.extensionPath,
        vscodeVersion: vscode.version,
        appName: vscode.env.appName,
        browserTab: vscode.workspace.getConfiguration().get<boolean>(SETTING, false),
        proposedApiPresent: typeof openTab === "function",
        hostPid: process.pid,
        pipePath: hostPipePath(process.pid),
        workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      });
      for (const line of report.lines) out.appendLine(line);
      out.appendLine("-------- /doctor done --------");
      const show = report.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void show(report.summary);
    }),
  );

  out.appendLine(
    `Browser Tool ${context.extension.packageJSON.version ?? ""} active (extension host pid ${process.pid}).`,
  );
  out.appendLine(
    'The listening pipe is only the live browser tab. Run "Browser Tool: /doctor" to test the MCP server Claude connects to.',
  );

  const update = (): void => {
    const enabled = vscode.workspace.getConfiguration().get<boolean>(SETTING, false);
    if (enabled && typeof openTab === "function" && !bridge) {
      try {
        bridge = new TabBridge(out, openTab, disposables);
        bridge.start();
      } catch (e) {
        bridge = null;
        out.appendLine(`Browser-tab integration unavailable: ${e instanceof Error ? e.message : String(e)}`);
        const action = "Add to argv.json";
        void vscode.window
          .showWarningMessage(
            `Browser-tab integration needs the 'browser' API proposal enabled for ${extId}.`,
            action,
          )
          .then((r) => {
            if (r === action) void enable();
          });
      }
    } else if (!enabled && bridge) {
      bridge.stop();
      bridge = null;
    }
  };

  context.subscriptions.push(
    out,
    ...disposables,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("browserTool")) update();
    }),
  );
  update();
}
