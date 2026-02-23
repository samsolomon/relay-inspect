import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { cdpClient, config, isInternalTargetUrl } from "./cdp-client.js";
import { isAutoLaunchEnabled, findChromePath } from "./chrome-launcher.js";
import { serverManager } from "./server-manager.js";
import { annotationServer, getAnnotationPort } from "./annotationServer.js";
import { buildOverlayScript } from "./annotationOverlay.js";

// --- Crash Guards ---
// Register before any async work. CDP operations can reject at any time
// (Chrome restarts, page navigations, etc.) — don't let that kill the server.

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[relay-inspect] Unhandled rejection:", msg);
});

process.on("uncaughtException", (err) => {
  console.error("[relay-inspect] Uncaught exception:", err.stack ?? err.message);
});

const server = new McpServer({
  name: "relay-inspect",
  version: "0.1.0",
});

// --- Auto-inject annotation overlay ---

async function injectOverlay(client: CDP.Client): Promise<void> {
  const port = await annotationServer.start();
  const script = buildOverlayScript(port);
  await client.Runtime.evaluate({
    expression: script,
    returnByValue: true,
    awaitPromise: false,
  });
  console.error("[relay-inspect] Annotation overlay injected.");
}

// Inject on new CDP connection
cdpClient.onConnect(injectOverlay);

// Re-inject after page navigations (DOM is replaced, injected script is gone)
cdpClient.onNavigate(injectOverlay);

// --- Screenshot callback for annotation server ---

annotationServer.onScreenshot(async (rect) => {
  try {
    const client = await cdpClient.ensureConnected();
    const dpr = await client.Runtime.evaluate({ expression: "window.devicePixelRatio", returnByValue: true });
    const scale = (dpr.result.value as number) ?? 1;
    const result = await client.Page.captureScreenshot({
      format: "png",
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale,
      },
    });
    return "data:image/png;base64," + result.data;
  } catch (err) {
    console.error(`[relay-inspect] Screenshot capture error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
});

// --- "Send to AI" notification callback ---

annotationServer.onSendNotify((count) => {
  server.sendLoggingMessage({
    level: "info",
    logger: "annotations",
    data: count > 0
      ? `User clicked "Send to AI" with ${count} open annotation(s). Check your pending wait_for_send result, or call list_annotations to review.`
      : `User clicked "Send to AI" but no open annotations remain.`,
  }).catch(() => { /* ignore if not connected */ });
});

// --- Helper ---

function connectionError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const autoLaunch = isAutoLaunchEnabled();
  return withAnnotationCount({
    content: [{
      type: "text",
      text: JSON.stringify({
        error: `Chrome connection failed: ${message}`,
        hint: autoLaunch
          ? `Auto-launch is enabled but Chrome could not be started. Set CHROME_PATH to your Chrome executable, or launch Chrome manually with --remote-debugging-port=${config.port}.`
          : `Auto-launch is disabled (CHROME_AUTO_LAUNCH=false). Launch Chrome with --remote-debugging-port=${config.port}, or enable auto-launch.`,
      }, null, 2),
    }],
    isError: true,
  });
}

// --- Processing state tracking ---

let previousWaitForSendTriggered = false;

/** Best-effort push of processing state to the browser overlay via CDP.
 *  Uses passive `isConnected` check to avoid triggering auto-launch. */
function injectProcessingState(state: "idle" | "processing" | "done"): void {
  if (!cdpClient.isConnected) return;
  cdpClient.ensureConnected().then((client) => {
    client.Runtime.evaluate({
      expression: `if (typeof window.__relaySetProcessingState === 'function') window.__relaySetProcessingState('${state}');`,
      returnByValue: true,
      awaitPromise: false,
    }).catch(() => { /* best-effort */ });
  }).catch(() => { /* not connected — skip */ });
}

// --- Passive annotation count wrapper ---

function withAnnotationCount(
  result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
) {
  const port = getAnnotationPort();
  if (port === null) return result;

  const openAnnotations = annotationServer
    .getAnnotations()
    .filter((a) => a.status === "open");

  // Check if the user clicked "Send to AI" — deliver full annotations inline
  const sentTriggered = annotationServer.consumeSentState();

  // Signal "done" from a previous processing cycle (before starting new work)
  if (previousWaitForSendTriggered && !sentTriggered) {
    previousWaitForSendTriggered = false;
    injectProcessingState("done");
  }

  if (openAnnotations.length === 0 && !sentTriggered) return result;

  if (sentTriggered) {
    const annotationBlocks = formatAnnotations(openAnnotations);
    result.content.push(...annotationBlocks);

    // Signal "processing" to the overlay
    previousWaitForSendTriggered = true;
    injectProcessingState("processing");

    // Fire-and-forget auto-resolve: remove badges + delete annotations
    (async () => {
      try {
        const client = await cdpClient.ensureConnected();
        const safeIds = openAnnotations.map((a) => a.id.replace(/[^a-f0-9-]/gi, ""));
        await client.Runtime.evaluate({
          expression: `(function() {
            ${safeIds.map((id) => `var p = document.querySelector('[data-relay-annotation-id="${id}"]'); if (p) p.remove();`).join("\n")}
            if (typeof window.__relayAnnotateRefresh === 'function') window.__relayAnnotateRefresh();
            return true;
          })()`,
          returnByValue: true,
          awaitPromise: false,
        });
      } catch { /* best-effort */ }
      for (const a of openAnnotations) {
        annotationServer.deleteAnnotation(a.id);
      }
    })();

    return result;
  }

  // Otherwise just append the pending count
  for (const block of result.content) {
    if (block.type === "text" && block.text) {
      try {
        const parsed = JSON.parse(block.text);
        parsed.pending_annotations = openAnnotations.length;
        block.text = JSON.stringify(parsed, null, 2);
        break;
      } catch {
        /* not JSON — skip */
      }
    }
  }
  return result;
}

// --- Tool: check_connection ---

server.tool(
  "check_connection",
  "Check Chrome DevTools connection status and diagnose issues (does not auto-launch Chrome)",
  {},
  async () => {
    const result: Record<string, unknown> = {
      config: {
        host: config.host,
        port: config.port,
        auto_launch_enabled: isAutoLaunchEnabled(),
        chrome_path: findChromePath(),
      },
    };

    // Step 1: Check if Chrome is reachable via CDP
    try {
      const version = await CDP.Version({ host: config.host, port: config.port });
      result.chrome_reachable = true;
      result.chrome_version = version["Browser"] ?? null;
      result.user_agent = version["User-Agent"] ?? null;
    } catch {
      result.chrome_reachable = false;
      result.chrome_version = null;
      result.status = "Chrome is not reachable";
      result.hint = isAutoLaunchEnabled()
        ? "Chrome will be auto-launched on the next tool call, or launch it manually with: chrome --remote-debugging-port=" + config.port
        : "Launch Chrome with: chrome --remote-debugging-port=" + config.port;
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    }

    // Step 2: Enumerate targets
    try {
      const targets = await CDP.List({ host: config.host, port: config.port });
      const pages = targets.filter((t: { type: string }) => t.type === "page");
      result.page_count = pages.length;
      result.pages = pages.map((t: { url: string; title: string; id: string }) => ({
        url: t.url,
        title: t.title,
        id: t.id,
        internal: isInternalTargetUrl(t.url),
      }));

      result.status = pages.length > 0
        ? "Connected and ready"
        : "Chrome is reachable but no page targets found — open a page in Chrome";
    } catch (err) {
      result.target_enumeration_error = err instanceof Error ? err.message : String(err);
      result.status = "Chrome is reachable but target enumeration failed";
    }

    return withAnnotationCount({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  },
);

// --- Tool: connect_to_page ---

server.tool(
  "connect_to_page",
  "Connect to a specific Chrome page target by ID or URL pattern. The annotation overlay is auto-injected on connect. After connecting, call wait_for_send to listen for user annotations.",
  {
    id: z
      .string()
      .optional()
      .describe("Exact page target ID from check_connection"),
    urlPattern: z
      .string()
      .optional()
      .describe("URL substring to match (case-insensitive), e.g. localhost:5173"),
    url_pattern: z
      .string()
      .optional()
      .describe("Alias for urlPattern"),
    waitForMs: z
      .number()
      .min(0)
      .optional()
      .default(0)
      .describe("Optional timeout to wait for a matching page target to appear"),
  },
  async ({ id, urlPattern, url_pattern, waitForMs }) => {
    const normalizedId = id?.trim();
    const normalizedPattern = (urlPattern ?? url_pattern)?.trim();

    if (normalizedId && normalizedPattern) {
      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ error: "Provide either id or urlPattern/url_pattern, not both." }, null, 2),
        }],
        isError: true,
      });
    }

    if (!normalizedId && !normalizedPattern) {
      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ error: "Provide id or urlPattern/url_pattern." }, null, 2),
        }],
        isError: true,
      });
    }

    try {
      const selected = await cdpClient.connectToPage({
        id: normalizedId,
        urlPattern: normalizedPattern,
        waitForMs,
      });

      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              connected_target: selected,
              hint: "The annotation overlay has been auto-injected. Call wait_for_send now to listen for user annotations — do not wait for the user to ask.",
            },
            null,
            2,
          ),
        }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      });
    }
  },
);

// --- Tool: evaluate_js ---

server.tool(
  "evaluate_js",
  "Execute a JavaScript expression in the browser and return the result",
  { expression: z.string().describe("JavaScript expression to evaluate") },
  async ({ expression }) => {
    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 10000,
      });

      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? "Unknown error";
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify({ error: text }, null, 2),
          }],
          isError: true,
        });
      }

      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ result: result.result.value }, null, 2),
        }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      });
    }
  },
);

// --- Tool: get_console_logs ---

server.tool(
  "get_console_logs",
  "Return buffered console output (logs, warnings, errors) from the browser",
  {
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the buffer after reading (default: true)"),
  },
  async ({ clear }) => {
    try {
      await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    const entries = clear
      ? cdpClient.consoleLogs.drain()
      : cdpClient.consoleLogs.peek();

    return withAnnotationCount({
      content: [{
        type: "text",
        text: JSON.stringify({ count: entries.length, entries }, null, 2),
      }],
    });
  },
);

// --- Tool: get_network_requests ---

server.tool(
  "get_network_requests",
  "Return captured network requests and responses from the browser",
  {
    filter: z
      .string()
      .optional()
      .describe("URL substring filter — only return requests matching this string"),
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the buffer after reading (default: true)"),
  },
  async ({ filter, clear }) => {
    try {
      await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    let entries;
    if (filter) {
      entries = clear
        ? cdpClient.networkRequests.drainWhere((e) => e.url.includes(filter))
        : cdpClient.networkRequests.peek().filter((e) => e.url.includes(filter));
    } else {
      entries = clear ? cdpClient.networkRequests.drain() : cdpClient.networkRequests.peek();
    }

    return withAnnotationCount({
      content: [{
        type: "text",
        text: JSON.stringify({ count: entries.length, entries }, null, 2),
      }],
    });
  },
);

// --- Tool: get_elements ---

server.tool(
  "get_elements",
  "Query the DOM with a CSS selector and return matching elements' outer HTML",
  {
    selector: z.string().describe("CSS selector to query"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of elements to return (default: 10)"),
  },
  async ({ selector, limit }) => {
    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      const doc = await client.DOM.getDocument({ depth: 0 });
      const result = await client.DOM.querySelectorAll({
        nodeId: doc.root.nodeId,
        selector,
      });

      if (result.nodeIds.length === 0) {
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify(
              { count: 0, elements: [], message: `No elements matched selector: "${selector}"` },
              null,
              2,
            ),
          }],
        });
      }

      const nodeIds = result.nodeIds.slice(0, limit);
      const elements: string[] = [];

      for (const nodeId of nodeIds) {
        try {
          const html = await client.DOM.getOuterHTML({ nodeId });
          elements.push(html.outerHTML);
        } catch {
          // Node may have become stale between query and getOuterHTML
          elements.push("<!-- stale node -->");
        }
      }

      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify(
            { count: elements.length, total_matches: result.nodeIds.length, elements },
            null,
            2,
          ),
        }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      });
    }
  },
);

// --- Tool: wait_and_check ---

server.tool(
  "wait_and_check",
  "Wait N seconds then return new console output captured during the wait (useful after page reload)",
  {
    seconds: z
      .number()
      .optional()
      .default(2)
      .describe("Seconds to wait before checking (default: 2)"),
  },
  async ({ seconds }) => {
    try {
      await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    // Drain stale entries
    cdpClient.consoleLogs.drain();

    // Wait for the specified duration
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    // Capture what arrived during the wait
    const entries = cdpClient.consoleLogs.drain();

    return withAnnotationCount({
      content: [{
        type: "text",
        text: JSON.stringify(
          { waited_seconds: seconds, count: entries.length, entries },
          null,
          2,
        ),
      }],
    });
  },
);

// --- Tool: take_screenshot ---

const MAX_BODY_SIZE = 10 * 1024; // 10KB truncation limit for network bodies

server.tool(
  "take_screenshot",
  "Capture a screenshot of the current page",
  {
    format: z
      .enum(["png", "jpeg"])
      .optional()
      .default("png")
      .describe("Image format (default: png)"),
    quality: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Compression quality 0-100 (jpeg only)"),
  },
  async ({ format, quality }) => {
    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      const params: { format: string; quality?: number } = { format };
      if (format === "jpeg" && quality !== undefined) {
        params.quality = quality;
      }

      const result = await client.Page.captureScreenshot(params);

      return {
        content: [{
          type: "image",
          data: result.data,
          mimeType: format === "png" ? "image/png" : "image/jpeg",
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      };
    }
  },
);

// --- Tool: reload_page ---

server.tool(
  "reload_page",
  "Reload the current page (optionally bypass cache)",
  {
    ignoreCache: z
      .boolean()
      .optional()
      .default(false)
      .describe("Bypass cache (hard refresh) when true (default: false)"),
  },
  async ({ ignoreCache }) => {
    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      await client.Page.reload({ ignoreCache });

      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ignoreCache }, null, 2),
        }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      });
    }
  },
);

// --- Tool: navigate_to ---

server.tool(
  "navigate_to",
  "Navigate the current page to a new URL",
  {
    url: z.string().describe("The URL to navigate to"),
  },
  async ({ url }) => {
    // Validate URL scheme
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Unsupported URL scheme: ${parsed.protocol}. Only http, https, and file are allowed.` }, null, 2),
          }],
          isError: true,
        });
      }
    } catch {
      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ error: `Invalid URL: ${url}` }, null, 2),
        }],
        isError: true,
      });
    }

    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      const result = await client.Page.navigate({ url });

      if (result.errorText) {
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Navigation failed: ${result.errorText}`, url }, null, 2),
          }],
          isError: true,
        });
      }

      return withAnnotationCount({
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, url, frameId: result.frameId }, null, 2),
        }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return withAnnotationCount({
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      });
    }
  },
);

// --- Tool: get_network_request_detail ---

server.tool(
  "get_network_request_detail",
  "Get full request and response body for a specific network request by ID",
  {
    requestId: z.string().describe("Request ID from get_network_requests output"),
  },
  async ({ requestId }) => {
    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    // Find the request summary from the buffer
    const entries = cdpClient.networkRequests.peek();
    const entry = entries.find((e) => e.id === requestId);

    const detail: Record<string, unknown> = {
      requestId,
      summary: entry ?? null,
    };

    // Get response body
    try {
      const resp = await client.Network.getResponseBody({ requestId });
      let body = resp.base64Encoded
        ? Buffer.from(resp.body, "base64").toString("utf-8")
        : resp.body;

      if (body.length > MAX_BODY_SIZE) {
        body = body.slice(0, MAX_BODY_SIZE);
        detail.responseBodyTruncated = true;
      }
      detail.responseBody = body;
    } catch {
      detail.responseBody = null;
      detail.responseBodyError = "Response body not available (may have been evicted from browser memory)";
    }

    // Get request POST data
    try {
      const req = await client.Network.getRequestPostData({ requestId });
      let postData = req.postData;
      if (postData.length > MAX_BODY_SIZE) {
        postData = postData.slice(0, MAX_BODY_SIZE);
        detail.requestBodyTruncated = true;
      }
      detail.requestBody = postData;
    } catch {
      // Not all requests have POST data — this is expected for GET requests
      detail.requestBody = null;
    }

    return withAnnotationCount({
      content: [{
        type: "text",
        text: JSON.stringify(detail, null, 2),
      }],
    });
  },
);

// --- Tool: start_server ---

server.tool(
  "start_server",
  "Start a dev server or background process and capture its output",
  {
    id: z.string().describe("Unique identifier for this server (e.g. 'dev', 'api')"),
    command: z.string().describe("Command to run (e.g. 'npm', 'npx', 'make')"),
    args: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Command arguments (e.g. ['run', 'dev'])"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command (defaults to server's cwd)"),
    env: z
      .record(z.string())
      .optional()
      .describe("Additional environment variables"),
    urlPattern: z
      .string()
      .optional()
      .describe("Optional URL substring to connect to after server start (e.g. localhost:5173)"),
    connectWaitForMs: z
      .number()
      .min(0)
      .optional()
      .default(15000)
      .describe("How long to wait for urlPattern target to appear"),
  },
  async ({ id, command, args, cwd, env, urlPattern, connectWaitForMs }) => {
    const result = serverManager.start({ id, command, args, cwd, env });

    if (result.success && urlPattern) {
      try {
        const connected = await cdpClient.connectToPage({
          urlPattern: urlPattern.trim(),
          waitForMs: connectWaitForMs,
        });
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify({
              ...result,
              connected_target: connected,
              hint: "The annotation overlay has been auto-injected. Call wait_for_send now to listen for user annotations — do not wait for the user to ask.",
            }, null, 2),
          }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return withAnnotationCount({
          content: [{
            type: "text",
            text: JSON.stringify({ ...result, connect_error: message }, null, 2),
          }],
          isError: true,
        });
      }
    }

    return withAnnotationCount({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  },
);

// --- Tool: get_server_logs ---

server.tool(
  "get_server_logs",
  "Read stdout/stderr output from a managed server process",
  {
    id: z.string().describe("Server identifier passed to start_server"),
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the log buffer after reading (default: true)"),
  },
  async ({ id, clear }) => {
    const result = serverManager.getLogs(id, clear);
    return withAnnotationCount({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  },
);

// --- Tool: stop_server ---

server.tool(
  "stop_server",
  "Stop a running managed server process",
  {
    id: z.string().describe("Server identifier passed to start_server"),
  },
  async ({ id }) => {
    const result = await serverManager.stop(id);
    return withAnnotationCount({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  },
);

// --- Tool: list_servers ---

server.tool(
  "list_servers",
  "List all managed server processes and their status",
  {},
  async () => {
    const servers = serverManager.list();
    return withAnnotationCount({
      content: [{ type: "text", text: JSON.stringify({ servers }, null, 2) }],
    });
  },
);

// --- Tool: inject_annotation_overlay ---

server.tool(
  "inject_annotation_overlay",
  "Re-inject the annotation overlay into the current browser page. The overlay is auto-injected on every Chrome connection — this tool is only needed if the page was navigated via a full reload that cleared the injected script. Safe to call repeatedly (idempotent).",
  {},
  async () => {
    // Lazy-start annotation server
    let port: number;
    try {
      port = await annotationServer.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Annotation server failed to start: ${message}` }, null, 2) }],
        isError: true,
      };
    }

    let client: CDP.Client;
    try {
      client = await cdpClient.ensureConnected();
    } catch (err) {
      return connectionError(err);
    }

    try {
      const script = buildOverlayScript(port);
      const result = await client.Runtime.evaluate({
        expression: script,
        returnByValue: true,
        awaitPromise: false,
      });

      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? "Unknown error";
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Overlay injection failed: ${text}` }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            port,
            message: result.result.value,
            hint: "The annotation overlay is now active. Users can click the pencil button (bottom-right) or press Shift+A to start annotating elements. IMPORTANT: Call wait_for_send now to listen for the user's annotations — do not wait for them to ask.",
          }, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        isError: true,
      };
    }
  },
);

// --- Annotation formatting helper (shared by list_annotations and wait_for_send) ---

type AnnotationContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function formatAnnotations(items: ReturnType<typeof annotationServer.getAnnotations>): AnnotationContentBlock[] {
  const content: AnnotationContentBlock[] = [];

  content.push({ type: "text", text: `${items.length} annotation(s):` });

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const num = i + 1;
    const conf = a.selectorConfidence === "stable" ? "stable" : "fragile";
    const lines = [
      `#${num} [${a.status.toUpperCase()}] id: ${a.id}`,
      `   Page: ${a.url}`,
      `   Selector (${conf}): ${a.selector}`,
      a.reactSource
        ? `   Component: ${a.reactSource.component}${a.reactSource.source ? ` (${a.reactSource.source})` : ""}`
        : null,
      `   Viewport: ${a.viewport.width}x${a.viewport.height}`,
      `   Feedback: ${a.text}`,
      `   Created: ${a.createdAt}`,
    ].filter(Boolean).join("\n");

    content.push({ type: "text", text: lines });

    if (a.screenshot) {
      const base64 = a.screenshot.replace(/^data:image\/\w+;base64,/, "");
      content.push({ type: "image", data: base64, mimeType: "image/png" });
    }
  }

  return content;
}

// --- Tool: list_annotations ---

server.tool(
  "list_annotations",
  "List all annotations pinned by the user in the browser overlay",
  {},
  async () => {
    const port = getAnnotationPort();
    if (port === null) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Annotation server is not running. It starts automatically when Chrome connects — try any browser tool first to trigger a connection.",
          }, null, 2),
        }],
        isError: true,
      };
    }

    const items = annotationServer.getAnnotations();

    if (items.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: 0,
            message: "No annotations found.",
          }, null, 2),
        }],
      };
    }

    return { content: formatAnnotations(items) };
  },
);

// --- Tool: resolve_annotation ---

server.tool(
  "resolve_annotation",
  "Mark an annotation as resolved after addressing the user's feedback",
  {
    id: z.string().describe("The annotation ID to resolve"),
  },
  async ({ id }) => {
    const port = getAnnotationPort();
    if (port === null) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Annotation server is not running. It starts automatically when Chrome connects — try any browser tool first to trigger a connection.",
          }, null, 2),
        }],
        isError: true,
      };
    }

    const annotation = annotationServer.getAnnotation(id);
    if (!annotation) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: `Annotation "${id}" not found.` }, null, 2),
        }],
        isError: true,
      };
    }

    // Delete from server first so the browser refresh sees updated state
    annotationServer.deleteAnnotation(id);

    // Remove the badge from the browser and refresh the overlay
    try {
      const client = await cdpClient.ensureConnected();
      const safeId = id.replace(/[^a-f0-9-]/gi, "");
      await client.Runtime.evaluate({
        expression: `(function() {
          var pin = document.querySelector('[data-relay-annotation-id="${safeId}"]');
          if (pin) pin.remove();
          if (typeof window.__relayAnnotateRefresh === 'function') window.__relayAnnotateRefresh();
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: false,
      });
    } catch {
      // Best-effort — badge removal is visual-only
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          id: annotation.id,
          feedback: annotation.text,
        }, null, 2),
      }],
    };
  },
);

// --- Tool: wait_for_send ---

server.tool(
  "wait_for_send",
  "Long-poll until the user clicks 'Send to AI' in the browser overlay, then return all open annotations. Call this proactively after connecting to a page or injecting the overlay — do not wait for the user to ask. When it times out, call it again to keep listening.",
  {
    timeout: z
      .number()
      .min(1)
      .max(600)
      .optional()
      .default(30)
      .describe("Max seconds to wait (default 30, max 600)"),
  },
  async ({ timeout }) => {
    const port = getAnnotationPort();
    if (port === null) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Annotation server is not running. It starts automatically when Chrome connects — try any browser tool first to trigger a connection.",
          }, null, 2),
        }],
        isError: true,
      };
    }

    // Signal "done" from a previous processing cycle
    if (previousWaitForSendTriggered) {
      previousWaitForSendTriggered = false;
      injectProcessingState("done");
    }

    const result = await annotationServer.waitForSend(timeout * 1000);

    if (!result.triggered) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            timeout: true,
            waited_seconds: timeout,
            hint: "No annotations sent yet. Call wait_for_send again to keep listening.",
          }, null, 2),
        }],
      };
    }

    const items = annotationServer.getAnnotations().filter((a) => a.status === "open");

    if (items.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sent: true, count: 0, message: "No open annotations." }, null, 2),
        }],
      };
    }

    const content = formatAnnotations(items);

    // Auto-resolve: remove badges from browser and delete annotations
    try {
      const client = await cdpClient.ensureConnected();
      const ids = items.map((a) => a.id);
      const safeIds = ids.map((id) => id.replace(/[^a-f0-9-]/gi, ""));
      await client.Runtime.evaluate({
        expression: `(function() {
          ${safeIds.map((id) => `var p = document.querySelector('[data-relay-annotation-id="${id}"]'); if (p) p.remove();`).join("\n")}
          if (typeof window.__relayAnnotateRefresh === 'function') window.__relayAnnotateRefresh();
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: false,
      });
    } catch {
      // Best-effort — badge removal is visual-only
    }
    for (const a of items) {
      annotationServer.deleteAnnotation(a.id);
    }

    // Signal "processing" after annotations are cleaned up to avoid ghost pins
    previousWaitForSendTriggered = true;
    injectProcessingState("processing");

    content.push({
      type: "text",
      text: JSON.stringify({
        hint: "After addressing these annotations, call wait_for_send again to keep listening for more.",
      }, null, 2),
    });

    return { content };
  },
);

// --- Process Exit Handlers ---

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[relay-inspect] Received ${signal}, shutting down...`);
  await Promise.all([
    cdpClient.shutdown(),
    serverManager.stopAll(),
    annotationServer.shutdown(),
  ]);
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

// Last-resort sync cleanup — async operations are not possible in 'exit'
process.on("exit", () => {
  cdpClient.shutdownSync();
});

// --- Start ---

async function main(): Promise<void> {
  console.error("[relay-inspect] Starting MCP server...");

  if (isAutoLaunchEnabled()) {
    console.error("[relay-inspect] Chrome auto-launch is enabled. Chrome will be launched on first tool call if needed.");
  }

  // No eager Chrome connection — ensureConnected() handles it lazily on first tool call

  // Start MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[relay-inspect] MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[relay-inspect] Fatal error:", err);
  process.exit(1);
});
