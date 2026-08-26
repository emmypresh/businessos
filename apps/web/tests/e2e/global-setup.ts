import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { E2E_BASE_URL } from "./e2e-target.mjs";
import { assertLocalSupabaseUrl } from "../integration/helpers/url-safety";

/**
 * Three independent, layered mitigations against E2E tests (real signups,
 * cookie clearing, direct SQL fixture writes) accidentally firing against
 * the wrong target:
 *  1. playwright.config.ts's webServer has reuseExistingServer: false —
 *     Playwright always starts its own production (`next start`) server on
 *     the fixed E2E_BASE_URL and fails loudly if that port is already
 *     occupied, rather than silently treating whatever answers there as
 *     "the app" (guards against an unrelated local web app or a stale
 *     process).
 *  2. The content-fingerprint check below is defense in depth on top of
 *     (1): even a process that is genuinely this project's own server,
 *     left over from an earlier run or started manually on this exact
 *     port, gets its content verified — via markup no unrelated server
 *     would produce — before any spec runs.
 *  3. assertE2EServerUsesLocalSupabase() below closes a different gap:
 *     url-safety.ts's checks only ever guarded the test *helper* clients
 *     (tests/integration/helpers/*) — the actual server E2E drives loads
 *     its own Supabase connection independently from .env.local, which
 *     nothing else here inspects. Without this, a misconfigured
 *     .env.local pointing at hosted Supabase (or a real production
 *     project) would go completely unnoticed by every check above — the
 *     app would look and behave exactly like BusinessOS, because it is
 *     BusinessOS, just talking to the wrong backend.
 */

/**
 * Reads apps/web/.env.local directly (not via dotenv.config(), which
 * would silently no-op here since playwright.config.ts already populated
 * process.env from .env.test.local first, and dotenv doesn't override an
 * already-set var by default) and validates the exact URL the E2E server
 * will use — that file, not this test runner's own process.env, is the
 * actual source of truth for what the app connects to (server-only vars
 * like SUPABASE_SECRET_KEY are read live from it at `next start` runtime,
 * same as dev; only the NEXT_PUBLIC_* values get baked in earlier, at
 * `next build` time — see scripts/build-for-e2e.mjs).
 */
function assertE2EServerUsesLocalSupabase() {
  const envLocalPath = path.resolve(__dirname, "../../.env.local");
  let parsed: Record<string, string>;
  try {
    parsed = parseDotenv(readFileSync(envLocalPath));
  } catch (cause) {
    throw new Error(
      `Could not read ${envLocalPath} to verify which Supabase project the E2E server will use. Refusing to run destructive E2E tests against an unverified target.`,
      { cause }
    );
  }

  const url = parsed.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      `${envLocalPath} has no NEXT_PUBLIC_SUPABASE_URL. Refusing to run destructive E2E tests against an unverified target.`
    );
  }

  assertLocalSupabaseUrl(url);
}

export default async function globalSetup() {
  assertE2EServerUsesLocalSupabase();

  const baseURL = E2E_BASE_URL;

  let landing: Response;
  let login: Response;
  try {
    [landing, login] = await Promise.all([
      fetch(baseURL),
      fetch(new URL("/login", baseURL)),
    ]);
  } catch (cause) {
    throw new Error(
      `E2E target ${baseURL} is unreachable. Refusing to run destructive E2E tests against an unverified server.`,
      { cause }
    );
  }

  if (!landing.ok || !login.ok) {
    throw new Error(
      `E2E target ${baseURL} did not respond as expected (landing: ${landing.status}, login: ${login.status}). Refusing to run destructive E2E tests against an unverified server.`
    );
  }

  const [landingBody, loginBody] = await Promise.all([landing.text(), login.text()]);

  if (!landingBody.includes("BusinessOS") || !landingBody.includes("Run your business in one place")) {
    throw new Error(
      `E2E target ${baseURL}'s landing page doesn't match BusinessOS's expected content. ` +
        "This usually means Playwright reused an unrelated server already listening on this port. " +
        "Refusing to run destructive E2E tests."
    );
  }

  if (!loginBody.includes('name="email"') || !loginBody.includes('name="password"')) {
    throw new Error(
      `E2E target ${baseURL}'s /login page doesn't match BusinessOS's expected form. ` +
        "Refusing to run destructive E2E tests."
    );
  }
}
