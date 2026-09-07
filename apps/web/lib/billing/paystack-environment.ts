import "server-only";

/**
 * The ONE central parser for PAYSTACK_ENVIRONMENT — every other module in
 * this application that needs to know which Paystack environment this
 * deployment is configured for imports `PAYSTACK_ENVIRONMENT` from here,
 * never reads `process.env.PAYSTACK_ENVIRONMENT` itself.
 *
 * FAIL CLOSED, never a silent default: an unset, empty, or unrecognized
 * value (including a case-variant like "test" — canonicalization is
 * deliberately NOT performed; an operator who means "TEST" must write
 * exactly that) resolves to `null`, never a guessed environment. Every
 * caller MUST handle `null` explicitly — there is no fallback constant to
 * fall through to. This directly remediates the previous, unsafe
 * behavior (`process.env.PAYSTACK_ENVIRONMENT === "LIVE" ? "LIVE" :
 * "TEST"`), which silently treated any misconfiguration as TEST — safe
 * against accidentally using LIVE resources, but NOT safe against
 * silently disabling every environment check a caller might have relied
 * on to reject a genuine TEST/LIVE mismatch.
 */

export type PaystackEnvironment = "TEST" | "LIVE";

export function parsePaystackEnvironment(raw: string | undefined): PaystackEnvironment | null {
  if (raw === "TEST" || raw === "LIVE") return raw;
  return null;
}

// A GETTER, not a module-load-time constant: `process.env` is read fresh
// on every call. This is deliberate, not merely a testability
// convenience — Next.js Server Actions/Route Handlers can run in a
// long-lived process across many requests, and a stale value captured
// once at import time would survive an operator fixing a
// misconfiguration until the next full redeploy/restart. Every caller in
// this application calls getPaystackEnvironment() itself rather than
// importing a cached constant.
export function getPaystackEnvironment(): PaystackEnvironment | null {
  return parsePaystackEnvironment(process.env.PAYSTACK_ENVIRONMENT);
}

export function isValidPaystackEnvironment(value: unknown): value is PaystackEnvironment {
  return value === "TEST" || value === "LIVE";
}
