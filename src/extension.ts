import * as vscode from "vscode";
import * as net from "node:net";
import * as fs from "node:fs";
import { hostPipePath } from "./bridge.js";

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

  // Pull all cookies the integrated tab's context holds. Prefer
  // Storage.getCookies (all cookies, no urls needed); fall back to
  // Network.getCookies if that domain is unavailable in this WebView2.
  private async fetchCookies(): Promise<unknown> {
    try {
      const result = await this.cdpRequest<{ cookies: unknown[] }>("Storage.getCookies");
      return result?.cookies ?? [];
    } catch (e) {
      this.out.appendLine(
        `Storage.getCookies failed (${e instanceof Error ? e.message : String(e)}); trying Network.getCookies`,
      );
      const result = await this.cdpRequest<{ cookies: unknown[] }>("Network.getCookies");
      return result?.cookies ?? [];
    }
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
            .then((cookies) => this.replyRaw(sock, { ok: true, cookies }))
            .catch((e) => this.replyRaw(sock, { ok: false, error: e instanceof Error ? e.message : String(e) }));
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
