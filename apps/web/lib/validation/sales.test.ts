import { describe, expect, it } from "vitest";
import { CreateSaleSchema, SaleItemSchema, isPartialPaymentInvalid } from "./sales";

const productId = () => crypto.randomUUID();

describe("SaleItemSchema quantity precision (mirrors the database's exact rule)", () => {
  const ACCEPTED = ["1", "1.0", "1.2", "1.23", "1.234", "0.001", "999.999"];
  const REJECTED = ["0", "-1", "1.2345", "0.0001", "abc", ""];

  it.each(ACCEPTED)("accepts quantity %s", (quantity) => {
    const result = SaleItemSchema.safeParse({ productId: productId(), quantity });
    expect(result.success, quantity).toBe(true);
  });

  it.each(REJECTED)("rejects quantity %s", (quantity) => {
    const result = SaleItemSchema.safeParse({ productId: productId(), quantity });
    expect(result.success, quantity).toBe(false);
  });

  it("never silently rounds excess precision — the parsed value for a rejected input is never produced", () => {
    const result = SaleItemSchema.safeParse({ productId: productId(), quantity: "1.2345" });
    expect(result.success).toBe(false);
  });

  it("requires a valid uuid productId", () => {
    const result = SaleItemSchema.safeParse({ productId: "not-a-uuid", quantity: "1" });
    expect(result.success).toBe(false);
  });
});

describe("CreateSaleSchema", () => {
  const base = {
    creationKey: crypto.randomUUID(),
    items: [{ productId: productId(), quantity: "1" }],
    paymentStatus: "UNPAID" as const,
  };

  it("accepts a minimal valid walk-in UNPAID sale", () => {
    const result = CreateSaleSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects an empty items array", () => {
    const result = CreateSaleSchema.safeParse({ ...base, items: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than MAX_SALE_ITEMS lines", () => {
    const items = Array.from({ length: 101 }, () => ({ productId: productId(), quantity: "1" }));
    const result = CreateSaleSchema.safeParse({ ...base, items });
    expect(result.success).toBe(false);
  });

  it("accepts exactly MAX_SALE_ITEMS lines", () => {
    const items = Array.from({ length: 100 }, () => ({ productId: productId(), quantity: "1" }));
    const result = CreateSaleSchema.safeParse({ ...base, items });
    expect(result.success).toBe(true);
  });

  it("client-side rejects duplicate product lines (server remains the actual defense)", () => {
    const dup = productId();
    const result = CreateSaleSchema.safeParse({
      ...base,
      items: [
        { productId: dup, quantity: "1" },
        { productId: dup, quantity: "2" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("the parsed item shape contains ONLY productId and quantity — never unitPrice/lineTotal/etc.", () => {
    const result = CreateSaleSchema.safeParse({
      ...base,
      items: [{ productId: productId(), quantity: "1", unitPrice: 999999 } as never],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.items[0]).sort()).toEqual(["productId", "quantity"]);
    }
  });

  describe("payment invariants (mirror the approved RPC canonicalization exactly)", () => {
    it("UNPAID with no payment method is valid", () => {
      const result = CreateSaleSchema.safeParse({ ...base, paymentStatus: "UNPAID" });
      expect(result.success).toBe(true);
    });

    it("UNPAID with a payment method is rejected", () => {
      const result = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "UNPAID",
        paymentMethod: "CASH",
      });
      expect(result.success).toBe(false);
    });

    it("PAID with a payment method is valid (amount_paid is server-derived, not required client-side)", () => {
      const result = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "PAID",
        paymentMethod: "CASH",
      });
      expect(result.success).toBe(true);
    });

    it("PAID without a payment method is rejected", () => {
      const result = CreateSaleSchema.safeParse({ ...base, paymentStatus: "PAID" });
      expect(result.success).toBe(false);
    });

    it("PARTIALLY_PAID requires both a payment method and a positive amountPaid", () => {
      const missingMethod = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "PARTIALLY_PAID",
        amountPaid: "500",
      });
      expect(missingMethod.success).toBe(false);

      const missingAmount = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "PARTIALLY_PAID",
        paymentMethod: "CASH",
      });
      expect(missingAmount.success).toBe(false);

      const valid = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "PARTIALLY_PAID",
        paymentMethod: "CASH",
        amountPaid: 500,
      });
      expect(valid.success).toBe(true);
    });

    it("rejects an invalid payment method enum value", () => {
      const result = CreateSaleSchema.safeParse({
        ...base,
        paymentStatus: "PAID",
        paymentMethod: "CRYPTO",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("money fields", () => {
    it("rejects a negative discount", () => {
      const result = CreateSaleSchema.safeParse({ ...base, discount: -1 });
      expect(result.success).toBe(false);
    });

    it("rejects a discount exceeding numeric(14,2)'s representable range", () => {
      const result = CreateSaleSchema.safeParse({ ...base, discount: 1e15 });
      expect(result.success).toBe(false);
    });

    it("accepts a discount at the exact numeric(14,2) maximum", () => {
      const result = CreateSaleSchema.safeParse({ ...base, discount: 999_999_999_999.99 });
      expect(result.success).toBe(true);
    });
  });

  it("rejects a malformed customerId", () => {
    const result = CreateSaleSchema.safeParse({ ...base, customerId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects notes longer than 2000 characters", () => {
    const result = CreateSaleSchema.safeParse({ ...base, notes: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });
});

// Codex round-3, the one remaining finding: SaleForm's partial-payment
// pre-submit guard was showing an error but not actually blocking
// submission. isPartialPaymentInvalid is the exact boolean SaleForm now
// uses both for the visible error state and to block submission (button
// disabled + a form onSubmit refusal), so this is the single source of
// truth for that boundary.
describe("isPartialPaymentInvalid (SaleForm's pre-submit guard, non-authoritative)", () => {
  const TOTAL = 100;

  it("blocks a zero amount", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "0", TOTAL)).toBe(true);
  });

  it("allows an amount just under the total", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "99.99", TOTAL)).toBe(false);
  });

  it("blocks an amount exactly equal to the total", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "100", TOTAL)).toBe(true);
  });

  it("blocks an amount just over the total", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "100.01", TOTAL)).toBe(true);
  });

  it("blocks an empty amount", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "", TOTAL)).toBe(true);
  });

  it("blocks a non-numeric amount", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "abc", TOTAL)).toBe(true);
  });

  it("blocks a negative amount", () => {
    expect(isPartialPaymentInvalid("PARTIALLY_PAID", "-5", TOTAL)).toBe(true);
  });

  it("is never invalid for UNPAID, regardless of the typed amount", () => {
    expect(isPartialPaymentInvalid("UNPAID", "0", TOTAL)).toBe(false);
    expect(isPartialPaymentInvalid("UNPAID", "100", TOTAL)).toBe(false);
    expect(isPartialPaymentInvalid("UNPAID", "", TOTAL)).toBe(false);
  });

  it("is never invalid for PAID, regardless of the typed amount", () => {
    expect(isPartialPaymentInvalid("PAID", "0", TOTAL)).toBe(false);
    expect(isPartialPaymentInvalid("PAID", "100", TOTAL)).toBe(false);
    expect(isPartialPaymentInvalid("PAID", "", TOTAL)).toBe(false);
  });
});
