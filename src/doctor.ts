import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// The "Browser Tool" output channel only ever described the named-pipe bridge
// inside the extension host. Claude does not connect to that pipe. It connects
// to a separate `node dist/server.js` process that VS Code starts from
// contributes.mcp. /doctor starts that process the same way and reports what
// the client would see.

const MIN_NODE = [20, 0, 0] as const;
const MIN_VSCODE = [1, 104, 0] as const;
const MCP_PROTOCOL = "2025-03-26";

export interface DoctorInput {
  extensionId: string;
  extensionVersion: string;
  extensionPath: string;
  vscodeVersion: string;
  appName: string;
  browserTab: boolean;
  proposedApiPresent: boolean;
  hostPid: number;
  pipePath: string;
  workspaceFolders: string[];
}

export interface DoctorResult {
  lines: string[];
  ok: boolean;
  summary: string;
}

interface Check {
  ok: boolean;
  lines: string[];
}

export async function runDoctor(input: DoctorInput): Promise<DoctorResult> {
  const lines: string[] = [];
  const fail = (text: string): void => {
    lines.push(`FAIL  ${text}`);
  };
  const pass = (text: string): void => {
    lines.push(`ok    ${text}`);
  };
  const note = (text: string): void => {
    lines.push(`      ${text}`);
  };

  lines.push(`Browser Tool /doctor  ${new Date().toISOString()}`);
  lines.push(`${input.appName} ${input.vscodeVersion}  ${os.platform()} ${os.arch()}`);
  lines.push(`${input.extensionId} ${input.extensionVersion}`);
  lines.push(`extensionPath: ${input.extensionPath}`);
  lines.push(`extension host pid ${input.hostPid}  (this is not the MCP server)`);
  lines.push("");
  lines.push("The line \"Browser-tab bridge listening on <pipe>\" only means the");
  lines.push("live-view pipe is up. Claude's tools talk to a different process:");
  lines.push(`  node ${serverScript(input)}`);
  lines.push("");

  const script = serverScript(input);
  const scriptOk = checkServerFile(script);
  if (scriptOk.ok) pass(scriptOk.lines[0]);
  else for (const line of scriptOk.lines) fail(line);

  const vscodeOk = cmpVersion(input.vscodeVersion, MIN_VSCODE) >= 0;
  if (vscodeOk) pass(`VS Code ${input.vscodeVersion} has the mcp contribution point (>= 1.104)`);
  else {
    fail(`VS Code ${input.vscodeVersion} is older than 1.104, so contributes.mcp is ignored`);
    note("Claude will not see browser-tool unless it is added to Claude's own MCP config.");
  }

  const node = await checkNode(input.extensionPath);
  if (node.ok) pass(node.lines[0]);
  else {
    fail(node.lines[0]);
    for (const line of node.lines.slice(1)) note(line);
  }

  let handshakeOk = false;
  let toolCount = 0;
  if (scriptOk.ok && node.ok) {
    const handshake = await probeMcp(node.execPath, script, input.extensionPath);
    handshakeOk = handshake.ok;
    toolCount = handshake.toolCount;
    if (handshake.ok) {
      pass(`MCP handshake listed ${handshake.toolCount} tools: ${handshake.toolNames.join(", ")}`);
    } else {
      fail(`MCP server did not complete initialize + tools/list: ${handshake.error}`);
    }
    if (handshake.stderr.trim()) {
      note("server stderr:");
      for (const line of clip(handshake.stderr, 30)) note(line);
    }
  } else {
    fail("skipped the MCP handshake because node or dist/server.js is missing");
  }

  const playwright = node.ok ? await checkPlaywright(node.execPath, input.extensionPath) : null;
  if (!playwright) {
    note("skipped the Playwright check because node did not start");
  } else if (playwright.moduleOk && playwright.browserExists) {
    pass(`Playwright browser present: ${playwright.executable}`);
  } else if (playwright.moduleOk) {
    lines.push(`WARN  Playwright module loads, but its browser is not installed`);
    note(playwright.executable || playwright.error || "executable path missing");
    note("Headless fallback will fail until `npx playwright install chromium`, or set BROWSER_TOOL_CHANNEL.");
    note("Tool listing does not need the browser. A missing browser is not why //tools cannot connect.");
  } else {
    lines.push(`WARN  Playwright module did not load: ${playwright.error}`);
    note("The server can still list tools. open_url via the headless twin will fail until Playwright is installed next to the extension.");
  }

  const pipe = await probePipe(input.pipePath);
  if (!input.browserTab) {
    note("browserTool.browserTab is off, so no pipe is expected. That does not hide the MCP tools.");
  } else if (pipe.ok) {
    pass(`browser-tab pipe answered on ${input.pipePath} (${pipe.detail})`);
  } else {
    lines.push(`WARN  browserTool.browserTab is on, but the pipe did not answer: ${pipe.detail}`);
    note(input.pipePath);
  }
  if (input.browserTab && !input.proposedApiPresent) {
    lines.push("WARN  browserTool.browserTab is on, but vscode.window.openBrowserTab is missing");
    note("The live tab needs the proposed browser API. The MCP tools do not.");
  } else if (input.proposedApiPresent) {
    pass("vscode.window.openBrowserTab is present");
  } else {
    note("proposed browser API is not present. Live view stays off. MCP tools do not need it.");
  }

  lines.push("");
  lines.push("Client config (Claude connects only to servers listed for that client):");
  const configs = findClientConfigs(input);
  if (configs.length === 0) {
    note("no Claude or VS Code mcp.json found. VS Code can still start the contributed server on its own.");
    note("Claude Code does not use contributes.mcp unless that client is set to consume VS Code MCP servers.");
  } else {
    for (const cfg of configs) {
      if (cfg.error) {
        note(`${cfg.file}: ${cfg.error}`);
        continue;
      }
      if (cfg.matches.length === 0) {
        note(`${cfg.file}: no server entry points at this extension (${cfg.serverCount} other server(s))`);
      } else {
        pass(`${cfg.file} references this server: ${cfg.matches.join("; ")}`);
      }
    }
  }

  lines.push("");
  let summary: string;
  let ok: boolean;
  if (!scriptOk.ok || !node.ok || !handshakeOk) {
    ok = false;
    summary = `Browser Tool /doctor: MCP server is not connectable (${toolCount} tools). See the Browser Tool output.`;
    lines.push("Verdict: the MCP process Claude's //tools command connects to is not staying up.");
    lines.push("The listening pipe is unrelated. Fix the FAIL lines above, then run /doctor again.");
  } else if (!vscodeOk) {
    ok = false;
    summary = "Browser Tool /doctor: this editor is too old to launch the contributed MCP server.";
  } else {
    ok = true;
    summary = `Browser Tool /doctor: MCP server listed ${toolCount} tools. If Claude still cannot connect, it is not launching that process.`;
    lines.push(`Verdict: node ${serverScript(input)} starts and lists tools.`);
    lines.push("If Claude still says the tools are unavailable, Claude is not launching that command.");
    lines.push("VS Code's own agent uses the extension's mcp contribution. Claude Code uses its own");
    lines.push("MCP list unless it is configured to use the editor's MCP servers.");
  }

  return { lines, ok, summary };
}

function serverScript(input: DoctorInput): string {
  return path.join(input.extensionPath, "dist", "server.js");
}

function checkServerFile(script: string): Check {
  try {
    const stat = fs.statSync(script);
    if (!stat.isFile() || stat.size === 0) return { ok: false, lines: [`dist/server.js is missing or empty (${script})`] };
    return { ok: true, lines: [`dist/server.js (${stat.size} bytes)`] };
  } catch {
    return { ok: false, lines: [`dist/server.js is not in the installed extension (${script})`] };
  }
}

interface NodeCheck extends Check {
  execPath: string;
}

async function checkNode(cwd: string): Promise<NodeCheck> {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  let result: RunResult;
  try {
    result = await run(
      "node",
      ["-e", "process.stdout.write(process.version + \"\\n\" + process.execPath)"],
      cwd,
      5000,
    );
  } catch (err) {
    return {
      ok: false,
      execPath: "",
      lines: [
        `node is not on PATH, so VS Code cannot start the MCP server (command: "node")`,
        `PATH=${pathEnv || "(empty)"}`,
        err instanceof Error ? err.message : String(err),
      ],
    };
  }
  if (result.error && !result.stdout.trim()) {
    const missing = /ENOENT/i.test(result.error);
    return {
      ok: false,
      execPath: "",
      lines: [
        missing
          ? `node is not on PATH, so the editor cannot start the MCP server (command: "node")`
          : `node did not start: ${result.error}`,
        `PATH=${pathEnv || "(empty)"}`,
        result.stderr.trim(),
      ].filter(Boolean),
    };
  }
  const [version = "", execPath = ""] = result.stdout.trim().split("\n");
  const parsed = parseVersion(version.replace(/^v/, ""));
  if (!parsed || cmpVersion(parsed.join("."), MIN_NODE) < 0) {
    return {
      ok: false,
      execPath,
      lines: [`node ${version || "unknown"} is older than v20 (${execPath})`],
    };
  }
  return { ok: true, execPath, lines: [`node ${version} (${execPath})`] };
}

interface PlaywrightCheck {
  moduleOk: boolean;
  browserExists: boolean;
  executable: string;
  error: string;
}

async function checkPlaywright(nodePath: string, cwd: string): Promise<PlaywrightCheck> {
  const code = [
    "try {",
    "  const { chromium } = require('playwright');",
    "  const p = chromium.executablePath();",
    "  const fs = require('fs');",
    "  process.stdout.write(JSON.stringify({ moduleOk: true, executable: p, browserExists: fs.existsSync(p) }));",
    "} catch (e) {",
    "  process.stdout.write(JSON.stringify({ moduleOk: false, error: e && e.message ? e.message : String(e) }));",
    "}",
  ].join("");
  try {
    const result = await run(nodePath, ["-e", code], cwd, 15000);
    const parsed = JSON.parse(result.stdout || "{}") as {
      moduleOk?: boolean;
      executable?: string;
      browserExists?: boolean;
      error?: string;
    };
    return {
      moduleOk: !!parsed.moduleOk,
      browserExists: !!parsed.browserExists,
      executable: parsed.executable ?? "",
      error: parsed.error || result.stderr.trim() || result.error || "",
    };
  } catch (err) {
    return {
      moduleOk: false,
      browserExists: false,
      executable: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Handshake {
  ok: boolean;
  toolCount: number;
  toolNames: string[];
  error: string;
  stderr: string;
}

async function probeMcp(nodePath: string, script: string, cwd: string): Promise<Handshake> {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stderr = "";
    let buf = "";
    let settled = false;
    let listed = false;
    const finish = (result: Handshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, stderr });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        toolCount: 0,
        toolNames: [],
        error: listed ? "tools/list did not return" : "timed out waiting for initialize",
        stderr,
      });
    }, 8000);

    child.on("error", (err) => {
      finish({ ok: false, toolCount: 0, toolNames: [], error: err.message, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      finish({
        ok: false,
        toolCount: 0,
        toolNames: [],
        error: `process exited (${code ?? "signal"}) before tools/list`,
        stderr,
      });
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.error && !listed) {
          const err = msg.error as { message?: string };
          finish({
            ok: false,
            toolCount: 0,
            toolNames: [],
            error: err.message ?? "initialize failed",
            stderr,
          });
          return;
        }
        if (msg.id === 1 && msg.result && !listed) {
          listed = true;
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2) {
          if (msg.error) {
            const err = msg.error as { message?: string };
            finish({ ok: false, toolCount: 0, toolNames: [], error: err.message ?? "tools/list failed", stderr });
            return;
          }
          const tools = ((msg.result as { tools?: { name?: string }[] } | undefined)?.tools ?? []).map(
            (t) => t.name ?? "?",
          );
          finish({ ok: true, toolCount: tools.length, toolNames: tools, error: "", stderr });
        }
      }
    });

    function write(msg: unknown): void {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "browser-tool-doctor", version: "0.3.2" },
      },
    });
  });
}

async function probePipe(pipePath: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect(pipePath);
    const timer = setTimeout(() => done(false, "timed out"), 2000);
    const done = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve({ ok, detail });
    };
    sock.on("connect", () => sock.write(JSON.stringify({ action: "status" }) + "\n"));
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as {
          ok?: boolean;
          present?: boolean;
          cdp?: boolean;
          url?: string;
          error?: string;
        };
        if (!msg.ok) done(false, msg.error ?? "status not ok");
        else done(true, `tab ${msg.present ? "open" : "closed"}, cdp ${msg.cdp ? "on" : "off"}${msg.url ? `, ${msg.url}` : ""}`);
      } catch {
        done(false, "invalid JSON from the pipe");
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
    sock.on("close", () => done(false, "connection closed before a reply"));
  });
}

interface ClientConfig {
  file: string;
  error?: string;
  serverCount: number;
  matches: string[];
}

function findClientConfigs(input: DoctorInput): ClientConfig[] {
  const files = new Set<string>();
  const home = os.homedir();
  for (const rel of [".claude.json", path.join(".claude", "settings.json"), path.join(".claude", "mcp.json")]) {
    files.add(path.join(home, rel));
  }
  for (const folder of userDataDirs(input.appName)) {
    files.add(path.join(folder, "User", "mcp.json"));
  }
  for (const root of input.workspaceFolders) {
    files.add(path.join(root, ".vscode", "mcp.json"));
    files.add(path.join(root, ".mcp.json"));
  }

  const found: ClientConfig[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    found.push(readClientConfig(file, input.extensionPath));
  }
  return found;
}

function userDataDirs(appName: string): string[] {
  const names = new Set<string>(["Code", "Code - Insiders", "Cursor", "VSCodium"]);
  if (/cursor/i.test(appName)) names.add("Cursor");
  if (/insider/i.test(appName)) names.add("Code - Insiders");
  if (/codium/i.test(appName)) names.add("VSCodium");
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [...names].map((n) => path.join(home, "Library", "Application Support", n));
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [...names].map((n) => path.join(base, n));
  }
  return [...names].map((n) => path.join(home, ".config", n));
}

function readClientConfig(file: string, extensionPath: string): ClientConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return {
      file,
      error: err instanceof Error ? err.message : String(err),
      serverCount: 0,
      matches: [],
    };
  }
  const servers = extractServers(parsed);
  const needle = extensionPath.replace(/\\/g, "/").toLowerCase();
  const matches: string[] = [];
  for (const server of servers) {
    const blob = `${server.name} ${server.command} ${server.args.join(" ")}`.replace(/\\/g, "/").toLowerCase();
    if (server.name === "browser-tool" || blob.includes(needle) || blob.includes("vscode-browser-tool")) {
      const args = server.args.length ? ` ${server.args.join(" ")}` : "";
      matches.push(`${server.name}: ${server.command}${args}`);
    }
  }
  return { file, serverCount: servers.length, matches };
}

interface ServerEntry {
  name: string;
  command: string;
  args: string[];
}

function extractServers(parsed: unknown): ServerEntry[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const bags = [root.mcpServers, root.servers, (root.mcp as Record<string, unknown> | undefined)?.servers];
  const out: ServerEntry[] = [];
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const [name, value] of Object.entries(bag as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : [];
      out.push({ name, command: typeof rec.command === "string" ? rec.command : "", args });
    }
  }
  return out;
}

interface RunResult {
  stdout: string;
  stderr: string;
  error?: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ stdout, stderr, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => done({ stdout, stderr, error: err.message }));
    child.on("exit", () => done({ stdout, stderr }));
  });
}

type Json = { id?: number; result?: unknown; error?: unknown };

function clip(text: string, maxLines: number): string[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

function parseVersion(v: string): [number, number, number] | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(v: string, min: readonly [number, number, number]): number {
  const parsed = parseVersion(v);
  if (!parsed) return -1;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== min[i]) return parsed[i] - min[i];
  }
  return 0;
}
