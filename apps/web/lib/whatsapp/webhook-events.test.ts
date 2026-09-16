import { describe, expect, it } from "vitest";
import {
  WebhookEnvelopeSchema,
  parseMessagesFieldValue,
  deriveInboundMessageEventKey,
  deriveStatusEventKey,
  isSupportedStatus,
  sha256Hex,
} from "@/lib/whatsapp/webhook-events";

describe("WebhookEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    const result = WebhookEnvelopeSchema.safeParse({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: {} }] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects the wrong object value", () => {
    expect(WebhookEnvelopeSchema.safeParse({ object: "page", entry: [] }).success).toBe(false);
  });

  it("rejects a missing entry array", () => {
    expect(WebhookEnvelopeSchema.safeParse({ object: "whatsapp_business_account" }).success).toBe(false);
  });

  it("passes through unrecognized fields without failing", () => {
    const result = WebhookEnvelopeSchema.safeParse({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [], somethingNew: true }],
      anotherNewField: 123,
    });
    expect(result.success).toBe(true);
  });
});

describe("parseMessagesFieldValue", () => {
  it("accepts a minimal valid messages value", () => {
    const parsed = parseMessagesFieldValue({ metadata: { phone_number_id: "p1" } });
    expect(parsed?.metadata?.phone_number_id).toBe("p1");
  });

  it("returns null for a value missing metadata.phone_number_id entirely omitted (still valid, optional)", () => {
    const parsed = parseMessagesFieldValue({});
    expect(parsed).not.toBeNull();
  });

  it("returns null for a structurally invalid value", () => {
    expect(parseMessagesFieldValue({ messages: [{ id: 123 }] })).toBeNull();
  });

  it("WA-APP-02-R1: accepts a statuses[] entry carrying biz_opaque_callback_data", () => {
    const parsed = parseMessagesFieldValue({
      statuses: [{ id: "wamid.1", status: "sent", timestamp: "1000", biz_opaque_callback_data: "0123456789abcdef0123456789abcdef" }],
    });
    expect(parsed?.statuses?.[0]?.biz_opaque_callback_data).toBe("0123456789abcdef0123456789abcdef");
  });

  it("WA-APP-02-R1: rejects a statuses[] entry with an oversized biz_opaque_callback_data (Meta's own 512-char bound)", () => {
    const parsed = parseMessagesFieldValue({
      statuses: [{ id: "wamid.1", status: "sent", timestamp: "1000", biz_opaque_callback_data: "a".repeat(513) }],
    });
    expect(parsed).toBeNull();
  });
});

describe("event key derivation", () => {
  it("derives a stable inbound key from the provider message id alone", () => {
    expect(deriveInboundMessageEventKey("wamid.ABC")).toBe("message.inbound:wamid.ABC");
  });

  it("derives distinct keys for different statuses on the same message", () => {
    const sent = deriveStatusEventKey("wamid.ABC", "sent", "1000");
    const delivered = deriveStatusEventKey("wamid.ABC", "delivered", "1001");
    expect(sent).not.toBe(delivered);
  });

  it("derives the SAME key for an identical retry (same id/status/timestamp)", () => {
    const a = deriveStatusEventKey("wamid.ABC", "sent", "1000");
    const b = deriveStatusEventKey("wamid.ABC", "sent", "1000");
    expect(a).toBe(b);
  });
});

describe("isSupportedStatus", () => {
  it("supports exactly sent/delivered/read/failed", () => {
    expect(isSupportedStatus("sent")).toBe(true);
    expect(isSupportedStatus("delivered")).toBe(true);
    expect(isSupportedStatus("read")).toBe(true);
    expect(isSupportedStatus("failed")).toBe(true);
  });

  it("rejects an unsupported status", () => {
    expect(isSupportedStatus("deleted")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("is deterministic for the same input", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("differs for different input", () => {
    expect(sha256Hex("hello")).not.toBe(sha256Hex("world"));
  });
});
