import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Paystack webhook's `x-paystack-signature` header against the
 * RAW request body — this must be called with the body EXACTLY as
 * received, before any JSON.parse (a byte that survives JSON.parse but
 * changes the exact serialization — e.g. re-serialized key ordering,
 * whitespace, or number formatting — would otherwise silently pass a
 * signature computed over a DIFFERENT byte sequence than the one being
 * checked, defeating the entire point of signing). See
 * app/api/webhooks/paystack/route.ts for why `request.text()` is read
 * before any JSON interpretation.
 *
 * HMAC-SHA512 (Paystack's own documented scheme), hex-encoded, compared
 * with a length-checked, timing-safe comparison — never `===` on the
 * hex strings (a naive string comparison leaks how many leading bytes
 * matched via response-time differences) and never `Buffer.compare`
 * (not constant-time). `timingSafeEqual` itself throws on mismatched
 * buffer lengths rather than returning false, so lengths are checked
 * first — this function never throws for a malformed/wrong-length
 * signature header, it returns false, exactly like any other invalid
 * signature.
 */
export function verifyPaystackSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secretKey: string
): boolean {
  if (!signatureHeader || !secretKey) {
    return false;
  }

  const expectedHex = createHmac("sha512", secretKey).update(rawBody, "utf8").digest("hex");

  const expected = Buffer.from(expectedHex, "hex");
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }

  // A signature header that isn't valid hex, or decodes to the wrong
  // byte length, is rejected here — before timingSafeEqual, which would
  // otherwise throw on a length mismatch.
  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
