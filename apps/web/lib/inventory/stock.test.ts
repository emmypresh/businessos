import { describe, expect, it } from "vitest";
import { getStockState, STOCK_STATE } from "./stock";

describe("getStockState", () => {
  it("track_inventory = false is Not tracked, regardless of quantity/threshold", () => {
    expect(getStockState(false, 0, null)).toBe(STOCK_STATE.NOT_TRACKED);
    expect(getStockState(false, 50, 10)).toBe(STOCK_STATE.NOT_TRACKED);
    expect(getStockState(false, 0, 0)).toBe(STOCK_STATE.NOT_TRACKED);
  });

  it("tracked + quantity = 0 is Out of stock, even with a null threshold", () => {
    expect(getStockState(true, 0, null)).toBe(STOCK_STATE.OUT_OF_STOCK);
    expect(getStockState(true, 0, 10)).toBe(STOCK_STATE.OUT_OF_STOCK);
  });

  it("a null threshold never triggers Low stock for a nonzero quantity", () => {
    expect(getStockState(true, 1, null)).toBe(STOCK_STATE.IN_STOCK);
    expect(getStockState(true, 1000, null)).toBe(STOCK_STATE.IN_STOCK);
  });

  it("quantity <= threshold (and > 0) is Low stock", () => {
    expect(getStockState(true, 5, 5)).toBe(STOCK_STATE.LOW_STOCK);
    expect(getStockState(true, 3, 5)).toBe(STOCK_STATE.LOW_STOCK);
  });

  it("quantity > threshold is In stock", () => {
    expect(getStockState(true, 6, 5)).toBe(STOCK_STATE.IN_STOCK);
  });

  it("quantity = 0 with threshold = 0 is Out of stock, not Low stock (the 0-quantity rule takes precedence)", () => {
    expect(getStockState(true, 0, 0)).toBe(STOCK_STATE.OUT_OF_STOCK);
  });
});
