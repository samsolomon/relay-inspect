<img src="logo.svg" width="128" height="128" alt="Relay Inspect"> 

[![npm version](https://img.shields.io/npm/v/relay-inspect)](https://www.npmjs.com/package/relay-inspect)

Stop copying and pasting console logs, server errors and screenshots into your CLI. Relay Inspect gives your AI coding agent direct access to your browser—so it can see what you see, verify its own changes, and debug without asking you to copy and paste.

Relay Inspect is a lightweight tool for designers and engineers who want to spend more time building and less time debugging.

```
                                                    ┌─ Chrome (CDP over WebSocket)
AI Coding Agent  ←→  Relay Inspect (MCP over stdio) ─┤
                                                    └─ Dev Servers (child processes)
```

Relay Inspect is a bridge between the Chrome DevTools Protocol, your dev server and your agent. It exposes browser state as MCP tools—console output, network requests, DOM queries and screenshots. Your agent edits code, the dev server hot reloads, and the agent verifies the result itself.

> **Looking for annotations?** The browser annotation overlay has moved to its own package: [Annoku](https://github.com/samsolomon/annoku).

## Why Relay Inspect over Chrome DevTools MCP?

Google's [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) is a full browser automation tool—it clicks buttons, fills forms, runs Lighthouse audits, and scripts interactions. Relay Inspect gives agents continuous visibility while they work, so mistakes get caught in the moment, not at the end.

* **Gives agents eyes.** Real-time access to console output, network requests, and DOM state — so your agent sees what's happening as it happens, not after it's already moved on.
* **Tight feedback loop.** The edit → reload → verify cycle happens in a single turn. Your agent makes a change, waits for the dev server to reload, and immediately confirms it worked—without additional back-and-forth.
* **Focused tools, fewer wrong turns.** A handful of purpose-built tools means your agent reaches for the right one rather than thrashing through a broad API surface. Less noise, more signal.
* **Zero overhead, zero telemetry.** Connects lazily on the first tool call—no Puppeteer, no phoning home. Nothing runs until your agent needs it.


## Tools

Your agent gets access to the following tools automatically via MCP:

### Browser Inspection

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `evaluate_js` | Execute a JavaScript expression in the browser and return the result | `expression` (string) |
| `get_console_logs` | Return buffered console output (logs, warnings, errors) | `clear` (bool, default: true) |
| `get_network_requests` | Return captured network requests and responses | `filter` (URL substring), `clear` (bool, default: true) |
| `get_network_request_detail` | Get full request/response body for a specific network request | `requestId` (string, from `get_network_requests`) |
| `get_elements` | Query the DOM with a CSS selector and return matching elements' outer HTML | `selector` (string), `limit` (number, default: 10) |
| `take_screenshot` | Capture a screenshot of the current page | `format` (png/jpeg, default: png), `quality` (0-100, jpeg only) |

### Page Control

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `reload_page` | Reload the current page (optionally bypass cache) | `ignoreCache` (bool, default: false) |
| `wait_and_check` | Wait N seconds then return new console output captured during the wait | `seconds` (number, default: 2) |
| `connect_to_page` | Switch to a specific Chrome page target by ID or URL match | `id` (string) OR `urlPattern` (string), `waitForMs` (number) |
| `navigate_to` | Navigate the current page to a new URL | `url` (string) |

### Server Management

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `start_server` | Start a dev server or background process and capture its output | `id` (string), `command` (string), `args` (string[]), `cwd` (string), `env` (object), optional `urlPattern` + `connectWaitForMs` |
| `get_server_logs` | Read stdout/stderr output from a managed server process | `id` (string), `clear` (bool, default: true) |
| `stop_server` | Stop a running managed server process | `id` (string) |
| `list_servers` | List all managed server processes and their status | — |

### Diagnostics

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `check_connection` | Check Chrome connection status and diagnose issues (does not auto-launch) | — |

## Setup

### Prerequisites

- Node.js 20+
- Chrome (or any Chromium-based browser)

### Add to your MCP client

No install required — `npx` downloads and runs the package on first use.

**Claude Code** — add to `.mcp.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "relay-inspect": {
      "command": "npx",
      "args": ["-y", "relay-inspect"]
    }
  }
}
```

**Codex CLI:**

```bash
codex mcp add relay-inspect -- npx -y relay-inspect
```

**opencode** — add to `opencode.json`:

```json
{
  "mcp": {
    "relay-inspect": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "relay-inspect"]
    }
  }
}
```

Chrome is auto-launched on first tool call if it isn't already running. To disable this or customize behavior, see Configuration below.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CHROME_DEBUG_PORT` | `9222` | Chrome debugging port |
| `CHROME_DEBUG_HOST` | `localhost` | Chrome debugging host |
| `CHROME_AUTO_LAUNCH` | `true` | Auto-launch Chrome if not already running |
| `CHROME_PATH` | _(auto-detect)_ | Override Chrome/Chromium executable path |
| `CHROME_LAUNCH_URL` | _(none)_ | URL to open when Chrome is auto-launched (e.g. `http://localhost:1420`) |
| `CDP_WS_URL` | _(none)_ | Connect directly to a CDP WebSocket URL, skipping Chrome discovery |
| `CONSOLE_BUFFER_SIZE` | `500` | Max console entries to buffer |
| `NETWORK_BUFFER_SIZE` | `200` | Max network requests to buffer |
| `SERVER_LOG_BUFFER_SIZE` | `1000` | Max log entries per managed server |

If Chrome is already running with `--remote-debugging-port`, Relay Inspect will connect to it directly without launching a new instance.

## Development

```bash
git clone https://github.com/samsolomon/relay-inspect.git
cd relay-inspect
npm install
```

```bash
npm run dev    # Run with tsx (auto-recompile)
npm run build  # Build with tsup
npm start      # Run the built bundle
npm test       # Run tests with vitest
```

For detailed architecture, conventions, and CDP implementation notes, see [CLAUDE.md](./CLAUDE.md).
