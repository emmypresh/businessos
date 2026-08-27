import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_sale idempotency and replay ordering", () => {
  it("concurrent identical requests under the same creation_key produce exactly one sale and one stock deduction", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-idem-concurrent");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const key = randomUuid();

    const payload = {
      p_business_id: businessId,
      p_creation_key: key,
      p_items: [saleItem(product.id, 3)],
    };

    const [a, b] = await Promise.all([client.rpc("create_sale", payload), client.rpc("create_sale", payload)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).toBe(b.data);

    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(1);

    const { data: balance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    // Deducted exactly once (17), never twice (14).
    expect(Number(balance?.quantity)).toBe(17);
  });

  it("a different payload under the same creation_key is rejected, original sale untouched", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-idem-conflict");
    cleanupUserIds.push(userId);
    const a = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const b = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const key = randomUuid();

    const first = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(a.id, 1)],
    });
    expect(first.error).toBeNull();

    const conflicting = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(b.id, 1)],
    });
    expect(conflicting.error).not.toBeNull();
    expect(conflicting.error?.message).toContain("SALE_IDEMPOTENCY_KEY_REUSED");

    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(1);
    expect(sales![0].id).toBe(first.data);
  });

  it("test A: exact retry after the referenced customer is archived still returns the original sale", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-replay-customer-archived");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const customerId = await makeCustomer(client, businessId);
    const key = randomUuid();

    const payload = {
      p_business_id: businessId, p_creation_key: key,
      p_items: [saleItem(product.id, 1)], p_customer_id: customerId,
    };
    const original = await client.rpc("create_sale", payload);
    expect(original.error).toBeNull();

    const { error: archiveErr } = await client.from("customers").update({ status: "archived" }).eq("id", customerId);
    expect(archiveErr).toBeNull();

    const replay = await client.rpc("create_sale", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);
  });

  it("test B: exact retry after the referenced product is renamed/repriced/archived still returns the original sale", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-replay-product-mutated");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20, sellingPrice: 500 });
    const key = randomUuid();

    const payload = { p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 2)] };
    const original = await client.rpc("create_sale", payload);
    expect(original.error).toBeNull();

    const { error: renameErr } = await client
      .from("products")
      .update({ name: "Renamed After Sale", sku: `renamed-${randomUuid()}`, selling_price: 999999 })
      .eq("id", product.id);
    expect(renameErr).toBeNull();

    // Zero the remaining stock (18) before archiving — Phase 1C's own
    // enforce_zero_stock_before_archive trigger correctly blocks
    // archiving a product that still holds stock; this fixture must
    // respect that invariant, not work around it.
    const locationId = await getDefaultLocationId(client, businessId);
    const zeroOut = await client.rpc("record_inventory_movement", {
      p_business_id: businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 18,
      p_idempotency_key: randomUuid(),
      p_reason: "Zero out before archiving in test fixture",
    });
    expect(zeroOut.error).toBeNull();

    const { error: archiveErr } = await client.from("products").update({ status: "archived" }).eq("id", product.id);
    expect(archiveErr).toBeNull();

    const replay = await client.rpc("create_sale", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);

    // The original sale's own snapshot is unaffected either.
    const { data: items } = await client.from("sale_items").select("unit_price, product_name_snapshot").eq("sale_id", original.data!);
    expect(Number(items![0].unit_price)).toBe(500);
    expect(items![0].product_name_snapshot).not.toBe("Renamed After Sale");
  });

  it("test C: exact retry after the business's default location changes returns the original sale/location, no conflict", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-replay-location-changed");
    cleanupUserIds.push(userId);
    const originalLocationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const key = randomUuid();

    const payload = { p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 1)] };
    const original = await client.rpc("create_sale", payload);
    expect(original.error).toBeNull();

    // Change the default location: create a second one and swap defaults
    // directly (Phase 1D has no location-management RPC yet — this is
    // fixture setup via the raw DB client, matching the established
    // pattern for states no application RPC can reach).
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      await sql`update public.inventory_locations set is_default = false where business_id = ${businessId}`;
      await sql`insert into public.inventory_locations (business_id, name, is_default, status, created_by)
        values (${businessId}, 'Second Store', true, 'active', ${userId})`;
    } finally {
      await sql.end();
    }

    const replay = await client.rpc("create_sale", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);

    const { data: sale } = await client.from("sales").select("inventory_location_id").eq("id", original.data!).single();
    expect(sale?.inventory_location_id).toBe(originalLocationId);
  });

  it("test N: the same items supplied in a different order produce a byte-identical canonical payload (no duplicate sale, no conflict)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-item-order-canonical");
    cleanupUserIds.push(userId);
    const a = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const b = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const key = randomUuid();

    const first = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(a.id, 1), saleItem(b.id, 2)],
    });
    expect(first.error).toBeNull();

    // Same key, same items, REVERSED order — must be recognized as the
    // identical request, not a conflicting one.
    const reordered = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(b.id, 2), saleItem(a.id, 1)],
    });
    expect(reordered.error).toBeNull();
    expect(reordered.data).toBe(first.data);
  });

  it("payment: same semantic request does not conflict merely because an ignored amount_paid differs (UNPAID)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-ignored-amount-unpaid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    const key = randomUuid();

    const first = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 1)],
      p_payment_status: "UNPAID", p_amount_paid: 0,
    });
    expect(first.error).toBeNull();

    // A different (ignored, since UNPAID) amount_paid must still replay
    // as the identical request.
    const replay = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 1)],
      p_payment_status: "UNPAID", p_amount_paid: 99999,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);
  });

  it("payment: same semantic request does not conflict merely because an ignored amount_paid differs (PAID)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-ignored-amount-paid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20, sellingPrice: 1000 });
    const key = randomUuid();

    const first = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID", p_payment_method: "CASH", p_amount_paid: 1,
    });
    expect(first.error).toBeNull();

    const replay = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key, p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID", p_payment_method: "CASH", p_amount_paid: 777777,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);

    const { data: sale } = await client.from("sales").select("amount_paid, total").eq("id", first.data!).single();
    expect(Number(sale?.amount_paid)).toBe(Number(sale?.total));
  });

  it("create_sale's RPC response contains only the bare sale_id (test K)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-narrow-return");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(result.error).toBeNull();
    expect(typeof result.data).toBe("string");
    expect(result.data).toMatch(/^[0-9a-f-]{36}$/);
  });
});
