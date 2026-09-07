import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPaystackSignature } from "./webhook-signature";

const SECRET = "sk_test_deterministic_secret_for_unit_tests";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha512", secret).update(body, "utf8").digest("hex");
}

describe("verifyPaystackSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } });
    expect(verifyPaystackSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const body = JSON.stringify({ event: "charge.success" });
    expect(verifyPaystackSignature(body, null, SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty secret", () => {
    const body = "{}";
    expect(verifyPaystackSignature(body, sign(body), "")).toBe(false);
  });

  it("rejects a signature computed with the WRONG secret", () => {
    const body = JSON.stringify({ event: "charge.success" });
    expect(verifyPaystackSignature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered body (signature computed over a DIFFERENT body)", () => {
    const originalBody = JSON.stringify({ event: "charge.success", data: { amount: 100 } });
    const tamperedBody = JSON.stringify({ event: "charge.success", data: { amount: 1000000 } });
    const signature = sign(originalBody);
    expect(verifyPaystackSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it("rejects a non-hex signature header without throwing", () => {
    const body = "{}";
    expect(() => verifyPaystackSignature(body, "not-valid-hex-!!", SECRET)).not.toThrow();
    expect(verifyPaystackSignature(body, "not-valid-hex-!!", SECRET)).toBe(false);
  });

  it("rejects a wrong-length (but validly hex) signature header without throwing", () => {
    const body = "{}";
    // Valid hex, but far too short to be a real SHA-512 digest — this
    // exercises the length check that runs BEFORE timingSafeEqual
    // (which throws on a length mismatch rather than returning false).
    expect(() => verifyPaystackSignature(body, "abcd", SECRET)).not.toThrow();
    expect(verifyPaystackSignature(body, "abcd", SECRET)).toBe(false);
  });

  it("rejects an empty string signature", () => {
    expect(verifyPaystackSignature("{}", "", SECRET)).toBe(false);
  });
});
