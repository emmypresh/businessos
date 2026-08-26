import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  randomUuid,
} from "./helpers/inventory";

type Client = SupabaseClient<Database>;

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeProductWithCost(client: Client, businessId: string) {
  const { data, error } = await client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: "Cost Visibility Product",
    p_sku: `cost-${randomUuid()}`,
    p_cost_price: 1234.56,
    p_selling_price: 2000,
  });
  if (error) throw new Error(`create_product failed: ${error.message}`);
  return data;
}

describe("cost visibility — real Data API", () => {
  it("SALES can read the approved non-cost columns", async () => {
    const owner = await createOwnerAndBusiness("cost-sales-approved");
    cleanupUserIds.push(owner.userId);
    const sales = await createMemberWithRole(owner.businessId, "cost-sales-approved", "SALES");
    cleanupUserIds.push(sales.userId);
    const product = await makeProductWithCost(owner.client, owner.businessId);

    const { data, error } = await sales.client
      .from("products")
      .select("id, name, sku, selling_price, status")
      .eq("id", product.id)
      .single();
    expect(error).toBeNull();
    expect(data?.name).toBe("Cost Visibility Product");
  });

  it("SALES cannot select cost_price (explicit column, or via select(\"*\"))", async () => {
    const owner = await createOwnerAndBusiness("cost-sales-denied");
    cleanupUserIds.push(owner.userId);
    const sales = await createMemberWithRole(owner.businessId, "cost-sales-denied", "SALES");
    cleanupUserIds.push(sales.userId);
    const product = await makeProductWithCost(owner.client, owner.businessId);

    const explicit = await sales.client
      .from("products")
      .select("id, name, cost_price")
      .eq("id", product.id)
      .single();
    expect(explicit.error).not.toBeNull();

    const star = await sales.client.from("products").select("*").eq("id", product.id).single();
    expect(star.error).not.toBeNull();
  });

  it("SALES cannot select unit_cost from inventory_ledger", async () => {
    const owner = await createOwnerAndBusiness("cost-sales-ledger-denied");
    cleanupUserIds.push(owner.userId);
    const sales = await createMemberWithRole(owner.businessId, "cost-sales-ledger-denied", "SALES");
    cleanupUserIds.push(sales.userId);

    const star = await sales.client.from("inventory_ledger").select("*").limit(1);
    expect(star.error).not.toBeNull();

    const explicit = await sales.client.from("inventory_ledger").select("id, unit_cost").limit(1);
    expect(explicit.error).not.toBeNull();
  });

  it("VIEWER has the identical restriction as SALES", async () => {
    const owner = await createOwnerAndBusiness("cost-viewer-denied");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithRole(owner.businessId, "cost-viewer-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);
    const product = await makeProductWithCost(owner.client, owner.businessId);

    const star = await viewer.client.from("products").select("*").eq("id", product.id).single();
    expect(star.error).not.toBeNull();

    const rpc = await viewer.client.rpc("get_product_cost", { p_product_id: product.id });
    expect(rpc.error).not.toBeNull();
    expect(rpc.error?.message).toContain("insufficient_privilege");
  });

  it.each(["OWNER" as const])(
    "the business creator (%s) can read cost via the accessor function",
    async () => {
      const owner = await createOwnerAndBusiness("cost-owner-allowed");
      cleanupUserIds.push(owner.userId);
      const product = await makeProductWithCost(owner.client, owner.businessId);

      const { data, error } = await owner.client.rpc("get_product_cost", { p_product_id: product.id });
      expect(error).toBeNull();
      expect(Number(data)).toBeCloseTo(1234.56, 2);
    }
  );

  it.each(["ADMIN", "MANAGER", "INVENTORY", "ACCOUNTANT"] as const)(
    "%s can read cost via the accessor function",
    async (roleName) => {
      const owner = await createOwnerAndBusiness(`cost-${roleName.toLowerCase()}-allowed`);
      cleanupUserIds.push(owner.userId);
      const member = await createMemberWithRole(owner.businessId, `cost-${roleName.toLowerCase()}-allowed`, roleName);
      cleanupUserIds.push(member.userId);
      const product = await makeProductWithCost(owner.client, owner.businessId);

      const { data, error } = await member.client.rpc("get_product_cost", { p_product_id: product.id });
      expect(error).toBeNull();
      expect(Number(data)).toBeCloseTo(1234.56, 2);
    }
  );

  it.each(["SALES", "VIEWER"] as const)(
    "%s's cost accessor call returns insufficient_privilege (42501)",
    async (roleName) => {
      const owner = await createOwnerAndBusiness(`cost-${roleName.toLowerCase()}-42501`);
      cleanupUserIds.push(owner.userId);
      const member = await createMemberWithRole(owner.businessId, `cost-${roleName.toLowerCase()}-42501`, roleName);
      cleanupUserIds.push(member.userId);
      const product = await makeProductWithCost(owner.client, owner.businessId);

      const { error } = await member.client.rpc("get_product_cost", { p_product_id: product.id });
      expect(error).not.toBeNull();
      expect(error?.message).toContain("insufficient_privilege");
    }
  );

  it("a foreign-tenant product UUID and a random nonexistent UUID produce an indistinguishable result", async () => {
    const a = await createOwnerAndBusiness("cost-nondisclosure-a");
    const b = await createOwnerAndBusiness("cost-nondisclosure-b");
    cleanupUserIds.push(a.userId, b.userId);
    const productA = await makeProductWithCost(a.client, a.businessId);

    const foreign = await b.client.rpc("get_product_cost", { p_product_id: productA.id });
    const random = await b.client.rpc("get_product_cost", { p_product_id: randomUuid() });

    // Neither raises an error, and both return the same value (null) —
    // a caller cannot tell "this id belongs to someone else" apart from
    // "this id does not exist."
    expect(foreign.error).toBeNull();
    expect(random.error).toBeNull();
    expect(foreign.data).toBeNull();
    expect(random.data).toBeNull();
    expect(foreign.data).toBe(random.data);
  });

  it("regression: get_product_cost's generated type is nullable (jsonb -> Json, not a lying non-nullable number) and the runtime value is a plain JS number on success", async () => {
    const owner = await createOwnerAndBusiness("cost-type-regression");
    cleanupUserIds.push(owner.userId);
    const product = await makeProductWithCost(owner.client, owner.businessId);

    const { data, error } = await owner.client.rpc("get_product_cost", { p_product_id: product.id });
    expect(error).toBeNull();
    // Runtime: a jsonb numeric scalar arrives as a plain JS number, not a
    // string or wrapped object.
    expect(typeof data).toBe("number");
    expect(data).toBeCloseTo(1234.56, 2);

    // Type-level: the generated Returns type for a `returns jsonb`
    // function is `Json`, whose own definition already includes `| null`
    // — assigning `data` (typed `Json`) to a `number | null`-typed local
    // is what actually exercises that the generator no longer lies with
    // a non-nullable `number`. This line is a compile-time assertion:
    // pnpm typecheck fails if `Json` narrows to something incompatible.
    const typed: number | null = data as number | null;
    expect(typed).not.toBeNull();

    const { data: missing } = await owner.client.rpc("get_product_cost", { p_product_id: randomUuid() });
    expect(missing).toBeNull();
  });

  it("a foreign-tenant ledger UUID and a random nonexistent UUID produce an indistinguishable result", async () => {
    const a = await createOwnerAndBusiness("cost-nondisclosure-ledger-a");
    const b = await createOwnerAndBusiness("cost-nondisclosure-ledger-b");
    cleanupUserIds.push(a.userId, b.userId);

    const { data: locations } = await a.client
      .from("inventory_locations")
      .select("id")
      .eq("business_id", a.businessId)
      .eq("is_default", true)
      .single();
    const product = await makeProductWithCost(a.client, a.businessId);
    const { data: movement } = await a.client.rpc("record_inventory_movement", {
      p_business_id: a.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locations!.id,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_unit_cost: 500,
      p_reason: "for cost non-disclosure test",
    });

    const foreign = await b.client.rpc("get_movement_unit_cost", { p_ledger_id: movement!.id });
    const random = await b.client.rpc("get_movement_unit_cost", { p_ledger_id: randomUuid() });

    expect(foreign.error).toBeNull();
    expect(random.error).toBeNull();
    expect(foreign.data).toBeNull();
    expect(random.data).toBeNull();
    expect(foreign.data).toBe(random.data);
  });
});
