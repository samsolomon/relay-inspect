import { describe, expect, it } from "vitest";
import { chooseDefaultTarget, isInternalTargetUrl, type PageTarget } from "./cdp-client.js";

function page(id: string, url: string): PageTarget {
  return { id, url, title: id, type: "page" };
}

describe("CDP target selection", () => {
  it("flags internal Chrome URLs", () => {
    expect(isInternalTargetUrl("chrome://newtab/")).toBe(true);
    expect(isInternalTargetUrl("devtools://devtools/bundled/inspector.html")).toBe(true);
    expect(isInternalTargetUrl("chrome-extension://abc123/index.html")).toBe(true);
    expect(isInternalTargetUrl("about:blank")).toBe(true);
    expect(isInternalTargetUrl("http://localhost:5173")).toBe(false);
  });

  it("prefers localhost HTTP pages over internal pages", () => {
    const selected = chooseDefaultTarget([
      page("1", "chrome://newtab/"),
      page("2", "http://example.com"),
      page("3", "http://localhost:5173"),
    ]);

    expect(selected?.id).toBe("3");
  });

  it("prefers non-internal non-http page over internal page", () => {
    const selected = chooseDefaultTarget([
      page("1", "chrome://newtab/"),
      page("2", "file:///tmp/index.html"),
    ]);

    expect(selected?.id).toBe("2");
  });

  it("falls back to first target when only internal pages exist", () => {
    const selected = chooseDefaultTarget([
      page("1", "chrome://newtab/"),
      page("2", "about:blank"),
    ]);

    expect(selected?.id).toBe("1");
  });
});
