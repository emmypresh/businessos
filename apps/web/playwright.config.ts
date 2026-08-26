import { defineConfig } from "@playwright/test";
import { config } from "dotenv";
import path from "node:path";
import { E2E_PORT, E2E_BASE_URL } from "./tests/e2e/e2e-target.mjs";

// dotenv/config's bare import loads .env by default, not .env.test.local —
// see tests/integration/setup-env.ts for the same fix applied there. This
// is only for the *other* test env vars (Mailpit URL, etc.) — the E2E
// base URL itself is intentionally NOT sourced from here; see
// tests/e2e/e2e-target.mjs.
config({ path: path.resolve(__dirname, ".env.test.local") });

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  // Capped, not left at Playwright's default (half of logical cores — 8 on
  // this machine). At 8, GoTrue's own audit log confirms every
  // signInWithPassword call still succeeded (200) even in runs with
  // spurious "still on /login" failures — but request latency under that
  // much concurrent load against the single Next.js production process
  // plus the whole local Supabase stack (Postgres, GoTrue, PostgREST,
  // Realtime, Storage, Mailpit, all sharing this machine) spiked past 1.5s,
  // occasionally exceeding the default 5s assertion timeout on a redirect
  // that was merely slow, not wrong. This is resource contention, not a
  // correctness bug — lowering worker count (not retries, which stay 0 so
  // a genuine hang still fails loudly) is the correct fix.
  workers: 4,
  globalSetup: "./tests/e2e/global-setup.ts",
  expect: {
    // See the `workers` comment above — 10s (not the 5s default) gives
    // legitimately slower-under-load requests headroom without masking an
    // actual hang, since a real hang blows well past either budget.
    timeout: 10_000,
  },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    // Production server, not `next dev`. `next dev`'s architecture forks a
    // separate, nested child-process tree — a CLI bootstrap process, which
    // itself forks a distinct start-server.js process that is the one
    // actually holding the listening socket, which itself spawns Turbopack
    // worker processes for incremental compilation — 3+ levels of
    // Windows-shell-wrapped descendants below whatever Playwright directly
    // spawns. Confirmed by direct process-tree inspection
    // (Get-CimInstance Win32_Process) during an actual hung run: Playwright's
    // own top-level test-runner process (the `@playwright/test/cli.js test`
    // node process) was still alive, blocked — its webServer teardown
    // couldn't reach far enough down that tree on Windows to make the real
    // socket owner (start-server.js) exit, so Playwright kept waiting for a
    // port-close that was never going to happen. `next start` runs as a
    // single, plain Node process with none of that dev-mode/Turbopack
    // child-process lifecycle, so there's nothing for teardown to fail to
    // reach. `pnpm test:e2e` builds first (scripts/build-for-e2e.mjs) so
    // this step only ever starts an already-built app.
    command: `node node_modules/next/dist/bin/next start -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    // Never reuse whatever is already answering on this port — if the
    // dedicated E2E port is occupied (a leftover process, or something
    // else entirely), this must fail loudly, not silently run destructive
    // tests (real signups, cookie clearing, direct SQL fixture writes)
    // against an unverified server. tests/e2e/global-setup.ts's
    // content-fingerprint check is the second, independent layer on top
    // of this — defense in depth, not a replacement for it.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
