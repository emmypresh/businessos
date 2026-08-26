import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import {
  createOwnerAndBusiness,
  getDefaultLocationId,
  randomUuid,
} from "./helpers/inventory";

type Client = SupabaseClient<Database>;

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeProduct(client: Client, businessId: string) {
  const { data, error } = await client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: "Ledger Test Product",
    p_sku: `lb-${randomUuid()}`,
  });
  if (error) throw new Error(`create_product failed: ${error.message}`);
  return data;
}

describe("ledger / balance invariants", () => {
  it("ledger rows cannot be UPDATEd or DELETEd by authenticated, ever", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("lb-immutable");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    const { data: movement, error: movementError } = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 4,
      p_idempotency_key: randomUuid(),
      p_reason: "Opening stock",
    });
    expect(movementError).toBeNull();
    if (!movement) throw new Error("expected a movement row");

    const update = await client.from("inventory_ledger").update({ reason: "tampered" }).eq("id", movement.id);
    expect(update.error).not.toBeNull();

    const del = await client.from("inventory_ledger").delete().eq("id", movement.id);
    expect(del.error).not.toBeNull();

    const { data: stillThere } = await client.from("inventory_ledger").select("reason").eq("id", movement.id).single();
    expect(stillThere?.reason).toBe("Opening stock");
  });

  it("balance_after on each ledger row matches the balance after that movement, and SUM(quantity_delta) reconciles to the current balance", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("lb-reconcile");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    const movements = [
      { type: "OPENING_STOCK", qty: 10 },
      { type: "ADJUSTMENT_IN", qty: 5 },
      { type: "ADJUSTMENT_OUT", qty: 3 },
      { type: "ADJUSTMENT_IN", qty: 2 },
    ] as const;

    let running = 0;
    for (const m of movements) {
      const { data, error } = await client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: product.id,
        p_inventory_location_id: locationId,
        p_movement_type: m.type,
        p_quantity: m.qty,
        p_idempotency_key: randomUuid(),
        p_reason: `step ${m.type}`,
      });
      expect(error).toBeNull();
      running += m.type === "ADJUSTMENT_OUT" ? -m.qty : m.qty;
      expect(Number(data?.balance_after)).toBe(running);
    }

    const { data: ledgerRows } = await client
      .from("inventory_ledger")
      .select("quantity_delta")
      .eq("product_id", product.id);
    const sum = (ledgerRows ?? []).reduce((acc, r) => acc + Number(r.quantity_delta), 0);

    const { data: balance } = await client
      .from("inventory_balances")
      .select("quantity")
      .eq("product_id", product.id)
      .eq("inventory_location_id", locationId)
      .single();

    expect(sum).toBe(running);
    expect(Number(balance?.quantity)).toBe(running);
    expect(sum).toBe(Number(balance?.quantity));
  });

  it("inventory_balances.quantity >= 0 is enforced at the DB boundary even for a direct privileged write", async () => {
    const { businessId, userId, client } = await createOwnerAndBusiness("lb-nonneg-check");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.inventory_balances (business_id, product_id, inventory_location_id, quantity)
          values (${businessId}, ${product.id}, ${locationId}, -1)
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("standalone product deletion is blocked while its business remains", async () => {
    const { businessId, userId, client } = await createOwnerAndBusiness("lb-standalone-product");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);
    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "history",
    });

    const sql = createTestDbClient();
    try {
      await expect(sql`delete from public.products where id = ${product.id}`).rejects.toThrow();
      const stillThere = await sql`select id from public.products where id = ${product.id}`;
      expect(stillThere).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("standalone location deletion is blocked while ledger history references it", async () => {
    const { businessId, userId, client } = await createOwnerAndBusiness("lb-standalone-location");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);
    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "history",
    });

    const sql = createTestDbClient();
    try {
      await sql`update public.inventory_locations set is_default = false where id = ${locationId}`;
      await expect(sql`delete from public.inventory_locations where id = ${locationId}`).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("whole-business deletion succeeds atomically, removing the entire inventory graph", async () => {
    const { businessId, userId, client } = await createOwnerAndBusiness("lb-whole-business");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);
    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "history",
    });

    const sql = createTestDbClient();
    try {
      await sql`delete from public.businesses where id = ${businessId}`;

      const remainingBusiness = await sql`select id from public.businesses where id = ${businessId}`;
      const remainingProducts = await sql`select id from public.products where business_id = ${businessId}`;
      const remainingLocations = await sql`select id from public.inventory_locations where business_id = ${businessId}`;
      const remainingLedger = await sql`select id from public.inventory_ledger where business_id = ${businessId}`;
      const remainingBalances = await sql`select id from public.inventory_balances where business_id = ${businessId}`;

      expect(remainingBusiness).toHaveLength(0);
      expect(remainingProducts).toHaveLength(0);
      expect(remainingLocations).toHaveLength(0);
      expect(remainingLedger).toHaveLength(0);
      expect(remainingBalances).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
