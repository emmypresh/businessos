import { describe, expect, it } from "vitest";
// The installed Next version (16.3.2) still names this testing helper after
// "middleware", not "proxy" — Next has renamed the middleware.ts file
// convention itself to proxy.ts, but next/experimental/testing/server's
// matcher-checking export is still `unstable_doesMiddlewareMatch` (verified
// directly against node_modules/next/dist/experimental/testing/server); the
// plan anticipated a possible `unstable_doesProxyMatch` rename that hasn't
// happened yet in this version, and named this as an acceptable fallback.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "../../proxy";
import nextConfig from "../../next.config";

describe("proxy matcher", () => {
  it.each([
    ["/login", true],
    ["/onboarding", true],
    ["/reset-password", true],
    ["/abc123/members", true],
    ["/_next/static/chunk.js", false],
    ["/_next/image?url=x", false],
    ["/favicon.ico", false],
    ["/logo.svg", false],
  ])("matches %s -> %s", (url, expected) => {
    expect(
      unstable_doesMiddlewareMatch({ config, nextConfig, url })
    ).toBe(expected);
  });
});
