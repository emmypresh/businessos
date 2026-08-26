import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
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
    p_name: "Concurrency Test Product",
    p_sku: `cc-${randomUuid()}`,
  });
  if (error) throw new Error(`create_product failed: ${error.message}`);
  return data;
}

describe("inventory movement concurrency", () => {
  it("stock=2 with two concurrent -2 deductions: exactly one succeeds, balance never goes negative", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cc-deduct");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 2,
      p_idempotency_key: randomUuid(),
      p_reason: "Opening stock",
    });

    const [a, b] = await Promise.all([
      client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: product.id,
        p_inventory_location_id: locationId,
        p_movement_type: "ADJUSTMENT_OUT",
        p_quantity: 2,
        p_idempotency_key: randomUuid(),
        p_reason: "Concurrent sale 1",
      }),
      client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: product.id,
        p_inventory_location_id: locationId,
        p_movement_type: "ADJUSTMENT_OUT",
        p_quantity: 2,
        p_idempotency_key: randomUuid(),
        p_reason: "Concurrent sale 2",
      }),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("INSUFFICIENT_STOCK");

    const { data: balance } = await client
      .from("inventory_balances")
      .select("quantity")
      .eq("product_id", product.id)
      .eq("inventory_location_id", locationId)
      .single();
    expect(Number(balance?.quantity)).toBe(0);
    expect(Number(balance?.quantity)).toBeGreaterThanOrEqual(0);
  });

  it("movement vs. archive race: both orderings produce a deterministic, correct outcome", async () => {
    // Ordering A: archive lands first (stock genuinely zero) -> archive
    // succeeds, the racing movement then correctly sees PRODUCT_ARCHIVED.
    {
      const { client, businessId, userId } = await createOwnerAndBusiness("cc-race-archive-first");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const product = await makeProduct(client, businessId);

      const [, movementResult] = await Promise.all([
        client.from("products").update({ status: "archived" }).eq("id", product.id),
        client.rpc("record_inventory_movement", {
          p_business_id: businessId,
          p_product_id: product.id,
          p_inventory_location_id: locationId,
          p_movement_type: "OPENING_STOCK",
          p_quantity: 5,
          p_idempotency_key: randomUuid(),
          p_reason: "Racing with archive",
        }),
      ]);

      // Exactly one deterministic legal outcome is expected:
      // - archive succeeds and movement is rejected as PRODUCT_ARCHIVED, OR
      // - movement succeeds first (product still active) and the archive
      //   is then rejected by CANNOT_ARCHIVE_WITH_STOCK once nonzero stock
      //   exists.
      // Both are safe; what must NEVER happen is both succeeding with an
      // archived product holding nonzero stock.
      const archivedProduct = await client.from("products").select("status").eq("id", product.id).single();
      if (archivedProduct.data?.status === "archived") {
        expect(movementResult.error).not.toBeNull();
      } else {
        expect(movementResult.error).toBeNull();
      }

      const { data: balance } = await client
        .from("inventory_balances")
        .select("quantity")
        .eq("product_id", product.id)
        .eq("inventory_location_id", locationId)
        .maybeSingle();
      const finalStock = Number(balance?.quantity ?? 0);
      expect(!(archivedProduct.data?.status === "archived" && finalStock > 0)).toBe(true);
    }
  });

  it("archiving with positive stock is rejected; archiving at zero stock succeeds", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cc-archive-stock");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 3,
      p_idempotency_key: randomUuid(),
      p_reason: "Opening stock",
    });

    const rejected = await client.from("products").update({ status: "archived" }).eq("id", product.id);
    expect(rejected.error).not.toBeNull();
    expect(rejected.error?.message).toContain("CANNOT_ARCHIVE_WITH_STOCK");

    await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 3,
      p_idempotency_key: randomUuid(),
      p_reason: "Zero it out",
    });

    const accepted = await client.from("products").update({ status: "archived" }).eq("id", product.id);
    expect(accepted.error).toBeNull();
  });

  it("concurrent identical idempotent requests produce exactly one mutation; a different payload with the same key is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cc-idem-concurrent");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);
    const key = randomUuid();

    const payload = {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK" as const,
      p_quantity: 7,
      p_idempotency_key: key,
      p_reason: "Concurrent identical",
    };

    const [a, b] = await Promise.all([
      client.rpc("record_inventory_movement", payload),
      client.rpc("record_inventory_movement", payload),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data?.id).toBe(b.data?.id);

    // idempotency_key is deliberately not in authenticated's SELECT column
    // grant (internal mutation-control metadata) — filter by product_id
    // instead, which is.
    const { data: rows } = await client.from("inventory_ledger").select("id").eq("product_id", product.id);
    expect(rows).toHaveLength(1);

    const mismatched = await client.rpc("record_inventory_movement", {
      ...payload,
      p_quantity: 999,
    });
    expect(mismatched.error).not.toBeNull();
    expect(mismatched.error?.message).toContain("IDEMPOTENCY_KEY_REUSED");
  });
});
