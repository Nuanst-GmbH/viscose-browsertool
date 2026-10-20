// End-to-end check: drives the built MCP server over stdio (raw JSON-RPC)
// against the local test page (npm run testpage, http://127.0.0.1:8765).
// Usage: node scripts/e2e.mjs
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

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
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const content = r.result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const image = content.find((c) => c.type === "image");
  console.log(`--- ${name} ${JSON.stringify(args)} ${r.result?.isError ? "[isError]" : ""}`);
  console.log(text.slice(0, 300));
  if (image) console.log(`[image: ${image.data.length} base64 chars]`);
  return { r, text, image };
};

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0.1.0" },
  });
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log("TOOLS:", names.join(", "));
  check("tools/list returns 13 tools", names.length === 13, `got ${names.length}`);

  const open = await call("open_url", { url: "http://127.0.0.1:8765" });
  check("open_url loads test page", open.text.includes("127.0.0.1:8765") && !open.r.result?.isError);

  await call("click", { selector: "#btn" });
  await call("click", { selector: "#btn" });
  const count = await call("get_text", { selector: "#count" });
  check("click x2 -> #count is 2", count.text.trim() === "2", `got "${count.text.trim()}"`);

  await call("type", { selector: "#name", value: "hi" });
  const val = await call("eval_js", { expression: "document.querySelector('#name').value" });
  // eval_js returns raw strings as-is (only non-strings are JSON-serialized)
  check("type + eval_js round-trip", val.text.trim() === "hi", `got ${val.text.trim()}`);

  const title = await call("get_title", {});
  check("get_title", title.text.includes("Browser Tool Test Page"), title.text.trim());

  const shot = await call("screenshot", {});
  check("screenshot returns PNG", !!shot.image && shot.image.data.length > 1000);

  await call("close", {});
  check("close ok", true);
} finally {
  child.kill();
}
console.log(failures === 0 ? "\nE2E: ALL PASSED" : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
