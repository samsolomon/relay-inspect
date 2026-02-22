import { describe, it, expect } from "vitest";
import { CircularBuffer } from "./cdp-client.js";

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
