// Single source of truth for the E2E target, shared by playwright.config.ts,
// tests/e2e/global-setup.ts, and scripts/build-for-e2e.mjs (which must build
// with the same NEXT_PUBLIC_SITE_URL the server will actually run on — production
// builds inline NEXT_PUBLIC_* values at build time, not at `next start` runtime).
// Plain ESM/.mjs (not .ts) so a plain `node` script can import it directly
// with no TypeScript loader.
//
// A fixed, dedicated, unusual port — not the app's normal dev port (3000) —
// with a DEFAULT that is not read from an env var for normal local/CI use.
// Optionally overridable via E2E_PORT, added specifically so a caller can
// run an isolated audit/diagnostic invocation without colliding with a
// concurrently-running suite on this same port on a shared machine (see
// tests/integration diagnostic history) — this is NOT a general "configure
// your own port" escape hatch for everyday use, which is why the default
// stays hardcoded rather than reading from .env. If set, the value is
// validated strictly (a plain positive integer, no blank/mistyped values
// silently producing an invalid baseURL) — see playwright.config.ts's
// former inline comment (now here) for why an unvalidated env var would
// have been unsafe: it would let the one thing this port exists to fix —
// being unambiguously distinct from the app's normal dev port — be
// overridden by accident.
function resolveE2EPort() {
  const raw = process.env.E2E_PORT;
  if (raw === undefined || raw === "") return "3100";
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 65535) {
    throw new Error(
      `E2E_PORT must be a plain positive integer port number (1-65535); got ${JSON.stringify(raw)}.`
    );
  }
  return raw;
}

export const E2E_PORT = resolveE2EPort();
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

// Shared with any spec that needs to assert an exact page URL (not just
// navigate via Playwright's relative baseURL) — e.g. "redirected to the
// business-selection page at the site root", where a plain string
// wouldn't do and the port must not be hardcoded. Escapes E2E_BASE_URL's
// own regex metacharacters (the `.`s in the IP, the `:` before the port)
// so it composes safely as a RegExp fragment; not a URL parser, just the
// standard regex-literal escape.
function escapeForRegExp(raw) {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export const E2E_BASE_URL_PATTERN = escapeForRegExp(E2E_BASE_URL);
