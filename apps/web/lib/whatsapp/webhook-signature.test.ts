import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyMetaWebhookSignature, verifyMetaWebhookVerifyToken } from "@/lib/whatsapp/webhook-signature";

const SECRET = "app_secret_under_test";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyMetaWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaWebhookSignature("{}", null, SECRET)).toBe(false);
    expect(verifyMetaWebhookSignature("{}", undefined, SECRET)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = "{}";
    const raw = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(verifyMetaWebhookSignature(body, raw, SECRET)).toBe(false);
  });

  it("rejects a non-hex signature without throwing", () => {
    expect(verifyMetaWebhookSignature("{}", "sha256=not-hex-zz", SECRET)).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", () => {
    expect(verifyMetaWebhookSignature("{}", "sha256=abcd", SECRET)).toBe(false);
  });

  it("rejects a body tampered with after signing", () => {
    const original = JSON.stringify({ amount: 100 });
    const signature = sign(original);
    const tampered = JSON.stringify({ amount: 999 });
    expect(verifyMetaWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    const body = "{}";
    expect(verifyMetaWebhookSignature(body, sign(body), "")).toBe(false);
  });
});

describe("verifyMetaWebhookVerifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyMetaWebhookVerifyToken("secret-token", "secret-token")).toBe(true);
  });

  it("rejects a mismatched token", () => {
    expect(verifyMetaWebhookVerifyToken("wrong", "secret-token")).toBe(false);
  });

  it("rejects a null token", () => {
    expect(verifyMetaWebhookVerifyToken(null, "secret-token")).toBe(false);
  });

  it("rejects an empty configured token safely", () => {
    expect(verifyMetaWebhookVerifyToken("anything", "")).toBe(false);
  });
});
