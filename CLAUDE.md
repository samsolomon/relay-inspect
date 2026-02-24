# Relay Inspect

An MCP server that bridges AI coding agents and Chrome DevTools Protocol, giving agents real-time visibility into console logs, network requests, DOM elements, and the ability to execute JavaScript in the browser.

## Architecture

```
                                                    ┌─ Chrome (CDP over WebSocket)
AI Coding Agent  ←→  Relay Inspect (MCP over stdio) ─┤
                                                    └─ Dev Servers (child processes)
```

- MCP server built with `@modelcontextprotocol/sdk`, communicates with the AI coding agent over stdio
- Connects to Chrome via `chrome-remote-interface` on `localhost:9222`
- Buffers console and network events continuously once connected
- Stateless tools — each tool call returns current buffer contents or live queries
- Design goal: enable a tight edit → hot-reload → verify loop. Every decision should make this cycle faster and more reliable

## Tech Stack

TypeScript in strict mode, built with `tsup`. See `package.json` for dependencies.

## Project Structure

```
relay-inspect/
├── src/
│   ├── index.ts              # Entry point — MCP server setup, tool registration, exit handlers
│   ├── cdp-client.ts         # Chrome connection, event buffering, reconnection, auto-launch integration
│   ├── chrome-launcher.ts    # Chrome path discovery, auto-launch, CDP readiness polling
│   ├── server-manager.ts     # Dev server lifecycle management (start/stop/logs)
│   ├── *.test.ts             # Test files (cdp-target-selection, circular-buffer, server-manager)
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## Commands

- **Build:** `npm run build`
- **Test:** `npm test`
- **Dev:** `npm run dev` or `npx tsx src/index.ts`

## Connection Management

- **Lazy connect, no background timers** — Don't connect at startup. `ensureConnected()` connects on first tool call. On disconnect, null out the client and let the next call reconnect. No auto-reconnect timers
- **Never cache WebSocket URLs** — Always discover Chrome targets via HTTP (`CDP.List()`). Chrome WebSocket URLs change on restart; caching them causes silent failures
- **Buffers drain on read** — `get_console_logs` and `get_network_requests` clear the buffer by default so the agent sees only new entries

## Troubleshooting Chrome Connections

If `check_connection` returns `ECONNREFUSED`, Chrome's debugging port didn't bind. Common cause: Chrome was already running without `--remote-debugging-port`, so the flag was silently ignored. Verify with `curl -s http://localhost:9222/json/version`.

```bash
# Reliable launch sequence
pkill -9 -f "Google Chrome"
sleep 2
/path/to/chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

## Error Handling

- If Chrome isn't connected, tools should return a clear error message, not throw
- If a CSS selector matches nothing, return an empty result with a helpful message
- If JS evaluation throws, capture and return the error message
- Network request bodies that are too large should be truncated with a note

## Configuration

Environment variables (scattered across `cdp-client.ts`, `chrome-launcher.ts`, `server-manager.ts`):

```
CHROME_DEBUG_PORT=9222          # Chrome debugging port (default: 9222)
CHROME_DEBUG_HOST=localhost     # Chrome debugging host (default: localhost)
CHROME_AUTO_LAUNCH=true         # Auto-launch Chrome if not running (default: true)
CHROME_PATH=/path/to/chrome     # Override Chrome executable path (default: auto-detect)
CHROME_LAUNCH_URL=http://...   # URL to open when Chrome is auto-launched (default: none)
CDP_WS_URL=ws://...            # Connect directly to a CDP WebSocket, skip Chrome discovery (default: none)
CONSOLE_BUFFER_SIZE=500         # Max console entries to buffer (default: 500)
NETWORK_BUFFER_SIZE=200         # Max network requests to buffer (default: 200)
SERVER_LOG_BUFFER_SIZE=1000     # Max log entries per managed server (default: 1000)
```

## Conventions

- All tools return JSON strings wrapped in MCP text content blocks
- Use stderr for logging (stdout is reserved for MCP protocol)
- MCP SDK imports need `.js` extensions: `@modelcontextprotocol/sdk/server/mcp.js` (`moduleResolution: "bundler"` handles this)
- Don't install unnecessary dependencies — this should stay lean
- Type everything — no `any` types
- Handle all CDP events defensively — Chrome can send unexpected data
- Format network timing in milliseconds, round to 2 decimal places
- Truncate response bodies at 10KB by default, note when truncated
