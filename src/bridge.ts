import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Pipe naming (per-window)
// ---------------------------------------------------------------------------
// Every VS Code window has its own extension host AND its own MCP server
// process. A single fixed pipe name lets only the first window bind it (later
// windows fail with EADDRINUSE) and would route every window's traffic to the
// first window's tab. So the pipe is named per owning extension host (its PID).
//
//   extension host  -> listens on hostPipePath(process.pid)
//   MCP server      -> discovers its own window's extension host by walking its
//                      process ancestry to the nearest VS Code (Code.exe)
//                      ancestor, then uses hostPipePath(that pid)
//
// Both compute the same path, so each window's MCP server reaches its own
// window's tab. If the MCP server can't resolve an owning host (e.g. run
// standalone via `npm run mcp`), the bridge is unavailable and the tools fall
// back to the headless twin — it can never target the wrong window, because
// ancestry only walks up within its own window's process subtree.

export function hostPipePath(hostPid: number): string {
  const name = "vscode-browser-tool-" + hostPid;
  return os.platform() === "win32"
    ? "\\\\.\\pipe\\" + name
    : path.join(os.tmpdir(), name + ".sock");
}

// ---------------------------------------------------------------------------
// Owning extension-host discovery (MCP server side)
// ---------------------------------------------------------------------------

interface ProcRow {
  ppid: number;
  name: string;
}

let procTablePromise: Promise<Map<number, ProcRow>> | null = null;

// One OS call that yields a {pid -> {ppid, name}} map. Empty on failure, which
// makes host resolution yield null (graceful degrade, never a wrong target).
function fetchProcTable(): Promise<Map<number, ProcRow>> {
  if (!procTablePromise) {
    procTablePromise = new Promise((resolve) => {
      const map = new Map<number, ProcRow>();
      const finish = (err: Error | null, stdout: string): void => {
        if (!err) parseProcTable(stdout, map);
        resolve(map);
      };
      if (os.platform() === "win32") {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object -Property ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
          ],
          { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
          finish,
        );
      } else {
        execFile("ps", ["-eo", "pid=,ppid=,comm="], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, finish);
      }
    });
  }
  return procTablePromise;
}

function parseProcTable(stdout: string, map: Map<number, ProcRow>): void {
  if (os.platform() === "win32") {
    let arr: { ProcessId?: number; ParentProcessId?: number; Name?: string }[];
    try {
      arr = JSON.parse(stdout);
    } catch {
      return;
    }
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (typeof r.ProcessId === "number") {
        map.set(r.ProcessId, { ppid: r.ParentProcessId ?? 0, name: r.Name ?? "" });
      }
    }
  } else {
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      map.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), name: m[3] });
    }
  }
}

function isVsCodeProc(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return base === "code" || base === "code.exe" || base.includes("code");
}

// The VS Code extension host that owns this MCP server's window: the nearest
// ancestor whose executable is the VS Code binary. Computed once and cached.
let hostPidPromise: Promise<number | null> | null = null;
function getOwningHostPid(): Promise<number | null> {
  if (!hostPidPromise) {
    hostPidPromise = (async () => {
      const table = await fetchProcTable();
      let pid = table.get(process.pid)?.ppid ?? 0;
      const seen = new Set<number>();
      for (let i = 0; i < 32 && pid > 1 && !seen.has(pid); i++) {
        seen.add(pid);
        const row = table.get(pid);
        if (!row) break;
        if (isVsCodeProc(row.name)) return pid;
        pid = row.ppid;
      }
      return null;
    })();
  }
  return hostPidPromise;
}

let bridgePipePathPromise: Promise<string | null> | null = null;
function getBridgePipePath(): Promise<string | null> {
  if (!bridgePipePathPromise) {
    bridgePipePathPromise = getOwningHostPid().then((pid) => (pid ? hostPipePath(pid) : null));
  }
  return bridgePipePathPromise;
}

const NO_HOST = "no owning browser-tab host (run inside a VS Code window with the extension installed)";

// ---------------------------------------------------------------------------
// Pipe round-trips
// ---------------------------------------------------------------------------

// Connect to the pipe, write one JSON payload line, resolve with the next
// (single) JSON response line. Rejects on timeout, connect failure, or the
// connection closing before a reply.
function pipeLine(pipePath: string, payload: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sock: net.Socket;
    let buf = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      reject(new Error("timed out talking to the browser-tab bridge"));
    }, timeoutMs);
    sock = net.connect(pipePath);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        sock.end();
      } catch {
        /* already gone */
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(line);
    });
    sock.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (["ECONNREFUSED", "ENOENT"].includes(code)) {
        reject(new Error("browser-tab bridge not reachable (is browserTool.browserTab enabled and VS Code running?)"));
      } else {
        reject(err);
      }
    });
    sock.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("connection closed before a reply"));
    });
  });
}

// Fire-and-forget: open/mirror the integrated tab at a URL. Never rejects;
// failures (no owning host, VS Code not running, setting disabled) only surface
// on stderr — the headless twin does the real work regardless.
export function requestBrowserTab(url: string, timeoutMs = 4000): Promise<void> {
  return getBridgePipePath().then((p) => {
    if (!p) return;
    return new Promise<void>((resolve) => {
      let settled = false;
      let sock: net.Socket;
      const finish = (err?: NodeJS.ErrnoException): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err && !["ECONNREFUSED", "ENOENT", "EPIPE"].includes(err.code ?? "")) {
          process.stderr.write(`[browser-tool] browser-tab bridge: ${err.message}\n`);
        }
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          /* already gone */
        }
        finish(new Error("timed out"));
      }, timeoutMs);
      sock = net.connect(p);
      sock.on("connect", () => sock.write(JSON.stringify({ url }) + "\n"));
      sock.on("data", () => {
        try {
          sock.end();
        } catch {
          /* already gone */
        }
        finish();
      });
      sock.on("error", (err) => finish(err));
      sock.on("close", () => finish());
    });
  });
}

// A cookie as CDP (Storage.getCookies / Network.getCookies) returns it. Only
// the fields the Playwright twin needs are typed; `size` is unused downstream.
export interface BridgeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export type CookieResponse = { ok: true; cookies: BridgeCookie[] } | { ok: false; error: string };

// Ask the extension host for the integrated tab's cookies (it reads them via
// its live CDP session) and get them back.
export function requestCookies(timeoutMs = 8000): Promise<CookieResponse> {
  return getBridgePipePath().then(
    (p) =>
      p
        ? pipeLine(p, { action: "getCookies" }, timeoutMs).then(
            (line) => {
              let parsed: { ok?: boolean; cookies?: BridgeCookie[]; error?: string };
              try {
                parsed = JSON.parse(line);
              } catch {
                return { ok: false, error: "invalid JSON from the cookie bridge" } as CookieResponse;
              }
              if (parsed && parsed.ok && Array.isArray(parsed.cookies)) {
                return { ok: true, cookies: parsed.cookies };
              }
              return { ok: false, error: parsed?.error ?? "cookie bridge returned no cookies" };
            },
            (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as CookieResponse,
          )
        : Promise.resolve({ ok: false, error: NO_HOST } as CookieResponse),
  );
}

export type TabStatusResponse =
  | { ok: true; present: boolean; cdp: boolean; url?: string }
  | { ok: false; error: string };

// Ask the extension host whether the integrated tab is present and its CDP
// session is alive — the gate for using the tab as the primary engine.
export function probeTabStatus(timeoutMs = 2000): Promise<TabStatusResponse> {
  return getBridgePipePath().then(
    (p) =>
      p
        ? pipeLine(p, { action: "status" }, timeoutMs).then(
            (line) => {
              let parsed: { ok?: boolean; present?: boolean; cdp?: boolean; url?: string; error?: string };
              try {
                parsed = JSON.parse(line);
              } catch {
                return { ok: false, error: "invalid JSON from the status probe" } as TabStatusResponse;
              }
              if (parsed && parsed.ok && typeof parsed.present === "boolean") {
                return { ok: true, present: parsed.present, cdp: !!parsed.cdp, url: parsed.url };
              }
              return { ok: false, error: parsed?.error ?? "status probe returned no status" };
            },
            (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as TabStatusResponse,
          )
        : Promise.resolve({ ok: false, error: NO_HOST } as TabStatusResponse),
  );
}

export type CdpResponse = { ok: true; result: unknown } | { ok: false; error: string };

// Generic CDP passthrough: forward a CDP command to the integrated tab's
// session and return its result (or the CDP/bridge error).
export function cdpSend(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<CdpResponse> {
  return getBridgePipePath().then(
    (p) =>
      p
        ? pipeLine(p, { action: "cdp", method, params }, timeoutMs).then(
            (line) => {
              let parsed: { ok?: boolean; result?: unknown; error?: string };
              try {
                parsed = JSON.parse(line);
              } catch {
                return { ok: false, error: "invalid JSON from the CDP bridge" } as CdpResponse;
              }
              if (parsed && parsed.ok) return { ok: true, result: parsed.result };
              return { ok: false, error: parsed?.error ?? "CDP bridge returned an error" };
            },
            (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as CdpResponse,
          )
        : Promise.resolve({ ok: false, error: NO_HOST } as CdpResponse),
  );
}
