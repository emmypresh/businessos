import { describe, expect, it, vi } from "vitest";
import { parseCostValue } from "./cost";

describe("parseCostValue", () => {
  it("accepts a finite number", () => {
    expect(parseCostValue(1234.56)).toBe(1234.56);
    expect(parseCostValue(0)).toBe(0);
  });

  it("accepts null", () => {
    expect(parseCostValue(null)).toBeNull();
  });

  it("rejects a string, logging but not throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCostValue("1234.56")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCostValue({ cost: 1234.56 })).toBeNull();
    spy.mockRestore();
  });

  it("rejects an array", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCostValue([1234.56])).toBeNull();
    spy.mockRestore();
  });

  it("rejects a boolean", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCostValue(true)).toBeNull();
    spy.mockRestore();
  });

  it("rejects a non-finite number (NaN/Infinity cannot occur from real jsonb, but the guard must still hold)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseCostValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseCostValue(Number.NaN)).toBeNull();
    spy.mockRestore();
  });

  it("never throws for any rejected input", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseCostValue("bad" as never)).not.toThrow();
    spy.mockRestore();
  });
});
