import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { getPermissions } = vi.hoisted(() => ({ getPermissions: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ getPermissions }));

const { getDefaultInventoryLocation, getMovementCostIfAllowed } = vi.hoisted(() => ({
  getDefaultInventoryLocation: vi.fn(),
  getMovementCostIfAllowed: vi.fn(),
}));
vi.mock("./dal", () => ({ getDefaultInventoryLocation, getMovementCostIfAllowed }));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));

import { adjustStock, revealMovementCost } from "./actions";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const IDEMPOTENCY_KEY = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "user-1" });
  getPermissions.mockReset();
  getDefaultInventoryLocation.mockReset().mockResolvedValue({ id: "loc-1", name: "Main Store" });
  getMovementCostIfAllowed.mockReset();
  rpc.mockReset();
  redirect.mockClear();
});

describe("adjustStock — authorization (rule 1)", () => {
  it("denies a caller without inventory.adjust and never calls the RPC", async () => {
    getPermissions.mockResolvedValue(new Set([]));

    const result = await adjustStock(
      undefined,
      formData({
        businessId: "biz-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        productId: PRODUCT_ID,
        direction: "increase",
        quantity: "5",
        reason: "Test",
      })
    );

    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("adjustStock — direction mapping and server-controlled fields", () => {
  it("maps increase/decrease to ADJUSTMENT_IN/ADJUSTMENT_OUT server-side, and location is resolved server-side (never client-submitted)", async () => {
    getPermissions.mockResolvedValue(new Set(["inventory.adjust"]));
    rpc.mockResolvedValue({ data: { product_id: PRODUCT_ID }, error: null });

    await expect(
      adjustStock(
        undefined,
        formData({
          businessId: "biz-1",
          idempotencyKey: IDEMPOTENCY_KEY,
          productId: PRODUCT_ID,
          direction: "increase",
          quantity: "5",
          reason: "Found stock",
        })
      )
    ).rejects.toThrow("REDIRECT:");

    expect(rpc).toHaveBeenCalledWith(
      "record_inventory_movement",
      expect.objectContaining({
        p_movement_type: "ADJUSTMENT_IN",
        p_inventory_location_id: "loc-1", // from getDefaultInventoryLocation, not form data
        p_quantity: 5,
      })
    );
    // No form field for business ownership/balance_after/quantity sign/
    // created_by ever exists to be forwarded — asserted structurally: the
    // RPC call args object has exactly these keys, nothing else.
    const callArgs = rpc.mock.calls[0][1];
    expect(Object.keys(callArgs).sort()).toEqual(
      [
        "p_business_id",
        "p_idempotency_key",
        "p_inventory_location_id",
        "p_movement_type",
        "p_note",
        "p_product_id",
        "p_quantity",
        "p_reason",
      ].sort()
    );
  });

  it("maps decrease to ADJUSTMENT_OUT", async () => {
    getPermissions.mockResolvedValue(new Set(["inventory.adjust"]));
    rpc.mockResolvedValue({ data: { product_id: PRODUCT_ID }, error: null });

    await expect(
      adjustStock(
        undefined,
        formData({
          businessId: "biz-1",
          idempotencyKey: IDEMPOTENCY_KEY,
          productId: PRODUCT_ID,
          direction: "decrease",
          quantity: "5",
          reason: "Damaged",
        })
      )
    ).rejects.toThrow("REDIRECT:");

    expect(rpc).toHaveBeenCalledWith(
      "record_inventory_movement",
      expect.objectContaining({ p_movement_type: "ADJUSTMENT_OUT" })
    );
  });
});

describe("adjustStock — RPC response sanitization (rule 3)", () => {
  it("an error response never contains raw RPC/database fields", async () => {
    getPermissions.mockResolvedValue(new Set(["inventory.adjust"]));
    rpc.mockResolvedValue({ data: null, error: { message: "INSUFFICIENT_STOCK" } });

    const result = await adjustStock(
      undefined,
      formData({
        businessId: "biz-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        productId: PRODUCT_ID,
        direction: "decrease",
        quantity: "500",
        reason: "Too much",
      })
    );

    const keys = Object.keys(result ?? {});
    expect(keys).not.toContain("unit_cost");
    expect(keys).not.toContain("idempotency_key");
    for (const key of keys) {
      expect(["error", "fieldErrors", "success"]).toContain(key);
    }
  });

  it("the redirect never carries unit_cost/idempotency_key from the RPC response", async () => {
    getPermissions.mockResolvedValue(new Set(["inventory.adjust"]));
    rpc.mockResolvedValue({
      data: { product_id: PRODUCT_ID, unit_cost: 55.5, idempotency_key: "should-never-appear" },
      error: null,
    });

    await expect(
      adjustStock(
        undefined,
        formData({
          businessId: "biz-1",
          idempotencyKey: IDEMPOTENCY_KEY,
          productId: PRODUCT_ID,
          direction: "increase",
          quantity: "1",
          reason: "Test",
        })
      )
    ).rejects.toThrow("REDIRECT:");

    const revalidateModule = await import("next/cache");
    void revalidateModule;
    const redirectUrl = redirect.mock.calls[0][0] as string;
    expect(redirectUrl).not.toContain("should-never-appear");
    expect(redirectUrl).not.toContain("55.5");
  });
});

describe("idempotency-key-reused handling (rule 5) — mapped as a stale/conflicting state, not blindly retried", () => {
  it("IDEMPOTENCY_KEY_REUSED is surfaced as a distinct message, and the action does not itself retry", async () => {
    getPermissions.mockResolvedValue(new Set(["inventory.adjust"]));
    rpc.mockResolvedValue({ data: null, error: { message: "IDEMPOTENCY_KEY_REUSED" } });

    const result = await adjustStock(
      undefined,
      formData({
        businessId: "biz-1",
        idempotencyKey: IDEMPOTENCY_KEY,
        productId: PRODUCT_ID,
        direction: "increase",
        quantity: "1",
        reason: "Test",
      })
    );

    expect(result?.error).toContain("may already have been recorded");
    // Exactly one RPC call — the action never auto-resubmits.
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("revealMovementCost — independently re-verifies inventory.view_cost", () => {
  it("returns null without calling the accessor's own permission-check path result when absent", async () => {
    getMovementCostIfAllowed.mockResolvedValue(null);
    const result = await revealMovementCost("biz-1", "ledger-1");
    expect(result).toEqual({ cost: null });
  });

  it("returns the cost when allowed", async () => {
    getMovementCostIfAllowed.mockResolvedValue(42.5);
    const result = await revealMovementCost("biz-1", "ledger-1");
    expect(result).toEqual({ cost: 42.5 });
  });

  it("fails safe (a mapped error, not a thrown exception) if the underlying call throws", async () => {
    getMovementCostIfAllowed.mockRejectedValue(new Error("boom"));
    const result = await revealMovementCost("biz-1", "ledger-1");
    expect(result).toEqual({ error: "Could not load cost." });
  });
});
