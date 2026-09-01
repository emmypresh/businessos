import { describe, expect, it } from "vitest";
import { CreateInvoiceSchema, InvoiceItemSchema, RecordInvoicePaymentSchema } from "./invoices";

// Valid v4-shaped UUIDs (version nibble "4", variant nibble "a") — a
// naive all-same-digit string like "11111111-1111-1111-1111-111111111111"
// fails strict UUID validation (its variant nibble is "1", not one of
// 8/9/a/b), so every hand-written test id here is deliberately shaped to
// pass real UUID validation, not merely "look like" one.
const validBranchId = "11111111-1111-4111-a111-111111111111";
const validCustomerId = "22222222-2222-4222-a222-222222222222";
const validProductId = "33333333-3333-4333-a333-333333333333";
const validInvoiceId = "44444444-4444-4444-a444-444444444444";
const validKey = "55555555-5555-4555-a555-555555555555";

describe("InvoiceItemSchema", () => {
  it("accepts a product-linked line", () => {
    const result = InvoiceItemSchema.safeParse({ productId: validProductId, quantity: "2" });
    expect(result.success).toBe(true);
  });

  it("accepts a custom line with a description and unit price", () => {
    const result = InvoiceItemSchema.safeParse({ description: "Delivery fee", quantity: "1", unitPrice: "2500" });
    expect(result.success).toBe(true);
  });

  it("rejects a custom line missing a description", () => {
    const result = InvoiceItemSchema.safeParse({ quantity: "1", unitPrice: "2500" });
    expect(result.success).toBe(false);
  });

  it("rejects a custom line missing a unit price", () => {
    const result = InvoiceItemSchema.safeParse({ description: "Delivery fee", quantity: "1" });
    expect(result.success).toBe(false);
  });

  it("rejects a quantity with more than 3 decimal places — never silently rounded", () => {
    const result = InvoiceItemSchema.safeParse({ productId: validProductId, quantity: "1.2345" });
    expect(result.success).toBe(false);
  });

  it("rejects a zero or negative quantity", () => {
    expect(InvoiceItemSchema.safeParse({ productId: validProductId, quantity: "0" }).success).toBe(false);
    expect(InvoiceItemSchema.safeParse({ productId: validProductId, quantity: "-1" }).success).toBe(false);
  });

  // Codex adversarial review, remediation round 1, Medium 1: a custom
  // line's unitPrice must be REJECTED outright when it carries more than
  // 2 decimal places — never silently rounded (1.999 must never become
  // 2.00). Exact vectors from the review itself.
  describe("unitPrice precision (Medium 1)", () => {
    it.each(["0.01", "1", "1.5", "1.50", "1.99"])("accepts %s", (unitPrice) => {
      const result = InvoiceItemSchema.safeParse({ description: "Custom line", quantity: "1", unitPrice });
      expect(result.success).toBe(true);
    });

    it.each(["1.999", "0.005", "100.001"])("rejects %s — never silently rounded", (unitPrice) => {
      const result = InvoiceItemSchema.safeParse({ description: "Custom line", quantity: "1", unitPrice });
      expect(result.success).toBe(false);
    });

    it("rejects a non-numeric-string unitPrice (JS coercion tricks don't apply — this is a string-first regex, never Number() first)", () => {
      expect(InvoiceItemSchema.safeParse({ description: "Custom line", quantity: "1", unitPrice: "1e2" }).success).toBe(false);
    });
  });
});

describe("CreateInvoiceSchema", () => {
  const base = {
    creationKey: validKey,
    customerId: validCustomerId,
    branchId: validBranchId,
    items: [{ productId: validProductId, quantity: "1" }],
  };

  it("accepts a well-formed request", () => {
    expect(CreateInvoiceSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a malformed customerId — never reaches Postgres as a raw value", () => {
    expect(CreateInvoiceSchema.safeParse({ ...base, customerId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a malformed branchId", () => {
    expect(CreateInvoiceSchema.safeParse({ ...base, branchId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an empty items array", () => {
    expect(CreateInvoiceSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });

  it("rejects two lines referencing the same product", () => {
    const result = CreateInvoiceSchema.safeParse({
      ...base,
      items: [
        { productId: validProductId, quantity: "1" },
        { productId: validProductId, quantity: "2" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows two custom lines even with identical descriptions — only product duplicates are rejected", () => {
    const result = CreateInvoiceSchema.safeParse({
      ...base,
      items: [
        { description: "Delivery fee", quantity: "1", unitPrice: "1000" },
        { description: "Delivery fee", quantity: "1", unitPrice: "1000" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an omitted due date and notes", () => {
    expect(CreateInvoiceSchema.safeParse(base).success).toBe(true);
  });
});

describe("RecordInvoicePaymentSchema", () => {
  const base = {
    creationKey: validKey,
    invoiceId: validInvoiceId,
    amount: "5000",
    paymentMethod: "CASH",
    paidAt: new Date().toISOString(),
  };

  it("accepts a well-formed payment", () => {
    expect(RecordInvoicePaymentSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a malformed invoiceId", () => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, invoiceId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a zero or negative amount", () => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, amount: "-1" }).success).toBe(false);
  });

  it("rejects an amount with more than 2 decimal places", () => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, amount: "5000.123" }).success).toBe(false);
  });

  // Codex adversarial review, remediation round 1, Medium 1: exact
  // vectors from the review itself.
  it.each(["0.01", "1", "1.5", "1.50", "1.99"])("accepts amount %s", (amount) => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, amount }).success).toBe(true);
  });

  it.each(["1.999", "0.005", "100.001"])("rejects amount %s — never silently rounded", (amount) => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, amount }).success).toBe(false);
  });

  it("rejects an invalid payment method", () => {
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, paymentMethod: "CRYPTO" }).success).toBe(false);
  });

  it("rejects a paidAt more than a day in the future", () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt: future }).success).toBe(false);
  });

  // Codex adversarial review, remediation round 2, Medium 2: paidAt must
  // be an EXPLICIT, offset-bearing instant only — a bare "wall clock"
  // string (no `Z`, no numeric offset) is rejected here, at the schema
  // boundary, before it can ever reach record_invoice_payment and be
  // interpreted against whatever timezone the DATABASE session happens
  // to run in. Exact vectors from the review itself.
  describe("paidAt: explicit offset-bearing instant only", () => {
    it.each([
      "2026-08-31T14:30:00.000Z",
      "2026-08-31T15:30:00+01:00",
      "2026-08-31T15:30:00.123+01:00",
    ])("accepts %s", (paidAt) => {
      expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt }).success).toBe(true);
    });

    it.each([
      "2026-08-31T15:30",
      "2026-08-31T15:30:00",
      "2026-08-31",
      "15:30",
      "random text",
    ])("rejects %s — timezone-less or malformed, never reaches the DB", (paidAt) => {
      expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt }).success).toBe(false);
    });
  });

  // Codex adversarial review, remediation round 3 ("Semantically Invalid
  // ISO Calendar Dates"): an offset-bearing SHAPE is not enough — the
  // calendar date itself must be real. `Date.parse` alone would silently
  // normalize "2026-02-30T15:30:00Z" into March 2nd rather than reject
  // it, letting it reach record_invoice_payment and fail late with a raw
  // SQLSTATE 22008. Exact vectors from the review itself.
  describe("paidAt: semantically real calendar dates only (never JS Date normalization)", () => {
    it.each(["2024-02-29T12:00:00Z", "2026-08-31T14:30:00.000Z", "2026-08-31T15:30:00+01:00"])(
      "accepts %s",
      (paidAt) => {
        expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt }).success).toBe(true);
      }
    );

    it.each([
      "2026-02-30T15:30:00Z", // February never has a 30th
      "2026-02-29T15:30:00Z", // 2026 is not a leap year
      "2026-04-31T15:30:00Z", // April has only 30 days
      "2026-13-01T15:30:00Z", // month 13 does not exist
      "2026-01-32T15:30:00Z", // January has only 31 days
      "2026-08-31T24:00:00Z", // hour 24 does not exist
      "2026-08-31T23:60:00Z", // minute 60 does not exist
      "2026-08-31T23:59:60Z", // no leap-second support
    ])("rejects %s — an impossible calendar date, never silently normalized", (paidAt) => {
      expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt }).success).toBe(false);
    });

    it("leap year: 2000-02-29 is valid, 2100-02-29 is invalid", () => {
      expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt: "2000-02-29T12:00:00Z" }).success).toBe(true);
      expect(RecordInvoicePaymentSchema.safeParse({ ...base, paidAt: "2100-02-29T12:00:00Z" }).success).toBe(false);
    });
  });

  it("accepts an omitted reference and note", () => {
    expect(RecordInvoicePaymentSchema.safeParse(base).success).toBe(true);
  });
});
