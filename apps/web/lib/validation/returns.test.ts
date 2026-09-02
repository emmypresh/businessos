import { describe, expect, it } from "vitest";
import {
  RefundAmountSchema,
  ReturnQuantitySchema,
  ReturnItemSchema,
  CreateSaleReturnSchema,
} from "./returns";

describe("RefundAmountSchema", () => {
  it.each(["0", "0.01", "1", "1.5", "1.50", "100.25"])("accepts %s", (value) => {
    expect(RefundAmountSchema.safeParse(value).success).toBe(true);
  });

  it.each(["0.005", "1.999", "-1", "1e5", "abc", ""])("rejects %s", (value) => {
    expect(RefundAmountSchema.safeParse(value).success).toBe(false);
  });
});

describe("ReturnQuantitySchema", () => {
  it.each(["1", "1.5", "1.25", "1.125"])("accepts %s", (value) => {
    expect(ReturnQuantitySchema.safeParse(value).success).toBe(true);
  });

  it.each(["0", "-1", "1.0001", "1e5", "abc", ""])("rejects %s", (value) => {
    expect(ReturnQuantitySchema.safeParse(value).success).toBe(false);
  });
});

describe("ReturnItemSchema", () => {
  const validSaleItemId = crypto.randomUUID();

  it("accepts a well-formed item", () => {
    const result = ReturnItemSchema.safeParse({ saleItemId: validSaleItemId, quantity: "2", restock: true });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field (strict boundary)", () => {
    const result = ReturnItemSchema.safeParse({
      saleItemId: validSaleItemId,
      quantity: "2",
      restock: true,
      productNameSnapshot: "Forged",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed saleItemId", () => {
    const result = ReturnItemSchema.safeParse({ saleItemId: "not-a-uuid", quantity: "2", restock: true });
    expect(result.success).toBe(false);
  });
});

describe("CreateSaleReturnSchema", () => {
  const base = {
    creationKey: crypto.randomUUID(),
    saleId: crypto.randomUUID(),
    items: [{ saleItemId: crypto.randomUUID(), quantity: "1", restock: true }],
  };

  it("accepts a zero-refund return with no refund method", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "0" });
    expect(result.success).toBe(true);
  });

  it("rejects a positive refund amount with no refund method", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "50" });
    expect(result.success).toBe(false);
  });

  it("rejects a zero refund amount WITH a refund method set", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "0", refundMethod: "CASH" });
    expect(result.success).toBe(false);
  });

  it("accepts a positive refund amount with a valid refund method", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "50", refundMethod: "CASH" });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate sale_item_id lines", () => {
    const result = CreateSaleReturnSchema.safeParse({
      ...base,
      refundAmount: "0",
      items: [...base.items, ...base.items],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level field (strict boundary)", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "0", productId: "forged" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reason enum value", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "0", reason: "NOT_A_REASON" });
    expect(result.success).toBe(false);
  });

  it("rejects notes longer than 2000 characters", () => {
    const result = CreateSaleReturnSchema.safeParse({ ...base, refundAmount: "0", notes: "a".repeat(2001) });
    expect(result.success).toBe(false);
  });
});
