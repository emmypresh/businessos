/**
 * Test-environment URL validation for the two test-only clients
 * (admin-client.ts, db-client.ts). Previously these did a bare
 * `url.includes("127.0.0.1")` / `url.includes("localhost")` check, which
 * is a substring match — it passes for `localhost.attacker.example`,
 * `127.0.0.1.attacker.example`, and any remote hostname that merely
 * *contains* "localhost" (e.g. `evil-host-localhost.example.com`). This
 * module replaces that with real URL parsing and exact-value checks
 * against this project's actual local Supabase stack (ports read from
 * `supabase status` — see .env.test.local.example).
 */

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);

const LOCAL_SUPABASE_API_PORT = "54321";
const LOCAL_DATABASE_PORT = "54322";
const LOCAL_DATABASE_NAME = "/postgres";

export class UnsafeTestUrlError extends Error {}

function parseUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new UnsafeTestUrlError(`${label} is not a valid URL: ${JSON.stringify(raw)}`);
  }
}

/**
 * A remote target is only ever accepted when all three hold:
 *  1. ALLOW_REMOTE_TEST_SUPABASE=true
 *  2. CI=true
 *  3. the exact URL string appears in the comma-separated
 *     ALLOWED_CI_TEST_URLS allowlist.
 * Booleans alone are not enough — a CI job with the two flags set but no
 * allowlist entry still can't point this at an arbitrary remote project;
 * the disposable CI project has to be named explicitly.
 */
function isExplicitlyAllowlistedRemote(raw: string): boolean {
  if (process.env.ALLOW_REMOTE_TEST_SUPABASE !== "true") return false;
  if (process.env.CI !== "true") return false;

  const allowlist = (process.env.ALLOWED_CI_TEST_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return allowlist.includes(raw);
}

/** Validates NEXT_PUBLIC_SUPABASE_URL is the actual local Supabase API. */
export function assertLocalSupabaseUrl(raw: string): void {
  if (isExplicitlyAllowlistedRemote(raw)) return;

  const url = parseUrl(raw, "NEXT_PUBLIC_SUPABASE_URL");

  if (url.protocol !== "http:") {
    throw new UnsafeTestUrlError(
      `Refusing non-local protocol for the Supabase API URL: ${url.protocol} (expected http:)`
    );
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new UnsafeTestUrlError(
      `Refusing non-local Supabase API hostname: ${JSON.stringify(url.hostname)} (expected exactly one of ${[...LOCAL_HOSTNAMES].join(", ")})`
    );
  }
  if (url.port !== LOCAL_SUPABASE_API_PORT) {
    throw new UnsafeTestUrlError(
      `Refusing unexpected Supabase API port: ${JSON.stringify(url.port)} (expected ${LOCAL_SUPABASE_API_PORT})`
    );
  }
}

/** Validates DATABASE_URL is the actual local Supabase Postgres instance. */
export function assertLocalDatabaseUrl(raw: string): void {
  if (isExplicitlyAllowlistedRemote(raw)) return;

  const url = parseUrl(raw, "DATABASE_URL");

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new UnsafeTestUrlError(
      `Refusing unexpected DATABASE_URL protocol: ${url.protocol} (expected postgresql:)`
    );
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new UnsafeTestUrlError(
      `Refusing non-local database hostname: ${JSON.stringify(url.hostname)} (expected exactly one of ${[...LOCAL_HOSTNAMES].join(", ")})`
    );
  }
  if (url.port !== LOCAL_DATABASE_PORT) {
    throw new UnsafeTestUrlError(
      `Refusing unexpected database port: ${JSON.stringify(url.port)} (expected ${LOCAL_DATABASE_PORT})`
    );
  }
  if (url.pathname !== LOCAL_DATABASE_NAME) {
    throw new UnsafeTestUrlError(
      `Refusing unexpected database name: ${JSON.stringify(url.pathname)} (expected ${LOCAL_DATABASE_NAME})`
    );
  }
}
