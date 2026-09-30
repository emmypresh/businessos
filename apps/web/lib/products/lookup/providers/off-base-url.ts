// Phase 1Q-C remediation — centralized validation for the Open Food Facts
// base URL (SSRF host allowlist). Pure and framework-free so it is unit
// testable without server-only/env plumbing.
//
// The adapter's outbound host is deploy-time configuration
// (PRODUCT_LOOKUP_OFF_BASE_URL). That value must never be able to point the
// server's fetch at an arbitrary host, so it is validated against an
// allowlist and anything else FAILS CLOSED (throws) — there is deliberately
// no fallback to "whatever was configured" or to a guess.
//
//   Production:  exactly https://world.openfoodfacts.org (exact hostname
//                match — no suffix/wildcard matching, default port only).
//   Test only:   http(s) to exactly localhost / 127.0.0.1 / [::1] on any
//                port, and ONLY when ALL of these hold (see isLoopbackPermitted):
//                  BUSINESSOS_E2E === "1"
//                  PRODUCT_LOOKUP_ALLOW_LOOPBACK === "1"
//                  NODE_ENV !== "production"
//                  VERCEL_ENV !== "production"
//                The production prohibition is enforced here in code: if either
//                NODE_ENV or VERCEL_ENV is "production", loopback is rejected
//                regardless of every other flag. There is no generic
//                SSRF-disable switch.
//
// Never allowed: other hostnames (including look-alikes such as
// openfoodfacts.org.evil.example.com), private/link-local IPs, non-http(s)
// schemes, embedded credentials, non-default ports on the official host, a
// path/query/fragment beyond "/".

export const OFF_DEFAULT_BASE_URL = "https://world.openfoodfacts.org";
export const OFF_ALLOWED_HOSTS: readonly string[] = ["world.openfoodfacts.org"];
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export class ProductLookupConfigError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid PRODUCT_LOOKUP_OFF_BASE_URL: ${reason}`);
    this.name = "ProductLookupConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

// Production if EITHER signal says so. Read from the passed env object (not a
// statically-inlined process.env.NODE_ENV) so the check is a runtime fact.
export function isProductionRuntime(env: Env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

// The only path by which a loopback host can ever be accepted. Production
// always wins; the two explicit test flags are both required.
export function isLoopbackPermitted(env: Env): boolean {
  if (isProductionRuntime(env)) return false;
  return env.BUSINESSOS_E2E === "1" && env.PRODUCT_LOOKUP_ALLOW_LOOPBACK === "1";
}

// Returns a normalized origin (no trailing slash) or throws
// ProductLookupConfigError. The thrown reason never echoes the configured
// value, so a URL containing credentials is never written to logs.
export function resolveOffBaseUrl(env: Env = process.env): string {
  const raw = env.PRODUCT_LOOKUP_OFF_BASE_URL;
  if (raw === undefined || raw.trim() === "") return OFF_DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProductLookupConfigError("not a parseable URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProductLookupConfigError("scheme must be http or https");
  }
  if (url.username || url.password) {
    throw new ProductLookupConfigError("embedded credentials are not allowed");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ProductLookupConfigError("path, query and fragment are not allowed");
  }

  const host = url.hostname.toLowerCase();

  if (OFF_ALLOWED_HOSTS.includes(host)) {
    if (url.protocol !== "https:") throw new ProductLookupConfigError("official host requires https");
    if (url.port !== "") throw new ProductLookupConfigError("official host must use the default port");
    return url.origin;
  }

  if (LOOPBACK_HOSTS.includes(host)) {
    if (!isLoopbackPermitted(env)) throw new ProductLookupConfigError("loopback host is not enabled in this environment");
    return url.origin;
  }

  throw new ProductLookupConfigError("host is not on the allowlist");
}
