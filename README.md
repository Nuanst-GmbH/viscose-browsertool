# Browser Tool (MCP)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nuanst-one.vscode-browser-tool)](https://marketplace.visualstudio.com/items?itemName=nuanst-one.vscode-browser-tool)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for VS Code that lets AI agents (Claude Code,
Copilot, or any MCP client) open any URL in a browser and interact with it.

- **Headless browser** — all automated actions (navigate, click, type, select, read, evaluate JS,
  screenshot) run on a headless Playwright Chromium ("the twin"), because webviews cannot script
  cross-origin pages. `screenshot` returns a real PNG of the page, so the agent — and you — see
  exactly what is there.
- **Persistent session** — a single browser context lives for the whole session, so cookies and
  SSO state persist across tool calls. A typical SSO login flows naturally:
  `open_url` → `type` credentials → `click` submit → `wait_for` dashboard → `screenshot`.
- **Live view (optional)** — set `browserTool.browserTab` to `true` and `open_url`/`navigate`
  also open the page in VS Code's **integrated browser tab**, so you can watch the agent work.
  Off by default (see [Browser tab integration](#browser-tab-integration-optional-live-view)).

## Installation

Install the **Browser Tool (MCP)** extension from the VS Code Marketplace. The extension
registers the `browser-tool` MCP server with VS Code's MCP client (VS Code 1.104 or newer,
which introduced the `mcpServers` contribution point).

<details>
<summary><b>Manual installation / use outside VS Code</b></summary>

The server is a plain Node.js program (Node >= 20). Any MCP client can run it:

```bash
npm install
npm run build
# Claude Code (user scope):
claude mcp add -s user browser-tool -- node /path/to/vscode-browser-tool/dist/server.js
```

or as a raw MCP client config:

```json
{
  "mcpServers": {
    "browser-tool": {
      "command": "node",
      "args": ["/path/to/vscode-browser-tool/dist/server.js"]
    }
  }
}
```

</details>

## Tools

| Tool | Purpose |
|---|---|
| `open_url` | Open a URL in the headless browser. Starts a new session. |
| `navigate` | Navigate the current page to a new URL |
| `click` | Click an element by CSS selector |
| `type` | Type a value into an input/textarea (clears first; `submit` presses Enter) |
| `select` | Select an option in a `<select>` by value, label, or index |
| `get_text` | Read visible text (innerText) of an element or the whole page |
| `get_html` | Read the outerHTML of an element or the whole document |
| `get_url` / `get_title` | Current URL / page title |
| `eval_js` | Evaluate a JS expression in the page (JSON-serialized result) |
| `wait_for` | Wait for a selector to be visible, or for page load (max 120 s) |
| `screenshot` | PNG of the current page, returned as an image the agent can see |
| `close` | Tear down the page, context, and browser |

## Configuration

Environment variables (set on the MCP server entry):

| Variable | Values | Effect |
|---|---|---|
| `BROWSER_TOOL_CHANNEL` | `msedge`, `chrome`, … | Use a locally installed browser instead of Playwright's own Chromium. Useful when the Playwright browser CDN is blocked (corporate networks). |
| `BROWSER_TOOL_GL` | `swiftshader` | Launches with `--use-gl=swiftshader`; fixes blank `<canvas>` in some SPAs. |

By default the server uses Playwright's bundled Chromium. If it has never been downloaded on
the machine, run `npx playwright install chromium` once.

## Browser tab integration (optional live view)

Setting `browserTool.browserTab` to `true` makes `open_url` and `navigate` also open the page
in VS Code's integrated browser tab. This is **off by default** and works like this:

- The MCP server is a plain Node process and cannot call the `vscode` API, so it talks to the
  extension host over a local named pipe (`\\.\pipe\vscode-browser-tool` on Windows,
  `<tmpdir>/vscode-browser-tool.sock` elsewhere).
- The extension host opens the tab with the **proposed `browser` API**
  (`vscode.window.openBrowserTab`) and, when available, attaches a CDP session so
  `navigate` steers the *same* tab (`Page.navigate`) instead of opening a new one.
- If the extension isn't loaded, VS Code isn't running, or the proposed API is missing in your
  VS Code version, requests are dropped silently — the headless twin is unaffected.
- One tab at a time; the tab is closed when you disable the setting again (or when the VS Code
  window reloads).

**First-time setup (once):** on a stable VS Code build the proposal must be enabled in
`argv.json` (`"enable-proposed-api": ["nuanst-one.vscode-browser-tool"]`). Use the command
**"Browser Tool: Enable browser tab integration"** (or the button in the warning it shows when
you turn the setting on) — it opens argv.json via VS Code's own *Configure Runtime Arguments*
command and copies a paste-ready snippet with the extension id to your clipboard. Then fully
restart VS Code.

Because the `browser` API is a proposal, it may change shape or be removed in a future VS Code
release. The extension feature-detects it and degrades to "no live view" rather than failing.

## Example session

```
"open https://app.example.com with browser-tool, log in as me@example.com / <password>,
wait for the dashboard, and screenshot it."
```

The agent maps that to: `open_url` → `type` username → `type` password → `click` submit →
`wait_for` → `screenshot`. The screenshot the agent returns is real evidence, not a guess.

## Known limitations

- One page/context, no multi-tab. The browser renders headless at 1440×900, so you see the
  session through the screenshots and text the tools return.
- Auth flows the browser can't script (MFA/QR codes) must be completed through the tools
  (e.g. by typing the code into the login form).
- The browser tab live view uses a **proposed** VS Code API; it may not be available (or may
  change) depending on your VS Code version. Everything else is unaffected.
- `get_text`/`eval_js` results are truncated at 20,000 chars; `get_html` at 50,000.

## Privacy

- **No telemetry.** The extension and its MCP server collect no usage data, send no
  analytics, and phone home to nothing. The only network traffic is the browser traffic
  generated by the pages themselves.
- **Your credentials stay local.** Cookies and SSO state live in a single local browser
  context for the session and are discarded when the server process ends (or on `close`).

### Third-party content disclaimer

This extension is a browser *automation layer*: it opens, renders, and interacts with
whatever URLs the user or the AI agent requests. **The behaviour of those URLs is outside
the scope of this extension and its maintainers' responsibility.** Specifically:

- Content loaded from any site — including scripts, iframes, fonts, and tracking
  beacons embedded by that site or its third-party providers — executes or loads in the
  headless browser under the same rules as any other browser visit. We do not inspect,
  filter, or vouch for it.
- Data that a site receives (form submissions, logins, search queries, IP address) is
  governed by that site's own privacy policy, not by this extension.
- Agents may be pointed at arbitrary or untrusted URLs by design. Users are responsible
  for deciding which URLs to open and for using appropriate credentials in
  appropriate environments, exactly as with any other browser or Playwright-based tool.

## Development

```bash
npm install
npm run build          # esbuild bundles -> dist/server.js + dist/extension.js
npm run typecheck      # tsc --noEmit
```

### E2E smoke test

```bash
npm run testpage       # serves http://127.0.0.1:8765 in a terminal
node scripts/e2e.mjs   # drives the built server over stdio: 13 tools, click/type/eval/screenshot
node scripts/bridge-smoke.mjs   # fake pipe server: checks open_url/navigate cross the bridge
```

Or in an agent session: *"open http://127.0.0.1:8765 with browser-tool, click `#btn` twice,
read `#count`, and screenshot it."*

### Repository layout

| File | Purpose |
|---|---|
| `src/server.ts` | MCP server: tool registration, arg validation, error wrapping |
| `src/browser.ts` | The headless "twin": one browser/context/page for the session |
| `src/bridge.ts` | Named-pipe bridge: path + fire-and-forget client used by the MCP server |
| `src/extension.ts` | Extension host: opens/navigates the integrated browser tab when `browserTool.browserTab` is on |
| `src/vscode.proposed.browser.d.ts` | Copy of the proposed `browser` API typings (typecheck only) |
| `scripts/e2e.mjs` | Raw JSON-RPC smoke test over stdio |
| `scripts/bridge-smoke.mjs` | Bridge client test with a fake pipe server |
| `scripts/testpage.js` | Tiny local test page (button, counter, input) |

## License

[MIT](LICENSE) © Nuanst One GmbH

Source and issues: <https://github.com/nuanst-one/vscode-browser-tool>
