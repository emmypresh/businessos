#!/usr/bin/env node
// Builds the app in production mode for E2E, with the exact env the
// production `next start` server will actually run under. This has to be a
// script (not an inline env-var prefix in package.json's "test:e2e") because
// `VAR=value command` is POSIX-only shell syntax and doesn't work under
// Windows' cmd.exe, which is what pnpm/npm invoke package.json scripts
// through on this platform — setting process.env here instead is
// cross-platform by construction.
//
// Why the build needs this at all: Next.js inlines NEXT_PUBLIC_* values at
// *build* time for production output, not at `next start` runtime — setting
// NEXT_PUBLIC_SITE_URL only in playwright.config.ts's webServer.env (which
// only affects the already-built `next start` process) would be too late;
// every confirmation/recovery email link generated during the E2E run would
// still bake in whatever NEXT_PUBLIC_SITE_URL was present at build time.
import { spawnSync } from "node:child_process";
import { E2E_PORT, E2E_BASE_URL } from "../tests/e2e/e2e-target.mjs";

process.env.PORT = E2E_PORT;
process.env.NEXT_PUBLIC_SITE_URL = E2E_BASE_URL;

const result = spawnSync("node", ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
