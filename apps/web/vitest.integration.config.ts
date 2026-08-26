import path from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Same alias as vitest.config.ts (unit tests) — needed here too now
      // that some integration tests (tests/integration/cost-access-app-layer.test.ts)
      // import server-only DAL modules directly, with only the
      // cookie-dependent Supabase client wrapper mocked out, so the DAL's
      // own logic runs against a real local database.
      "server-only": path.resolve(__dirname, "lib/test/server-only-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup-env.ts"],
    testTimeout: 20_000,
    fileParallelism: false, // shares one local Postgres instance
    env: { NODE_ENV: "test" },
  },
});
