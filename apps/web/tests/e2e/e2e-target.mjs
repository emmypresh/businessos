// Single source of truth for the E2E target, shared by playwright.config.ts,
// tests/e2e/global-setup.ts, and scripts/build-for-e2e.mjs (which must build
// with the same NEXT_PUBLIC_SITE_URL the server will actually run on — production
// builds inline NEXT_PUBLIC_* values at build time, not at `next start` runtime).
// Plain ESM/.mjs (not .ts) so a plain `node` script can import it directly
// with no TypeScript loader.
//
// A fixed, dedicated, unusual port — not the app's normal dev port (3000) —
// and deliberately not read from an env var. See playwright.config.ts's
// former inline comment (now here) for why: reading it from an env var would
// let a blank or mistyped value silently produce an invalid baseURL, and
// would let the one thing this port exists to fix — being unambiguously
// distinct from the app's normal dev port — be overridden by accident.
export const E2E_PORT = "3100";
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
