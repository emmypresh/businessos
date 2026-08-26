import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  randomUuid,
} from "./helpers/inventory";

// Hybrid technique: lib/products/dal.ts / lib/inventory/dal.ts ultimately
// call lib/supabase/server.ts's createClient(), which needs next/headers'
// cookies() — unavailable outside a real Next.js request, exactly like
// the Server Actions tested in lib/products/actions.test.ts. Rather than
// mock the Supabase client's query methods too (which would just
// re-assert what this file already writes, not what the DAL actually
// does against a real database), this mocks ONLY the cookie-dependent
// wrapper to return a REAL signed-in client against the REAL local
// stack — so the DAL's own permission-gating logic
// (getProductCostIfAllowed / getMovementCostIfAllowed) runs for real,
// against real RLS/RPCs, with a real user/permission set.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => {
  return {
    requireUser: async () => {
      const { data } = await currentClient.auth.getUser();
      if (!data.user) throw new Error("not signed in");
      return data.user;
    },
  };
});

const { getProductCostIfAllowed } = await import("@/lib/products/dal");
const { getMovementCostIfAllowed } = await import("@/lib/inventory/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("app-layer cost access — real permissions, real RPCs", () => {
  it("getProductCostIfAllowed returns null WITHOUT calling the RPC when inventory.view_cost is absent (SALES)", async () => {
    const owner = await createOwnerAndBusiness("cost-dal-sales");
    cleanupUserIds.push(owner.userId);
    const sales = await createMemberWithRole(owner.businessId, "cost-dal-sales", "SALES");
    cleanupUserIds.push(sales.userId);

    currentClient = owner.client;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Cost DAL Product",
      p_sku: `cost-dal-${randomUuid()}`,
      p_cost_price: 777,
    });

    currentClient = sales.client;
    const rpcSpy = vi.spyOn(sales.client, "rpc");
    const result = await getProductCostIfAllowed(owner.businessId, product!.id);

    expect(result).toBeNull();
    expect(rpcSpy).not.toHaveBeenCalledWith("get_product_cost", expect.anything());
    rpcSpy.mockRestore();
  });

  it("getProductCostIfAllowed returns the real value for OWNER (has inventory.view_cost)", async () => {
    const owner = await createOwnerAndBusiness("cost-dal-owner");
    cleanupUserIds.push(owner.userId);

    currentClient = owner.client;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Cost DAL Product 2",
      p_sku: `cost-dal-owner-${randomUuid()}`,
      p_cost_price: 888.5,
    });

    const result = await getProductCostIfAllowed(owner.businessId, product!.id);
    expect(result).toBeCloseTo(888.5, 2);
  });

  it("getMovementCostIfAllowed returns null without calling the RPC for VIEWER", async () => {
    const owner = await createOwnerAndBusiness("cost-dal-movement-viewer");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithRole(owner.businessId, "cost-dal-movement-viewer", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    currentClient = owner.client;
    const { data: loc } = await owner.client
      .from("inventory_locations")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("is_default", true)
      .single();
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Movement Cost DAL",
      p_sku: `mv-cost-dal-${randomUuid()}`,
    });
    const { data: movement } = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_inventory_location_id: loc!.id,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_unit_cost: 12.5,
      p_reason: "for cost dal test",
    });

    currentClient = viewer.client;
    const rpcSpy = vi.spyOn(viewer.client, "rpc");
    const result = await getMovementCostIfAllowed(owner.businessId, movement!.id);

    expect(result).toBeNull();
    expect(rpcSpy).not.toHaveBeenCalledWith("get_movement_unit_cost", expect.anything());
    rpcSpy.mockRestore();
  });
});
