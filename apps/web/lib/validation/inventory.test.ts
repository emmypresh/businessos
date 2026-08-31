import { describe, expect, it } from "vitest";
import { StockAdjustmentSchema, HistoryFilterSchema } from "./inventory";

const validKey = "22222222-2222-4222-8222-222222222222";
const validProductId = "33333333-3333-4333-8333-333333333333";
const validBranchId = "44444444-4444-4444-8444-444444444444";

describe("StockAdjustmentSchema", () => {
  it("accepts a valid increase", () => {
    const result = StockAdjustmentSchema.safeParse({
      idempotencyKey: validKey,
      productId: validProductId,
      branchId: validBranchId,
      direction: "increase",
      quantity: 10,
      reason: "Found extra stock",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a zero or negative quantity", () => {
    for (const quantity of [0, -1]) {
      const result = StockAdjustmentSchema.safeParse({
        idempotencyKey: validKey,
        productId: validProductId,
        branchId: validBranchId,
        direction: "decrease",
        quantity,
        reason: "Bad quantity",
      });
      expect(result.success, `quantity=${quantity}`).toBe(false);
    }
  });

  it("rejects a reason shorter than 3 characters", () => {
    expect(
      StockAdjustmentSchema.safeParse({
        idempotencyKey: validKey,
        productId: validProductId,
        branchId: validBranchId,
        direction: "increase",
        quantity: 1,
        reason: "ab",
      }).success
    ).toBe(false);
  });

  it("rejects an invalid direction", () => {
    expect(
      StockAdjustmentSchema.safeParse({
        idempotencyKey: validKey,
        productId: validProductId,
        branchId: validBranchId,
        direction: "sideways",
        quantity: 1,
        reason: "abc",
      }).success
    ).toBe(false);
  });

  it("rejects a non-uuid idempotencyKey", () => {
    expect(
      StockAdjustmentSchema.safeParse({
        idempotencyKey: "not-a-uuid",
        productId: validProductId,
        branchId: validBranchId,
        direction: "increase",
        quantity: 1,
        reason: "abc",
      }).success
    ).toBe(false);
  });

  // Phase 1G, Codex adversarial review application-layer round 2, Blocker
  // 5: branchId is deliberately OPTIONAL at this validation boundary — a
  // legacy caller of adjustStock that never sends it at all must still
  // reach record_inventory_movement's own approved legacy-default-location
  // compatibility alias, never be rejected here before the RPC runs.
  it("accepts a missing branchId — the legacy calling shape remains valid at this layer", () => {
    expect(
      StockAdjustmentSchema.safeParse({
        idempotencyKey: validKey,
        productId: validProductId,
        direction: "increase",
        quantity: 1,
        reason: "abc",
      }).success
    ).toBe(true);
  });

  it("rejects a non-uuid branchId", () => {
    expect(
      StockAdjustmentSchema.safeParse({
        idempotencyKey: validKey,
        productId: validProductId,
        branchId: "not-a-uuid",
        direction: "increase",
        quantity: 1,
        reason: "abc",
      }).success
    ).toBe(false);
  });
});

describe("HistoryFilterSchema", () => {
  it("accepts empty filters", () => {
    expect(HistoryFilterSchema.safeParse({}).success).toBe(true);
  });
});
