import { describe, it, expect } from "vitest";
import { CircularBuffer, parseIntWithDefault } from "./cdp-client.js";

describe("CircularBuffer", () => {
  it("pushes and peeks items", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.peek()).toEqual([1, 2]);
    expect(buf.length).toBe(2);
  });

  it("drain returns items and clears buffer", () => {
    const buf = new CircularBuffer<string>(5);
    buf.push("a");
    buf.push("b");
    expect(buf.drain()).toEqual(["a", "b"]);
    expect(buf.length).toBe(0);
    expect(buf.peek()).toEqual([]);
  });

  it("evicts oldest items when full", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.peek()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it("peek does not modify buffer", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.peek();
    buf.peek();
    expect(buf.length).toBe(1);
  });

  it("peek returns a copy, not a reference", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    const peeked = buf.peek();
    peeked.push(99);
    expect(buf.peek()).toEqual([1]);
  });

  it("allows new items after draining", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.drain();
    buf.push(2);
    expect(buf.peek()).toEqual([2]);
  });

  it("maintains FIFO order under continuous overflow", () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 0; i < 100; i++) {
      buf.push(i);
    }
    expect(buf.length).toBe(3);
    expect(buf.peek()).toEqual([97, 98, 99]);
  });

  it("works with complex objects", () => {
    const buf = new CircularBuffer<{ id: number; msg: string }>(2);
    buf.push({ id: 1, msg: "first" });
    buf.push({ id: 2, msg: "second" });
    buf.push({ id: 3, msg: "third" });
    const items = buf.drain();
    expect(items).toEqual([
      { id: 2, msg: "second" },
      { id: 3, msg: "third" },
    ]);
  });

  it("works with size of 1", () => {
    const buf = new CircularBuffer<string>(1);
    buf.push("a");
    buf.push("b");
    expect(buf.peek()).toEqual(["b"]);
  });

  describe("drainWhere", () => {
    it("drains only matching items", () => {
      const buf = new CircularBuffer<number>(10);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);

      const evens = buf.drainWhere((n) => n % 2 === 0);
      expect(evens).toEqual([2, 4]);
      expect(buf.peek()).toEqual([1, 3, 5]);
      expect(buf.length).toBe(3);
    });

    it("returns empty array when nothing matches", () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(3);
      buf.push(5);

      const evens = buf.drainWhere((n) => n % 2 === 0);
      expect(evens).toEqual([]);
      expect(buf.peek()).toEqual([1, 3, 5]);
    });

    it("drains everything when all items match", () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(2);
      buf.push(4);
      buf.push(6);

      const evens = buf.drainWhere((n) => n % 2 === 0);
      expect(evens).toEqual([2, 4, 6]);
      expect(buf.length).toBe(0);
    });

    it("returns empty array on empty buffer", () => {
      const buf = new CircularBuffer<number>(5);
      const result = buf.drainWhere(() => true);
      expect(result).toEqual([]);
      expect(buf.length).toBe(0);
    });
  });
});

describe("parseIntWithDefault", () => {
  it("returns parsed integer for valid string", () => {
    expect(parseIntWithDefault("42", 10)).toBe(42);
  });

  it("returns default for undefined", () => {
    expect(parseIntWithDefault(undefined, 10)).toBe(10);
  });

  it("returns default for NaN-producing string", () => {
    expect(parseIntWithDefault("not-a-number", 10)).toBe(10);
  });

  it("returns default for empty string", () => {
    expect(parseIntWithDefault("", 10)).toBe(10);
  });

  it("parses leading digits from mixed strings", () => {
    expect(parseIntWithDefault("123abc", 10)).toBe(123);
  });
});
