import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid } from "./helpers/inventory";
import { makeSaleProduct } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

/**
 * Excess-precision quantities (more than 3 decimal places) must be
 * REJECTED, never silently rounded into numeric(14,3) — a rounded
 * quantity would deduct a different amount of stock than the caller
 * literally stated, and two distinct excess-precision requests could
 * silently collapse to the same rounded value. Every case here is
 * verified against the real local Data API, not just the encoder's own
 * logic.
 */
describe("create_sale quantity precision (test A/B/C)", () => {
  const ACCEPTED = ["1", "1.0", "1.2", "1.23", "1.234", "0.001", "999.999"];
  const REJECTED = ["1.2345", "0.0001", "1.2349", "999.9999"];

  it.each(ACCEPTED.map((q) => [q, Number(q)] as const))(
    "quantity %s is accepted exactly (test A)",
    async (label, quantity) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("qty-accept");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 1000 });

      const result = await client.rpc("create_sale", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_items: [{ product_id: product.id, quantity }],
      });
      expect(result.error, `quantity=${label}`).toBeNull();

      const { data: item } = await client.from("sale_items").select("quantity").eq("sale_id", result.data!).single();
      expect(Number(item?.quantity), `quantity=${label}`).toBeCloseTo(quantity, 3);

      const { data: balance } = await client
        .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
      expect(Number(balance?.quantity)).toBeCloseTo(1000 - quantity, 3);
    }
  );

  it.each(REJECTED.map((q) => [q, Number(q)] as const))(
    "quantity %s is rejected as MALFORMED_SALE_ITEMS, never silently rounded (test B/C)",
    async (label, quantity) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("qty-reject");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 1000 });

      const result = await client.rpc("create_sale", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_items: [{ product_id: product.id, quantity }],
      });
      expect(result.error, `quantity=${label}`).not.toBeNull();
      expect(result.error?.message, `quantity=${label}`).toContain("MALFORMED_SALE_ITEMS");

      // test D: no sale, no sale_items, no SALE ledger row, no stock
      // change, no committed request claim — the failed attempt left
      // nothing behind at all.
      const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
      expect(sales, `quantity=${label}`).toHaveLength(0);
      const { data: items } = await client.from("sale_items").select("id").eq("business_id", businessId);
      expect(items, `quantity=${label}`).toHaveLength(0);
      const { data: ledger } = await client
        .from("inventory_ledger").select("id").eq("product_id", product.id).eq("movement_type", "SALE");
      expect(ledger, `quantity=${label}`).toHaveLength(0);
      const { data: balance } = await client
        .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
      expect(Number(balance?.quantity), `quantity=${label}`).toBe(1000);
    }
  );

  it("test E: retrying the same creation_key with corrected valid quantity succeeds", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("qty-retry-corrected");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 1000 });
    const key = randomUuid();

    const failed = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key,
      p_items: [{ product_id: product.id, quantity: 1.2345 }],
    });
    expect(failed.error?.message).toContain("MALFORMED_SALE_ITEMS");

    const retried = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key,
      p_items: [{ product_id: product.id, quantity: 1.234 }],
    });
    expect(retried.error).toBeNull();

    const { data: item } = await client.from("sale_items").select("quantity").eq("sale_id", retried.data!).single();
    expect(Number(item?.quantity)).toBeCloseTo(1.234, 3);
  });

  it("test F: distinct excess-precision requests under the same creation_key never silently collapse into each other", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("qty-precision-no-collapse");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 1000 });
    const key = randomUuid();

    // Request A: a genuinely valid quantity (1.234) succeeds.
    const a = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key,
      p_items: [{ product_id: product.id, quantity: 1.234 }],
    });
    expect(a.error).toBeNull();

    // Request B under the SAME key with excess precision (1.2344, which
    // does not round-trip through numeric(14,3)) must NEVER be treated as
    // a replay of A — it must fail on its own malformed-input shape, not
    // silently succeed by rounding down to 1.234 and matching A's stored
    // canonical payload.
    const b = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: key,
      p_items: [{ product_id: product.id, quantity: 1.2344 }],
    });
    expect(b.error).not.toBeNull();
    // Either outcome is an acceptable REJECTION (never a silent success
    // returning A's sale_id) — in this implementation the malformed-shape
    // check runs before the idempotency replay decision, so it always
    // surfaces as MALFORMED_SALE_ITEMS, never SALE_IDEMPOTENCY_KEY_REUSED.
    expect(b.error?.message).toContain("MALFORMED_SALE_ITEMS");
    expect(b.data).not.toBe(a.data);

    // Only the one sale from request A exists.
    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(1);
    expect(sales![0].id).toBe(a.data);
  });

  it.each([["1.2344", 1.2344], ["1.23449", 1.23449], ["1.2345", 1.2345], ["1.2349", 1.2349]] as const)(
    "no value with more than 3 meaningful decimals (%s) ever reaches inventory mutation",
    async (label, quantity) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("qty-no-mutation");
      cleanupUserIds.push(userId);
      const locationId = await getDefaultLocationId(client, businessId);
      const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 1000 });

      const result = await client.rpc("create_sale", {
        p_business_id: businessId, p_creation_key: randomUuid(),
        p_items: [{ product_id: product.id, quantity }],
      });
      expect(result.error, `quantity=${label}`).not.toBeNull();

      const { data: balance } = await client
        .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
      expect(Number(balance?.quantity), `quantity=${label}`).toBe(1000);
    }
  );
});
