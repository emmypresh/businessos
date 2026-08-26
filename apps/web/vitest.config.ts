import path from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only`'s real module body intentionally throws outside
      // Next's own build system — see lib/test/server-only-shim.ts.
      "server-only": path.resolve(__dirname, "lib/test/server-only-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
    exclude: ["tests/integration/**", "tests/e2e/**"],
  },
});
