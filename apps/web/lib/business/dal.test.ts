import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { maybeSingle, eqChain, from } = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eqChain: { eq: ReturnType<typeof vi.fn>; maybeSingle: typeof maybeSingle } = {
    eq: vi.fn(() => eqChain),
    maybeSingle,
  };
  const select = vi.fn(() => eqChain);
  const from = vi.fn(() => ({ select }));
  return { maybeSingle, eqChain, from };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from })),
}));

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));

import { getBusinessMembership } from "./dal";

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "user-1" });
  maybeSingle.mockReset();
  eqChain.eq.mockClear();
  notFound.mockClear();
});

describe("getBusinessMembership", () => {
  it("returns the membership row when the user is an active member", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "m1", business_id: "biz-1", status: "active" },
      error: null,
    });

    await expect(getBusinessMembership("biz-1")).resolves.toMatchObject({
      id: "m1",
    });
    expect(from).toHaveBeenCalledWith("business_members");
    expect(eqChain.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(eqChain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(eqChain.eq).toHaveBeenCalledWith("status", "active");
  });

  it("calls notFound() when the user has no membership row (cross-tenant access)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getBusinessMembership("someone-elses-biz")).rejects.toThrow(
      "NOT_FOUND"
    );
    expect(notFound).toHaveBeenCalled();
  });

  it("throws on a query error rather than treating it as \"not a member\"", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "connection reset" },
    });

    await expect(getBusinessMembership("biz-1")).rejects.toThrow(
      /Failed to verify business membership/
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});
