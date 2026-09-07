import { describe, expect, it } from "vitest";
import { derivePaystackEventKey, WebhookEnvelopeSchema, sha256Hex } from "./webhook-events";

describe("derivePaystackEventKey", () => {
  it("is deterministic across repeated calls with the SAME charge.success payload", () => {
    const data = { id: 12345, reference: "ref_abc", amount: 150000, currency: "NGN", customer: {} };
    const key1 = derivePaystackEventKey("charge.success", data);
    const key2 = derivePaystackEventKey("charge.success", data);
    expect(key1).toBe(key2);
    expect(key1).toBeTruthy();
  });

  it("is DISTINCT for two genuinely different charge.success events", () => {
    const key1 = derivePaystackEventKey("charge.success", {
      id: 1,
      reference: "ref_1",
      amount: 100,
      currency: "NGN",
      customer: {},
    });
    const key2 = derivePaystackEventKey("charge.success", {
      id: 2,
      reference: "ref_2",
      amount: 100,
      currency: "NGN",
      customer: {},
    });
    expect(key1).not.toBe(key2);
  });

  it("derives a distinct key per subscription.create subscription_code", () => {
    const key1 = derivePaystackEventKey("subscription.create", { subscription_code: "SUB_1" });
    const key2 = derivePaystackEventKey("subscription.create", { subscription_code: "SUB_2" });
    expect(key1).not.toBe(key2);
    expect(key1).toBe(derivePaystackEventKey("subscription.create", { subscription_code: "SUB_1" }));
  });

  it("derives a distinct key per invoice.payment_failed invoice", () => {
    const key1 = derivePaystackEventKey("invoice.payment_failed", { invoice_code: "INV_1" });
    const key2 = derivePaystackEventKey("invoice.payment_failed", { invoice_code: "INV_2" });
    expect(key1).not.toBe(key2);
  });

  it("derives a distinct key per subscription.disable subscription_code", () => {
    const key1 = derivePaystackEventKey("subscription.disable", { subscription_code: "SUB_1" });
    const key2 = derivePaystackEventKey("subscription.disable", { subscription_code: "SUB_2" });
    expect(key1).not.toBe(key2);
  });

  it("returns null for an event type not on the explicit allowlist", () => {
    expect(derivePaystackEventKey("customeridentification.failed", { anything: true })).toBeNull();
    expect(derivePaystackEventKey("transfer.success", {})).toBeNull();
  });

  it("returns null when an allowlisted event's own payload fails its minimal shape schema", () => {
    // charge.success with no reference at all.
    expect(derivePaystackEventKey("charge.success", { customer: {} })).toBeNull();
    // invoice.payment_failed with neither invoice_code nor id.
    expect(derivePaystackEventKey("invoice.payment_failed", {})).toBeNull();
  });

  it("never uses a client/user-controlled field as the key (metadata is ignored entirely)", () => {
    const withMetadata = derivePaystackEventKey("charge.success", {
      id: 1,
      reference: "ref_1",
      amount: 100,
      currency: "NGN",
      customer: {},
      metadata: { business_id: "attacker-controlled-value" },
    });
    const withoutMetadata = derivePaystackEventKey("charge.success", {
      id: 1,
      reference: "ref_1",
      amount: 100,
      currency: "NGN",
      customer: {},
    });
    expect(withMetadata).toBe(withoutMetadata);
  });
});

describe("WebhookEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    expect(WebhookEnvelopeSchema.safeParse({ event: "charge.success", data: {} }).success).toBe(true);
  });

  it("rejects an envelope missing `event`", () => {
    expect(WebhookEnvelopeSchema.safeParse({ data: {} }).success).toBe(false);
  });

  it("rejects an envelope whose `data` is not an object", () => {
    expect(WebhookEnvelopeSchema.safeParse({ event: "charge.success", data: "not-an-object" }).success).toBe(false);
  });

  it("rejects a completely malformed body shape", () => {
    expect(WebhookEnvelopeSchema.safeParse(null).success).toBe(false);
    expect(WebhookEnvelopeSchema.safeParse("a string").success).toBe(false);
    expect(WebhookEnvelopeSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and produces a 64-character lowercase hex digest", () => {
    const hash1 = sha256Hex("hello world");
    const hash2 = sha256Hex("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different digest for different input", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
