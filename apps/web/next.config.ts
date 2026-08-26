import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // `next dev` initializes on `localhost` by default; Playwright's
  // configured baseURL (and Supabase's local-stack redirect URLs) use
  // `127.0.0.1`, which Next otherwise treats as a different origin and
  // blocks dev-asset requests from — breaking client-component hydration
  // for E2E tests. See docs/allowedDevOrigins.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
