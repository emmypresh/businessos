import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Codex adversarial review, application-layer round 4: the confirmed
// defect was specifically that the malformed-route 404 branch built a
// brand-new Response, discarding whatever updateSession() had just done
// to the request (a refreshed Supabase auth cookie, Cache-Control).
// Forcing a REAL Supabase token refresh through this path is fragile
// (it depends on the token happening to be near expiry at exactly the
// right moment) and not worth the flakiness — this instead controls
// updateSession() directly and asserts, deterministically, that every
// cookie AND every other header it sets survives the malformed-route
// 404 transform untouched, and that a redirect it returns is passed
// through completely unmodified. The live malformed-route -> HTTP 404
// assertion itself stays covered by tests/e2e/branches.spec.ts and
// tests/e2e/staff.spec.ts, against the real running app.
const updateSession = vi.fn();
vi.mock("@/lib/supabase/proxy", () => ({ updateSession }));

const { proxy } = await import("./proxy");

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, "https://example.test"));
}

beforeEach(() => {
  updateSession.mockReset();
});

describe("proxy — malformed Phase 1F detail routes preserve updateSession's response", () => {
  it("A: malformed branch route — 404, and the refreshed session's Set-Cookie + Cache-Control both survive", async () => {
    const sessionResponse = NextResponse.next();
    sessionResponse.cookies.set("sb-access-token", "refreshed-access", { path: "/", httpOnly: true, sameSite: "lax" });
    sessionResponse.cookies.set("sb-refresh-token", "refreshed-refresh", { path: "/", httpOnly: true, sameSite: "lax" });
    sessionResponse.headers.set("cache-control", "no-store");
    updateSession.mockResolvedValue(sessionResponse);

    const response = await proxy(makeRequest("/biz-1/branches/not-a-uuid"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");

    // Multiple Set-Cookie values must remain distinct entries, never
    // collapsed into one comma-joined string.
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies.some((c) => c.startsWith("sb-access-token=refreshed-access"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("sb-refresh-token=refreshed-refresh"))).toBe(true);
    // Attributes (HttpOnly here) must round-trip too, not just the raw
    // name=value pair.
    expect(setCookies.every((c) => /HttpOnly/i.test(c))).toBe(true);
  });

  it("B: malformed branch EDIT route — 404, refreshed cookie preserved", async () => {
    const sessionResponse = NextResponse.next();
    sessionResponse.cookies.set("sb-access-token", "refreshed-access", { path: "/" });
    updateSession.mockResolvedValue(sessionResponse);

    const response = await proxy(makeRequest("/biz-1/branches/not-a-uuid/edit"));

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("sb-access-token=refreshed-access"))).toBe(true);
  });

  it("C: malformed staff route — 404, refreshed cookie preserved", async () => {
    const sessionResponse = NextResponse.next();
    sessionResponse.cookies.set("sb-access-token", "refreshed-access", { path: "/" });
    updateSession.mockResolvedValue(sessionResponse);

    const response = await proxy(makeRequest("/biz-1/staff/not-a-uuid"));

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("sb-access-token=refreshed-access"))).toBe(true);
  });

  it("D: a valid UUID branch route is untouched — the exact same response updateSession returned", async () => {
    const sessionResponse = NextResponse.next();
    updateSession.mockResolvedValue(sessionResponse);

    const response = await proxy(makeRequest("/biz-1/branches/11111111-1111-1111-1111-111111111111"));

    expect(response).toBe(sessionResponse);
  });

  it("E/F/G: static sibling routes (branches/new, staff/invite, staff/invitations) are untouched", async () => {
    for (const pathname of ["/biz-1/branches/new", "/biz-1/staff/invite", "/biz-1/staff/invitations"]) {
      const sessionResponse = NextResponse.next();
      updateSession.mockResolvedValue(sessionResponse);

      const response = await proxy(makeRequest(pathname));

      expect(response).toBe(sessionResponse);
    }
  });

  it("H: an auth redirect from updateSession is returned completely unchanged, even for a malformed id — never overwritten with a 404", async () => {
    const redirect = NextResponse.redirect(new URL("/login", "https://example.test"));
    redirect.cookies.set("sb-access-token", "should-not-be-touched", { path: "/" });
    updateSession.mockResolvedValue(redirect);

    const response = await proxy(makeRequest("/biz-1/branches/not-a-uuid"));

    expect(response).toBe(redirect);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("sb-access-token=should-not-be-touched"))).toBe(true);
  });
});
