import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above all top-level declarations, so a
// factory that closes over a plain `const foo = vi.fn()` declared later in
// this file hits a temporal-dead-zone error the moment the mocked module is
// first imported. vi.hoisted() runs its callback as part of that same
// hoisting pass, so the mock functions exist before the factories that
// reference them ever run.
const { getUser, getClaims } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getClaims: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser, getClaims } })),
}));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import { getAuthUser, requireUser, getAssuranceLevel } from "./dal";

beforeEach(() => {
  getUser.mockReset();
  getClaims.mockReset();
  redirect.mockClear();
});

describe("getAuthUser", () => {
  it("returns the user when getUser succeeds", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await expect(getAuthUser()).resolves.toEqual({ id: "u1" });
  });

  it("returns null when getUser errors", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "no session" },
    });
    await expect(getAuthUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  it("returns the user when signed in", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await expect(requireUser()).resolves.toEqual({ id: "u1" });
  });

  it("redirects to /login when signed out", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("getAssuranceLevel", () => {
  it("returns aal2 when the verified claims report aal2", async () => {
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal2" } }, error: null });
    await expect(getAssuranceLevel()).resolves.toBe("aal2");
  });

  it("returns aal1 when the verified claims report aal1", async () => {
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal1" } }, error: null });
    await expect(getAssuranceLevel()).resolves.toBe("aal1");
  });

  it("returns null when getClaims errors (never treated as aal2)", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "invalid token" } });
    await expect(getAssuranceLevel()).resolves.toBeNull();
  });

  it("returns null when there are no claims", async () => {
    getClaims.mockResolvedValue({ data: { claims: null }, error: null });
    await expect(getAssuranceLevel()).resolves.toBeNull();
  });

  it("returns null for a missing aal claim (fail closed, never defaults to aal2)", async () => {
    getClaims.mockResolvedValue({ data: { claims: {} }, error: null });
    await expect(getAssuranceLevel()).resolves.toBeNull();
  });

  it("returns null for an unexpected aal value (fail closed)", async () => {
    getClaims.mockResolvedValue({ data: { claims: { aal: "aal3" } }, error: null });
    await expect(getAssuranceLevel()).resolves.toBeNull();
  });
});
