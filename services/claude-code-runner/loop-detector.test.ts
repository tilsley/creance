import { describe, expect, test } from "bun:test";
import { LoopDetector, toolSignature } from "./loop-detector";

describe("toolSignature", () => {
  test("is stable across object key ordering", () => {
    expect(toolSignature("edit", { a: 1, b: 2 })).toBe(toolSignature("edit", { b: 2, a: 1 }));
  });

  test("distinguishes name, input, and nesting", () => {
    expect(toolSignature("edit", { path: "x" })).not.toBe(toolSignature("read", { path: "x" }));
    expect(toolSignature("edit", { path: "x" })).not.toBe(toolSignature("edit", { path: "y" }));
    expect(toolSignature("t", { a: { b: 1 } })).not.toBe(toolSignature("t", { a: { b: 2 } }));
  });
});

describe("LoopDetector", () => {
  test("trips on N consecutive identical calls", () => {
    const d = new LoopDetector(3);
    expect(d.record("bash", { cmd: "go test" })).toBeUndefined();
    expect(d.record("bash", { cmd: "go test" })).toBeUndefined();
    const reason = d.record("bash", { cmd: "go test" });
    expect(reason).toContain("loop detected");
    expect(reason).toContain("bash");
    expect(reason).toContain("3×");
  });

  test("does NOT trip on the same tool with different inputs (healthy progress)", () => {
    const d = new LoopDetector(3);
    for (let i = 0; i < 10; i++) {
      expect(d.record("bash", { cmd: `step ${i}` })).toBeUndefined();
    }
  });

  test("resets the streak when a different call interrupts it", () => {
    const d = new LoopDetector(3);
    d.record("read", { path: "a" });
    d.record("read", { path: "a" });
    expect(d.record("read", { path: "b" })).toBeUndefined(); // interruption resets
    expect(d.record("read", { path: "b" })).toBeUndefined();
    expect(d.record("read", { path: "b" })).toContain("loop detected"); // new streak trips
  });

  test("keeps reporting once tripped", () => {
    const d = new LoopDetector(2);
    d.record("x", {});
    expect(d.record("x", {})).toContain("loop detected");
    expect(d.record("x", {})).toContain("loop detected");
  });

  test("rejects a nonsensical threshold", () => {
    expect(() => new LoopDetector(1)).toThrow();
  });
});
