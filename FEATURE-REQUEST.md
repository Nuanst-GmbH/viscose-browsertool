# Feature request for the Claude Code VS Code extension

> Paste into a new issue at **https://github.com/anthropics/claude-code/issues**
> (GitHub is not reachable from my corporate machine, so this text is prepared for you to file.)

**Title:**

```
Feature request: built-in browser tool for Claude Code in VS Code (open & interact with URLs in-editor)
```

**Body:**

```markdown
## Summary

Claude Code in VS Code (agent mode) has no way to open a web page and interact with it. Please add a first-party browser tool: open a URL in a panel inside VS Code, then navigate, click, fill forms, read the page, evaluate JS, wait, and take screenshots — all as agent tools.

## Motivation

Agents frequently need to verify or operate web UIs:

- Dashboards (e.g. Grafana) — reading panel values and grabbing a screenshot as evidence
- Apps served via local port-forwards (k8s, dev servers)
- Tools behind SSO that the user is already logged into

Today this requires external plumbing (Playwright/CDP MCP servers, headless browsers, separate windows). A native, in-editor tool would be self-contained, visible to the user in real time, and the default way agents do web work in VS Code.

## Proposed behavior

A set of agent tools, roughly: `open_url`, `navigate`, `click(selector)`, `type(selector, value)`, `select(selector, value)`, `get_text`, `get_html`, `get_url`, `get_title`, `eval_js`, `wait_for(selector)`, `screenshot`, `close` — with `screenshot` returning an image the agent can see, mirroring how Playwright-based MCP servers work today.

## Implementation notes

- The tools could be registered/exposed through VS Code's Language Model Tools API (`vscode.lm.tools` / `vscode.lm.invokeTool`), which is the existing VS Code surface for extensions to offer tools to AI agents.
- Design constraint worth knowing up front: **webviews cannot script cross-origin pages** (standard same-origin policy — this is why Simple Browser is view-only). A workable split: render the page in a Simple-Browser-style webview panel for display, while performing actions and capturing screenshots in a CDP-driven Chromium that shares the same process/session.
- A persistent single browser context per session is what makes SSO flows usable (login once, cookies persist across tool calls).

## Bonus ask

Support Claude Code invoking third-party tools that any extension registers via `vscode.lm.tools` — that would let the VS Code extension ecosystem supply browser (and other) capabilities without waiting for each to be first-party.

## Environment

- Windows 11
- VS Code 1.141.0
- Claude Code VS Code extension
```
