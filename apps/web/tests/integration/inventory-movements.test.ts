import { describe, expect, it, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  getDefaultLocationId,
  randomUuid,
} from "./helpers/inventory";

type Client = SupabaseClient<Database>;

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeProduct(client: Client, businessId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: "Movement Test Product",
    p_sku: `mv-${randomUuid()}`,
    ...overrides,
  });
  if (error) throw new Error(`create_product failed: ${error.message}`);
  return data;
}

describe("public.record_inventory_movement", () => {
  it("OPENING_STOCK, ADJUSTMENT_IN, ADJUSTMENT_OUT all move balance correctly and sign is derived server-side", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("mv-types");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    const open = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "OPENING_STOCK",
      p_quantity: 20,
      p_idempotency_key: randomUuid(),
      p_reason: "Opening stock",
    });
    expect(open.error).toBeNull();
    expect(Number(open.data?.quantity_delta)).toBe(20);
    expect(Number(open.data?.balance_after)).toBe(20);

    const inc = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Found extra stock",
    });
    expect(inc.error).toBeNull();
    expect(Number(inc.data?.quantity_delta)).toBe(5);
    expect(Number(inc.data?.balance_after)).toBe(25);

    const dec = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Damaged units removed",
    });
    expect(dec.error).toBeNull();
    // sign is derived: caller passed a POSITIVE p_quantity for
    // ADJUSTMENT_OUT, server stored a NEGATIVE quantity_delta.
    expect(Number(dec.data?.quantity_delta)).toBe(-5);
    expect(Number(dec.data?.balance_after)).toBe(20);
  });

  it("rejects a non-positive quantity at the API boundary (zero and negative)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("mv-qty-boundary");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    for (const qty of [0, -1]) {
      const { error } = await client.rpc("record_inventory_movement", {
        p_business_id: businessId,
        p_product_id: product.id,
        p_inventory_location_id: locationId,
        p_movement_type: "ADJUSTMENT_IN",
        p_quantity: qty,
        p_idempotency_key: randomUuid(),
        p_reason: "Invalid quantity",
      });
      expect(error, `quantity=${qty}`).not.toBeNull();
    }
  });

  it("rejects a movement against an archived product", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("mv-archived");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId);

    await client.from("products").update({ status: "archived" }).eq("id", product.id);

    const { error } = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be rejected",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("PRODUCT_ARCHIVED");
  });

  it("rejects a movement against a non-inventory-tracked product", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("mv-not-tracked");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeProduct(client, businessId, { p_sku: undefined, p_track_inventory: false });

    const { error } = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be rejected",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("PRODUCT_NOT_TRACKED");
  });

  it("rejects a movement against an inactive (archived) location", async () => {
    const { businessId, client, userId } = await createOwnerAndBusiness("mv-inactive-location");
    cleanupUserIds.push(userId);
    const product = await makeProduct(client, businessId);

    const sql = createTestDbClient();
    let secondLocationId: string;
    try {
      // Phase 1G made branch_id NOT NULL — attached to the business's own
      // default branch (which the OWNER caller below already has real
      // access to via ensure_member_branch_access.sql), so this test's own
      // ARCHIVED-location rejection is what's actually exercised, never a
      // branch-access rejection instead.
      const [{ id: defaultBranchId }] = await sql<{ id: string }[]>`
        select id from public.business_branches where business_id = ${businessId} and is_default = true
      `;
      const [row] = await sql`
        insert into public.inventory_locations (business_id, branch_id, name, is_branch_default, is_default, status, created_by)
        values (${businessId}, ${defaultBranchId}, 'Warehouse', false, false, 'archived', ${userId})
        returning id
      `;
      secondLocationId = row.id;
    } finally {
      await sql.end();
    }

    const { error } = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: secondLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Should be rejected",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("LOCATION_ARCHIVED");
  });

  it("rejects insufficient stock and leaves the ledger/balance unchanged (rollback)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("mv-insufficient");
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

    const { error } = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 5,
      p_idempotency_key: randomUuid(),
      p_reason: "Too much",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("INSUFFICIENT_STOCK");

    const { data: balance } = await client
      .from("inventory_balances")
      .select("quantity")
      .eq("product_id", product.id)
      .eq("inventory_location_id", locationId)
      .single();
    expect(Number(balance?.quantity)).toBe(2);

    const { data: ledgerRows } = await client
      .from("inventory_ledger")
      .select("id")
      .eq("product_id", product.id);
    expect(ledgerRows).toHaveLength(1); // only the opening stock row, the rejected one never landed
  });

  it("denies a role without inventory.adjust (VIEWER)", async () => {
    const owner = await createOwnerAndBusiness("mv-viewer-denied");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithRole(owner.businessId, "mv-viewer-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);
    const locationId = await getDefaultLocationId(owner.client, owner.businessId);
    const product = await makeProduct(owner.client, owner.businessId);

    const { error } = await viewer.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Denied",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("denies an inactive (suspended) member entirely", async () => {
    const owner = await createOwnerAndBusiness("mv-suspended");
    cleanupUserIds.push(owner.userId);
    const suspended = await createMemberWithRole(owner.businessId, "mv-suspended", "INVENTORY");
    cleanupUserIds.push(suspended.userId);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where user_id = ${suspended.userId}`;
    } finally {
      await sql.end();
    }

    const locationId = await getDefaultLocationId(owner.client, owner.businessId);
    const product = await makeProduct(owner.client, owner.businessId);

    const { error } = await suspended.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Denied",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("rejects a foreign product_id and a foreign inventory_location_id from another tenant", async () => {
    const a = await createOwnerAndBusiness("mv-foreign-a");
    const b = await createOwnerAndBusiness("mv-foreign-b");
    cleanupUserIds.push(a.userId, b.userId);

    const productA = await makeProduct(a.client, a.businessId);
    const locationA = await getDefaultLocationId(a.client, a.businessId);
    const locationB = await getDefaultLocationId(b.client, b.businessId);

    // Business B's own membership is valid, but the product belongs to A.
    const foreignProduct = await b.client.rpc("record_inventory_movement", {
      p_business_id: b.businessId,
      p_product_id: productA.id,
      p_inventory_location_id: locationB,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Forged product_id",
    });
    expect(foreignProduct.error).not.toBeNull();
    expect(foreignProduct.error?.message).toContain("PRODUCT_NOT_FOUND");

    const productB = await makeProduct(b.client, b.businessId);
    const foreignLocation = await b.client.rpc("record_inventory_movement", {
      p_business_id: b.businessId,
      p_product_id: productB.id,
      p_inventory_location_id: locationA,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 1,
      p_idempotency_key: randomUuid(),
      p_reason: "Forged location_id",
    });
    expect(foreignLocation.error).not.toBeNull();
    expect(foreignLocation.error?.message).toContain("LOCATION_NOT_FOUND");
  });

  it("composite FK rejects a cross-tenant (product, business) combination even through a direct privileged SQL INSERT", async () => {
    const a = await createOwnerAndBusiness("mv-composite-fk-a");
    const b = await createOwnerAndBusiness("mv-composite-fk-b");
    cleanupUserIds.push(a.userId, b.userId);

    const productA = await makeProduct(a.client, a.businessId);
    const locationB = await getDefaultLocationId(b.client, b.businessId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.inventory_ledger (
            business_id, inventory_location_id, product_id, movement_type,
            quantity_delta, balance_after, idempotency_key, reason, created_by
          ) values (
            ${b.businessId}, ${locationB}, ${productA.id}, 'ADJUSTMENT_IN',
            1, 1, ${randomUuid()}, 'cross tenant', ${b.userId}
          )
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});
