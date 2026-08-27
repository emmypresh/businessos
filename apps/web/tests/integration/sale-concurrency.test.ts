import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("sale-number allocation concurrency", () => {
  it("N concurrent create_sale calls (distinct creation_keys) allocate N distinct, unique sale_numbers", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-number-concurrent");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 100 });

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        client.rpc("create_sale", {
          p_business_id: businessId,
          p_creation_key: randomUuid(),
          p_items: [saleItem(product.id, 1)],
        })
      )
    );
    for (const r of results) expect(r.error).toBeNull();

    const { data: sales } = await client.from("sales").select("sale_number").eq("business_id", businessId);
    expect(sales).toHaveLength(N);
    const numbers = sales!.map((s) => s.sale_number);
    expect(new Set(numbers).size).toBe(N);
    for (const n of numbers) expect(n).toMatch(/^SALE-\d{6}$/);
  });

  it("a rolled-back attempt (DUPLICATE_PRODUCT_LINE) does not consume/reuse a sale_number for a subsequent success", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-number-rollback");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 100 });

    const failed = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1), saleItem(product.id, 1)],
    });
    expect(failed.error).not.toBeNull();

    const succeeded = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
    });
    expect(succeeded.error).toBeNull();

    // The counter increment lives in the same (rolled-back) transaction as
    // the failed attempt, so the first successful sale still gets
    // SALE-000001 — the failed attempt consumed nothing.
    const { data: sale } = await client.from("sales").select("sale_number").eq("id", succeeded.data!).single();
    expect(sale?.sale_number).toBe("SALE-000001");
  });
});

describe("overlapping-product concurrent sales (deadlock safety)", () => {
  it("two concurrent sales with reversed product order never deadlock (test O)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-concurrent-reversed-order");
    cleanupUserIds.push(userId);
    const p1 = await makeSaleProduct(client, businessId, { openingQuantity: 50 });
    const p2 = await makeSaleProduct(client, businessId, { openingQuantity: 50 });

    // Sale A enters items as [p1, p2] (as typed); Sale B enters the SAME
    // two products in the OPPOSITE order [p2, p1] — the RPC's own
    // internal sort should make both acquire product locks in the same
    // ascending-id order regardless.
    const [a, b] = await Promise.all([
      client.rpc("create_sale", {
        p_business_id: businessId, p_creation_key: randomUuid(),
        p_items: [saleItem(p1.id, 2), saleItem(p2.id, 3)],
      }),
      client.rpc("create_sale", {
        p_business_id: businessId, p_creation_key: randomUuid(),
        p_items: [saleItem(p2.id, 4), saleItem(p1.id, 5)],
      }),
    ]);

    // Both should succeed (ample stock, no deadlock); a deadlock would
    // surface as a Postgres "deadlock detected" error rather than a
    // clean success/failure on business logic.
    for (const r of [a, b]) {
      expect(r.error?.message ?? "").not.toMatch(/deadlock/i);
    }
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });

  it("stock=5 with two concurrent 5-unit sales of the same product: exactly one succeeds, balance never negative", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-concurrent-negative-stock");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });

    const [a, b] = await Promise.all([
      client.rpc("create_sale", {
        p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 5)],
      }),
      client.rpc("create_sale", {
        p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 5)],
      }),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("INSUFFICIENT_STOCK");

    const { data: balance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    expect(Number(balance?.quantity)).toBe(0);
    expect(Number(balance?.quantity)).toBeGreaterThanOrEqual(0);
  });
});
