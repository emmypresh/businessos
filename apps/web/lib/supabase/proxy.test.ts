import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// @supabase/ssr's real createServerClient calls the cookies.setAll callback
// it's given whenever a token refresh happens, passing both the refreshed
// cookies AND the anti-caching headers (Cache-Control/Expires/Pragma) it
// requires the caller to attach to the HTTP response. Mocking the module
// lets this test simulate exactly that call, for all three response paths
// updateSession can take, without needing a real, near-expired Supabase
// session — a slower and flakier way to prove the same thing.
const { capturedSetAll, getClaimsMock } = vi.hoisted(() => ({
  capturedSetAll: { fn: null as unknown as (...args: unknown[]) => unknown },
  getClaimsMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, config: { cookies: { setAll: (...args: unknown[]) => unknown } }) => {
    capturedSetAll.fn = config.cookies.setAll;
    return { auth: { getClaims: getClaimsMock } };
  }),
}));

import { updateSession } from "./proxy";

const REFRESH_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};

function mockRefreshOnNextGetClaims(
  cookieName: string,
  cookieValue: string,
  claims: Record<string, unknown> | null
) {
  getClaimsMock.mockImplementation(async () => {
    // Simulates @supabase/ssr writing a refreshed session mid-call.
    await capturedSetAll.fn(
      [{ name: cookieName, value: cookieValue, options: { path: "/" } }],
      REFRESH_HEADERS
    );
    return { data: { claims }, error: null };
  });
}

/** Asserts all four values @supabase/ssr requires survive onto `response`. */
function expectRefreshPreserved(response: Response, cookieName: string, cookieValue: string) {
  const setCookieHeader = response.headers.get("set-cookie") ?? "";
  expect(setCookieHeader).toContain(`${cookieName}=${cookieValue}`);
  expect(response.headers.get("Cache-Control")).toBe(REFRESH_HEADERS["Cache-Control"]);
  expect(response.headers.get("Expires")).toBe(REFRESH_HEADERS.Expires);
  expect(response.headers.get("Pragma")).toBe(REFRESH_HEADERS.Pragma);
}

beforeEach(() => {
  getClaimsMock.mockReset();
});

describe("updateSession: Set-Cookie / Cache-Control / Expires / Pragma survive every response path", () => {
  it("path 1 — normal pass-through (signed in, ordinary route)", async () => {
    mockRefreshOnNextGetClaims("sb-access-token", "new-token-passthrough", { sub: "user-1" });

    const request = new NextRequest("http://127.0.0.1:3000/onboarding", {
      headers: { cookie: "sb-access-token=old-token" },
    });
    const response = await updateSession(request);

    expect(response.status).toBe(200);
    expect(response.cookies.get("sb-access-token")?.value).toBe("new-token-passthrough");
    expectRefreshPreserved(response, "sb-access-token", "new-token-passthrough");
  });

  it("path 2 — signed-out visitor to a protected route -> redirected to /login", async () => {
    mockRefreshOnNextGetClaims("sb-access-token", "", null);

    const request = new NextRequest("http://127.0.0.1:3000/onboarding");
    const response = await updateSession(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/onboarding");
    // Before the fix, redirect branches returned a fresh
    // NextResponse.redirect() that never received anything setAll() had
    // written — this is exactly what would have silently dropped a
    // just-refreshed session's cookies and headers on this path.
    expectRefreshPreserved(response, "sb-access-token", "");
  });

  it("path 3 — signed-in visitor to an auth-only route -> redirected to /", async () => {
    mockRefreshOnNextGetClaims("sb-access-token", "new-token-redirect", { sub: "user-1" });

    const request = new NextRequest("http://127.0.0.1:3000/login", {
      headers: { cookie: "sb-access-token=old-token" },
    });
    const response = await updateSession(request);

    expect(response.status).toBe(307);
    // NextRequest normalizes the host in this test environment (localhost
    // vs. 127.0.0.1) independent of what's being verified here — path only.
    expect(new URL(response.headers.get("location")!).pathname).toBe("/");
    expectRefreshPreserved(response, "sb-access-token", "new-token-redirect");
  });

  it("does not set any anti-caching headers when no cookie refresh occurred", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });

    const request = new NextRequest("http://127.0.0.1:3000/onboarding", {
      headers: { cookie: "sb-access-token=still-valid" },
    });
    const response = await updateSession(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(response.headers.get("Expires")).toBeNull();
    expect(response.headers.get("Pragma")).toBeNull();
  });
});
