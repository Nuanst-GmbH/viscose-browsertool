# Changelog

All notable changes to the **Browser Tool (MCP)** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-15

### Added

- **Integrated browser tab is now the primary engine.** When the tab is open with
  its CDP session attached, all MCP tools (`navigate`, `click`, `type`, `select`,
  `get_text`, `get_html`, `get_url`, `get_title`, `eval_js`, `wait_for`,
  `screenshot`) drive the VS Code integrated browser tab directly (over CDP) —
  so results match the page you see, and SSO/Kerberos logins "just work". The
  headless Playwright twin remains as an automatic fallback (e.g. when the tab is
  closed), seeded to the last URL so navigation state is preserved.
- **`sync_cookies` tool.** Copies the integrated tab's cookies (read via its live
  CDP session) into the headless twin so the fallback engine can authenticate to
  SSO-protected sites.

### Fixed

- **Multi-window: `EADDRINUSE` on the 2nd+ window.** The named pipe was a single
  fixed name, so only the first window's extension host could bind it and every
  later window's MCP server would have targeted the first window's tab. The pipe
  is now named per owning extension host (`vscode-browser-tool-<pid>`); each
  window's MCP server discovers its own window's host by walking process ancestry
  to the nearest VS Code ancestor. Unresolvable ancestry degrades to the headless
  twin — never to the wrong window.

## [0.2.2] - 2026-10-15

### Fixed

- "Enable browser tab integration" used a stale command id
  (`workbench.action.configureRuntimeArgs`) that doesn't exist in current VS Code
  builds; it now tries `workbench.action.configureRuntimeArguments` first and falls
  back to a palette hint if neither opens.

## [0.2.1] - 2026-10-15

### Added

- Command "Browser Tool: Enable browser tab integration" — opens VS Code's
  argv.json via the built-in "Configure Runtime Arguments" command and puts a
  paste-ready `enable-proposed-api` snippet (with the extension id, so nothing
  to type or copy) on the clipboard. Also offered as a button in the warning
  shown when the `browser` proposal is not enabled.

### Fixed

- Extension no longer crashes at activation when the `browser` API proposal is not
  enabled. Proposed-API calls/subscriptions now happen only when `browserTool.browserTab`
  is on, and start-up failures are reported in the "Browser Tool" output channel with a
  hint instead of throwing.

## [0.2.0] - 2026-10-15

### Added

- Optional live view: new `browserTool.browserTab` setting (default `false`). When enabled,
  `open_url`/`navigate` open the page in VS Code's integrated browser tab via the proposed
  `browser` API (`vscode.window.openBrowserTab`). The MCP server delegates to the extension
  host over a local named pipe (`src/bridge.ts`); `navigate` reuses the tab through a CDP
  session when available. Feature-detected — unavailable API means no live view, never an
  error. Smoke test: `node scripts/bridge-smoke.mjs`.

### Removed

- Live in-editor viewing via VS Code's Simple Browser panel (`src/viewer.ts`). It was launched
  with `code --command vscode.simpleBrowser.show <url>`, but the `--command` CLI flag does not
  exist in current VS Code builds, so instead of opening the webview the URL was opened as a
  blank text file. The headless twin is unaffected; viewing is via `screenshot`.

## [0.1.0] - 2026-10-14

### Added

- First public release.
- 13 MCP browser tools: `open_url`, `navigate`, `click`, `type`, `select`,
  `get_text`, `get_html`, `get_url`, `get_title`, `eval_js`, `wait_for`,
  `screenshot`, `close`.
- Live in-editor viewing via VS Code's Simple Browser panel
  (`open_url` mirrors the page so the user can watch the agent work).
- Headless Playwright Chromium "twin" that performs all automated interaction
  (webviews cannot script cross-origin pages).
- Persistent single browser context per session — cookies and SSO state carry
  across tool calls, so login flows work naturally.
- `BROWSER_TOOL_CHANNEL` env var to use a locally installed browser
  (`msedge`, `chrome`) when the Playwright browser download is unavailable.
- `BROWSER_TOOL_GL=swiftshader` env var to fix blank `<canvas>` in some SPAs.
- E2E smoke test (`scripts/e2e.mjs`) driving the server over stdio against a
  local test page (`npm run testpage`).
