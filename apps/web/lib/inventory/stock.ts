/**
 * Stock-state classification, applied identically everywhere a stock
 * badge is rendered (product list, product detail, inventory overview) —
 * one function, not three copies that could drift.
 *
 * `track_inventory = false` is NEVER represented as zero stock — a
 * non-tracked (service) item has no stock concept at all, which is a
 * different fact from "we tracked it and it happens to be zero."
 */

export const STOCK_STATE = {
  NOT_TRACKED: "not_tracked",
  OUT_OF_STOCK: "out_of_stock",
  LOW_STOCK: "low_stock",
  IN_STOCK: "in_stock",
} as const;

export type StockState = (typeof STOCK_STATE)[keyof typeof STOCK_STATE];

export function getStockState(
  trackInventory: boolean,
  quantity: number,
  lowStockThreshold: number | null
): StockState {
  if (!trackInventory) return STOCK_STATE.NOT_TRACKED;
  if (quantity === 0) return STOCK_STATE.OUT_OF_STOCK;
  if (lowStockThreshold !== null && quantity <= lowStockThreshold) {
    return STOCK_STATE.LOW_STOCK;
  }
  return STOCK_STATE.IN_STOCK;
}

export const STOCK_STATE_LABEL: Record<StockState, string> = {
  [STOCK_STATE.NOT_TRACKED]: "Not tracked",
  [STOCK_STATE.OUT_OF_STOCK]: "Out of stock",
  [STOCK_STATE.LOW_STOCK]: "Low stock",
  [STOCK_STATE.IN_STOCK]: "In stock",
};
