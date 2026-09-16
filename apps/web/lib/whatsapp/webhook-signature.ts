import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's `x-hub-signature-256` header against the RAW request
 * body — mirrors lib/billing/webhook-signature.ts's own precedent and
 * exact rationale (see that file's header comment for why this must be
 * called with the body exactly as received, before any JSON.parse).
 *
 * Meta's own documented format is `sha256=<hex digest>` (HMAC-SHA256,
 * hex-encoded, over the raw body, keyed with the Meta App Secret — NOT
 * the access token and NOT the webhook verify token, three distinct
 * secrets this application deliberately never confuses). The `sha256=`
 * prefix is required and checked explicitly; a header missing it, or
 * any other malformed shape, is rejected before any HMAC computation is
 * even attempted.
 *
 * Timing-safe: lengths are checked before `timingSafeEqual` (which
 * throws on a length mismatch rather than returning false) — this
 * function never throws for a malformed/wrong-length signature, it
 * returns false, exactly like every other invalid-signature case.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) {
    return false;
  }

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }
  const hexDigest = signatureHeader.slice(prefix.length);

  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const expected = Buffer.from(expectedHex, "hex");

  let received: Buffer;
  try {
    received = Buffer.from(hexDigest, "hex");
  } catch {
    return false;
  }

  if (received.length !== expected.length || received.length === 0) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

/**
 * Timing-safe comparison for the GET verification handshake's
 * `hub.verify_token` — a plain string comparison here would leak how
 * many leading characters matched via response-time differences,
 * exactly like an HMAC comparison would. Both inputs are encoded to
 * bytes and length-checked before `timingSafeEqual` for the same reason
 * as verifyMetaWebhookSignature above.
 */
export function verifyMetaWebhookVerifyToken(
  providedToken: string | null,
  configuredToken: string
): boolean {
  if (!providedToken) {
    return false;
  }
  const provided = Buffer.from(providedToken, "utf8");
  const configured = Buffer.from(configuredToken, "utf8");
  if (provided.length !== configured.length || provided.length === 0) {
    return false;
  }
  return timingSafeEqual(provided, configured);
}
