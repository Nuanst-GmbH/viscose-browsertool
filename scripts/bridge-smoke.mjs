// Smoke test for the browser-tab bridge (client half): starts a fake pipe
// server at the bridge path, drives the built MCP server over stdio, and
// checks that open_url sends the URL across the pipe.
// Usage: node scripts/bridge-smoke.mjs
// (run `npm run testpage` in another terminal first, like the e2e test)
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const pipe =
  os.platform() === "win32"
    ? "\\\\.\\pipe\\vscode-browser-tool"
    : path.join(os.tmpdir(), "vscode-browser-tool.sock");

// --- fake bridge (stands in for the extension host) ------------------------
const received = [];
const fake = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    received.push(JSON.parse(buf.slice(0, nl)));
    buf = buf.slice(nl + 1);
    sock.end(JSON.stringify({ ok: true }) + "\n");
  });
});
await new Promise((res, rej) => {
  fake.once("error", rej);
  fake.listen(pipe, res);
});

// --- MCP server over stdio (same harness as e2e.mjs) ------------------------
const child = spawn(
  process.execPath,
  [path.join(root, "dist", "server.js")],
  { cwd: root, env: { ...process.env, BROWSER_TOOL_CHANNEL: "msedge" }, stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  const p = new Promise((res) => pending.set(id, res));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
// the server normalizes URLs via new URL().href (adds a trailing slash)
const normalized = new URL("http://127.0.0.1:8765").href;

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bridge-smoke", version: "0.1.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const r = await rpc("tools/call", { name: "open_url", arguments: { url: "http://127.0.0.1:8765" } });
  const text = (r.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("open_url loads test page", !r.result?.isError && text.includes("127.0.0.1:8765"));
  check(
    "bridge received the URL",
    received.length === 1 && received[0].url === normalized,
    JSON.stringify(received),
  );

  const r2 = await rpc("tools/call", { name: "navigate", arguments: { url: "http://127.0.0.1:8765" } });
  check("navigate ok", !r2.result?.isError);
  check(
    "bridge received the second URL",
    received.length === 2 && received[1].url === normalized,
    JSON.stringify(received),
  );

  await rpc("tools/call", { name: "close", arguments: {} });
} finally {
  child.kill();
  fake.close();
}
console.log(failures === 0 ? "\nBRIDGE SMOKE: ALL PASSED" : `\nBRIDGE SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
