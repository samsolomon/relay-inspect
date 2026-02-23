import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AnnotationServer, isAllowedOrigin } from "./annotationServer.js";

// --- CORS origin validation ---

describe("isAllowedOrigin", () => {
  it("allows http://localhost", () => {
    expect(isAllowedOrigin("http://localhost")).toBe("http://localhost");
  });

  it("allows http://localhost:5173", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("allows https://localhost:3000", () => {
    expect(isAllowedOrigin("https://localhost:3000")).toBe("https://localhost:3000");
  });

  it("allows http://127.0.0.1", () => {
    expect(isAllowedOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
  });

  it("allows http://127.0.0.1:8080", () => {
    expect(isAllowedOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("allows http://[::1]", () => {
    expect(isAllowedOrigin("http://[::1]")).toBe("http://[::1]");
  });

  it("rejects external origin", () => {
    expect(isAllowedOrigin("https://evil.com")).toBeNull();
  });

  it("rejects non-http protocol", () => {
    expect(isAllowedOrigin("ftp://localhost")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(isAllowedOrigin(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(isAllowedOrigin("")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(isAllowedOrigin("not-a-url")).toBeNull();
  });

  it("rejects file:// protocol", () => {
    expect(isAllowedOrigin("file:///etc/passwd")).toBeNull();
  });

  it("rejects localhost-like subdomains on external hosts", () => {
    expect(isAllowedOrigin("http://localhost.evil.com")).toBeNull();
  });
});

// --- HTTP handler tests ---

describe("AnnotationServer HTTP", () => {
  let server: AnnotationServer;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    server = new AnnotationServer();
    port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it("returns health check", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.count).toBe("number");
  });

  it("creates an annotation via POST", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "http://localhost:3000",
        selector: ".btn",
        text: "Fix this button",
        viewport: { width: 1920, height: 1080 },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
  });

  it("lists annotations via GET", async () => {
    const res = await fetch(`${baseUrl}/annotations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("updates annotation text via PATCH", async () => {
    // Create one first
    const createRes = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "original", viewport: { width: 800, height: 600 } }),
    });
    const { id } = await createRes.json();

    const patchRes = await fetch(`${baseUrl}/annotations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "updated" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.text).toBe("updated");
  });

  it("deletes annotation via DELETE", async () => {
    const createRes = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "to delete", viewport: { width: 800, height: 600 } }),
    });
    const { id } = await createRes.json();

    const deleteRes = await fetch(`${baseUrl}/annotations/${id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    // Verify it's gone
    const deleteAgain = await fetch(`${baseUrl}/annotations/${id}`, { method: "DELETE" });
    expect(deleteAgain.status).toBe(404);
  });

  it("bulk-deletes all annotations via DELETE /annotations", async () => {
    // Create a few annotations
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `bulk-${i}`, viewport: { width: 800, height: 600 } }),
      });
    }

    // Verify they exist
    const before = await fetch(`${baseUrl}/annotations`);
    const beforeBody = await before.json();
    expect(beforeBody.length).toBeGreaterThanOrEqual(3);

    // Bulk delete
    const deleteRes = await fetch(`${baseUrl}/annotations`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);
    expect(deleteBody.deleted).toBeGreaterThanOrEqual(3);

    // Verify all are gone
    const after = await fetch(`${baseUrl}/annotations`);
    const afterBody = await after.json();
    expect(afterBody.length).toBe(0);
  });

  it("bulk-delete on empty collection returns deleted: 0", async () => {
    const deleteRes = await fetch(`${baseUrl}/annotations`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(0);
  });

  it("returns 404 for unknown annotation ID", async () => {
    const res = await fetch(`${baseUrl}/annotations/nonexistent-id`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects text that is too long", async () => {
    const longText = "x".repeat(10 * 1024 + 1);
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, viewport: { width: 800, height: 600 } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Text exceeds/);
  });

  it("rejects invalid viewport dimensions", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ok", viewport: { width: -1, height: 600 } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/viewport/i);
  });

  it("rejects viewport dimensions exceeding max", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ok", viewport: { width: 200000, height: 600 } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects text too long on PATCH", async () => {
    const createRes = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "short", viewport: { width: 800, height: 600 } }),
    });
    const { id } = await createRes.json();

    const longText = "y".repeat(10 * 1024 + 1);
    const patchRes = await fetch(`${baseUrl}/annotations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText }),
    });
    expect(patchRes.status).toBe(400);
  });

  it("includes Vary: Origin header", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("reflects localhost origin in CORS header", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("responds to OPTIONS preflight", async () => {
    const res = await fetch(`${baseUrl}/annotations`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("defaults selectorConfidence to fragile for unknown values", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "test",
        selectorConfidence: "unknown",
        viewport: { width: 800, height: 600 },
      }),
    });
    const { id } = await res.json();
    expect(server.getAnnotation(id)?.selectorConfidence).toBe("fragile");
  });

  it("stores reactSource when provided", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "test",
        viewport: { width: 800, height: 600 },
        reactSource: { component: "Button", source: "Button.tsx:42" },
      }),
    });
    const { id } = await res.json();
    expect(server.getAnnotation(id)?.reactSource).toEqual({
      component: "Button",
      source: "Button.tsx:42",
    });
  });

  it("stores null reactSource when not provided", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test", viewport: { width: 800, height: 600 } }),
    });
    const { id } = await res.json();
    expect(server.getAnnotation(id)?.reactSource).toBeNull();
  });

  it("stores multi-element annotations with anchorPoint", async () => {
    const res = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "multi",
        viewport: { width: 800, height: 600 },
        elements: [
          { selector: ".a", selectorConfidence: "stable", elementRect: { x: 0, y: 0, width: 10, height: 10 } },
          { selector: ".b", selectorConfidence: "fragile", elementRect: { x: 20, y: 20, width: 10, height: 10 } },
        ],
        anchorPoint: { x: 50, y: 50 },
      }),
    });
    const { id } = await res.json();
    const ann = server.getAnnotation(id)!;
    expect(ann.elements).toHaveLength(2);
    expect(ann.anchorPoint).toEqual({ x: 50, y: 50 });
  });

  it("resolves annotation via POST /:id/resolve", async () => {
    const createRes = await fetch(`${baseUrl}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "to resolve", viewport: { width: 800, height: 600 } }),
    });
    const { id } = await createRes.json();

    const resolveRes = await fetch(`${baseUrl}/annotations/${id}/resolve`, { method: "POST" });
    expect(resolveRes.status).toBe(200);
    const body = await resolveRes.json();
    expect(body.status).toBe("resolved");
  });

  it("resolve returns 404 for missing annotation", async () => {
    const res = await fetch(`${baseUrl}/annotations/nonexistent/resolve`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// --- Annotation cap tests ---

describe("Annotation cap", () => {
  let srv: AnnotationServer;
  let port: number;
  let url: string;

  beforeAll(async () => {
    srv = new AnnotationServer();
    process.env.ANNOTATION_PORT = "19225";
    try {
      port = await srv.start();
    } finally {
      delete process.env.ANNOTATION_PORT;
    }
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await srv.shutdown();
  });

  it("rejects creation after 50 annotations and allows after deletion", async () => {
    // Create 50 annotations
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${url}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `ann-${i}`, viewport: { width: 800, height: 600 } }),
      });
      expect(res.status).toBe(201);
      const { id } = await res.json();
      ids.push(id);
    }

    // 51st should be rejected with 429
    const rejected = await fetch(`${url}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "overflow", viewport: { width: 800, height: 600 } }),
    });
    expect(rejected.status).toBe(429);

    // Delete one, then creating should succeed again
    const delRes = await fetch(`${url}/annotations/${ids[0]}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const afterDelete = await fetch(`${url}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "after-delete", viewport: { width: 800, height: 600 } }),
    });
    expect(afterDelete.status).toBe(201);
  });
});

// --- consumeSentState tests ---

describe("consumeSentState", () => {
  it("returns false when no send has been triggered", () => {
    const srv = new AnnotationServer();
    expect(srv.consumeSentState()).toBe(false);
  });

  it("returns true after send is triggered, then false on second call", async () => {
    const srv = new AnnotationServer();
    // Use a high port to avoid conflicts with the other describe block's server
    process.env.ANNOTATION_PORT = "19223";
    let port: number;
    try {
      port = await srv.start();
    } finally {
      delete process.env.ANNOTATION_PORT;
    }

    // Trigger a send via HTTP
    await fetch(`http://127.0.0.1:${port}/annotations/send`, { method: "POST" });

    expect(srv.consumeSentState()).toBe(true);
    expect(srv.consumeSentState()).toBe(false);

    await srv.shutdown();
  });
});

// --- waitForSend tests ---

describe("waitForSend", () => {
  it("resolves immediately if send was latched", async () => {
    const srv = new AnnotationServer();
    process.env.ANNOTATION_PORT = "19224";
    let port: number;
    try {
      port = await srv.start();
    } finally {
      delete process.env.ANNOTATION_PORT;
    }

    // Trigger send (latches because no waiter is active)
    await fetch(`http://127.0.0.1:${port}/annotations/send`, { method: "POST" });

    const result = await srv.waitForSend(5000);
    expect(result.triggered).toBe(true);

    await srv.shutdown();
  });

  it("times out when no send occurs", async () => {
    const srv = new AnnotationServer();
    const result = await srv.waitForSend(50);
    expect(result.triggered).toBe(false);
  });
});

// --- Direct method tests ---

describe("AnnotationServer methods", () => {
  it("resolveAnnotation returns undefined for missing id", () => {
    const srv = new AnnotationServer();
    expect(srv.resolveAnnotation("nonexistent")).toBeUndefined();
  });

  it("deleteAnnotation returns false for missing id", () => {
    const srv = new AnnotationServer();
    expect(srv.deleteAnnotation("nonexistent")).toBe(false);
  });
});
