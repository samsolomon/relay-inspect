import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseIntWithDefault } from "./cdp-client.js";

// --- Types ---

export interface AnnotationElement {
  selector: string;
  selectorConfidence: "stable" | "fragile";
  reactSource: { component: string; source?: string } | null;
  elementRect: { x: number; y: number; width: number; height: number };
}

export interface Annotation {
  id: string;
  url: string;
  selector: string;
  selectorConfidence: "stable" | "fragile";
  text: string;
  status: "open" | "resolved";
  viewport: { width: number; height: number };
  reactSource: { component: string; source?: string } | null;
  screenshot: string | null;
  elements?: AnnotationElement[];
  anchorPoint?: { x: number; y: number };
  createdAt: string;
  updatedAt: string;
}

// --- Helpers ---

export function isAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
    ) {
      return origin;
    }
  } catch { /* invalid URL */ }
  return null;
}

function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  const allowed = isAllowedOrigin(origin) ?? "http://127.0.0.1";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...corsHeaders(req), "Content-Type": "application/json" });
  res.end(data);
}

const MAX_ANNOTATIONS = 50;
const MAX_BODY_BYTES = 64 * 1024; // 64KB
const MAX_TEXT_LENGTH = 10 * 1024; // 10KB
const MAX_VIEWPORT_DIM = 100_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// --- Annotation Server ---

export type ScreenshotCallback = (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>;

export class AnnotationServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number | null = null;
  private annotations = new Map<string, Annotation>();
  private screenshotCallback: ScreenshotCallback | null = null;
  private sendResolver: (() => void) | null = null;
  private sendCanceller: (() => void) | null = null;
  private sendLatched = false;
  private sendNotifyCallback: ((count: number) => void) | null = null;
  private sentTriggered = false;

  /**
   * Register a callback to capture element screenshots via CDP.
   */
  onScreenshot(cb: ScreenshotCallback): void {
    this.screenshotCallback = cb;
  }

  /**
   * Register a callback fired when the user clicks "Send to AI".
   * Used to push an MCP logging notification to the agent.
   */
  onSendNotify(cb: (count: number) => void): void {
    this.sendNotifyCallback = cb;
  }

  consumeSentState(): boolean {
    if (this.sentTriggered) {
      this.sentTriggered = false;
      return true;
    }
    return false;
  }

  waitForSend(timeoutMs: number): Promise<{ triggered: boolean }> {
    // If latched from a previous Send click, consume it immediately
    if (this.sendLatched) {
      this.sendLatched = false;
      return Promise.resolve({ triggered: true });
    }

    // Cancel any existing waiter (e.g. agent called again before timeout)
    if (this.sendCanceller) {
      this.sendCanceller();
    }

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        this.sendResolver = null;
        this.sendCanceller = null;
        if (timer) clearTimeout(timer);
      };

      this.sendResolver = () => {
        cleanup();
        resolve({ triggered: true });
      };

      this.sendCanceller = () => {
        cleanup();
        resolve({ triggered: false });
      };

      timer = setTimeout(() => {
        cleanup();
        resolve({ triggered: false });
      }, timeoutMs);
    });
  }

  async start(): Promise<number> {
    if (this.server) {
      return this.port!;
    }

    const basePort = parseIntWithDefault(process.env.ANNOTATION_PORT, 9223);
    const portsToTry = [basePort, basePort + 1, basePort + 2, basePort + 3];

    for (const port of portsToTry) {
      try {
        await this.listen(port);
        this.port = port;
        console.error(`[relay-inspect] Annotation server listening on port ${port}`);
        return port;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          console.error(`[relay-inspect] Port ${port} in use, trying next...`);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Could not bind annotation server on ports ${portsToTry.join(", ")}`);
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => this.handleRequest(req, res));
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.removeListener("error", reject);
        this.server = srv;
        resolve();
      });
    });
  }

  getPort(): number | null {
    return this.port;
  }

  getAnnotations(): Annotation[] {
    return Array.from(this.annotations.values());
  }

  getAnnotation(id: string): Annotation | undefined {
    return this.annotations.get(id);
  }

  resolveAnnotation(id: string): Annotation | undefined {
    const ann = this.annotations.get(id);
    if (!ann) return undefined;
    ann.status = "resolved";
    ann.updatedAt = new Date().toISOString();
    return ann;
  }

  deleteAnnotation(id: string): boolean {
    return this.annotations.delete(id);
  }

  async shutdown(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        console.error("[relay-inspect] Annotation server stopped.");
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  // --- HTTP Request Handler ---

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const method = req.method ?? "GET";
      const path = url.pathname;

      // CORS preflight
      if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      // Health check
      if (method === "GET" && path === "/") {
        jsonResponse(res, 200, {
          status: "ok",
          count: this.annotations.size,
          port: this.port,
        }, req);
        return;
      }

      // POST /annotations/send — trigger the long-poll resolver
      if (method === "POST" && path === "/annotations/send") {
        if (this.sendResolver) {
          this.sendResolver();
        } else {
          this.sendLatched = true;
        }
        this.sentTriggered = true;
        // Notify agent via MCP logging
        if (this.sendNotifyCallback) {
          const openCount = Array.from(this.annotations.values()).filter((a) => a.status === "open").length;
          this.sendNotifyCallback(openCount);
        }
        jsonResponse(res, 200, { success: true }, req);
        return;
      }

      // POST /annotations — create
      if (method === "POST" && path === "/annotations") {
        if (this.annotations.size >= MAX_ANNOTATIONS) {
          jsonResponse(res, 429, { error: `Maximum of ${MAX_ANNOTATIONS} annotations reached. Resolve or delete existing annotations first.` }, req);
          return;
        }

        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const now = new Date().toISOString();

        // Input validation
        const text = String(body.text ?? "");
        if (text.length > MAX_TEXT_LENGTH) {
          jsonResponse(res, 400, { error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, req);
          return;
        }
        if (typeof body.url !== "undefined" && typeof body.url !== "string") {
          jsonResponse(res, 400, { error: "url must be a string" }, req);
          return;
        }

        const viewport = body.viewport as { width?: number; height?: number } | undefined;
        const vw = Number(viewport?.width ?? 0);
        const vh = Number(viewport?.height ?? 0);
        if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw < 0 || vh < 0 || vw > MAX_VIEWPORT_DIM || vh > MAX_VIEWPORT_DIM) {
          jsonResponse(res, 400, { error: "Invalid viewport dimensions" }, req);
          return;
        }

        const reactSource = body.reactSource as { component?: string; source?: string } | undefined;
        const elementRect = body.elementRect as { x?: number; y?: number; width?: number; height?: number } | undefined;

        // Capture screenshot via CDP if we have a valid rect and a callback
        let screenshot: string | null = null;
        if (elementRect && this.screenshotCallback
          && Number(elementRect.width ?? 0) > 0 && Number(elementRect.height ?? 0) > 0) {
          try {
            screenshot = await this.screenshotCallback({
              x: Number(elementRect.x ?? 0),
              y: Number(elementRect.y ?? 0),
              width: Number(elementRect.width ?? 0),
              height: Number(elementRect.height ?? 0),
            });
          } catch (err) {
            console.error(`[relay-inspect] Screenshot capture failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        const annotation: Annotation = {
          id: randomUUID(),
          url: String(body.url ?? ""),
          selector: String(body.selector ?? ""),
          selectorConfidence: body.selectorConfidence === "stable" ? "stable" : "fragile",
          text,
          status: "open",
          viewport: { width: vw, height: vh },
          reactSource: reactSource?.component
            ? { component: String(reactSource.component), source: reactSource.source ? String(reactSource.source) : undefined }
            : null,
          screenshot,
          createdAt: now,
          updatedAt: now,
        };

        // Multi-element annotations (drag-select)
        if (Array.isArray(body.elements)) {
          annotation.elements = (body.elements as Record<string, unknown>[]).map((el) => {
            const elRect = el.elementRect as { x?: number; y?: number; width?: number; height?: number } | undefined;
            const elReact = el.reactSource as { component?: string; source?: string } | undefined;
            return {
              selector: String(el.selector ?? ""),
              selectorConfidence: el.selectorConfidence === "stable" ? "stable" : "fragile" as const,
              reactSource: elReact?.component
                ? { component: String(elReact.component), source: elReact.source ? String(elReact.source) : undefined }
                : null,
              elementRect: {
                x: Number(elRect?.x ?? 0),
                y: Number(elRect?.y ?? 0),
                width: Number(elRect?.width ?? 0),
                height: Number(elRect?.height ?? 0),
              },
            };
          });
        }

        const anchorPt = body.anchorPoint as { x?: number; y?: number } | undefined;
        if (anchorPt && anchorPt.x != null && anchorPt.y != null) {
          annotation.anchorPoint = { x: Number(anchorPt.x), y: Number(anchorPt.y) };
        }

        this.annotations.set(annotation.id, annotation);
        jsonResponse(res, 201, { id: annotation.id }, req);
        return;
      }

      // GET /annotations — list all
      if (method === "GET" && path === "/annotations") {
        jsonResponse(res, 200, Array.from(this.annotations.values()), req);
        return;
      }

      // Routes with :id
      const idMatch = path.match(/^\/annotations\/([^/]+)(\/resolve)?$/);
      if (idMatch) {
        const id = idMatch[1];
        const isResolve = idMatch[2] === "/resolve";

        // POST /annotations/:id/resolve
        if (method === "POST" && isResolve) {
          const ann = this.resolveAnnotation(id);
          if (!ann) {
            jsonResponse(res, 404, { error: "Annotation not found" }, req);
            return;
          }
          jsonResponse(res, 200, ann, req);
          return;
        }

        // PATCH /annotations/:id — update text
        if (method === "PATCH" && !isResolve) {
          const ann = this.annotations.get(id);
          if (!ann) {
            jsonResponse(res, 404, { error: "Annotation not found" }, req);
            return;
          }
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          if (typeof body.text === "string") {
            if (body.text.length > MAX_TEXT_LENGTH) {
              jsonResponse(res, 400, { error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, req);
              return;
            }
            ann.text = body.text;
          }
          ann.updatedAt = new Date().toISOString();
          jsonResponse(res, 200, ann, req);
          return;
        }

        // DELETE /annotations/:id
        if (method === "DELETE" && !isResolve) {
          const deleted = this.annotations.delete(id);
          if (!deleted) {
            jsonResponse(res, 404, { error: "Annotation not found" }, req);
            return;
          }
          jsonResponse(res, 200, { success: true }, req);
          return;
        }
      }

      // 404
      jsonResponse(res, 404, { error: "Not found" }, req);
    } catch (err) {
      console.error("[relay-inspect] Annotation server error:", err);
      jsonResponse(res, 500, { error: "Internal server error" }, req);
    }
  }
}

export const annotationServer = new AnnotationServer();

export function getAnnotationPort(): number | null {
  return annotationServer.getPort();
}
