import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid, createMemberWithRole } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_sale atomicity", () => {
  it("a multi-item sale where one line has insufficient stock rolls back EVERYTHING — no partial sale", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-atomic-fail");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);

    const plenty = await makeSaleProduct(client, businessId, { openingQuantity: 100 });
    const scarce = await makeSaleProduct(client, businessId, { openingQuantity: 2 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(plenty.id, 5), saleItem(scarce.id, 10)],
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INSUFFICIENT_STOCK");

    // Nothing committed: no sale row, no sale_items, plenty's stock untouched.
    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(0);

    const { data: plentyBalance } = await client
      .from("inventory_balances")
      .select("quantity")
      .eq("product_id", plenty.id)
      .eq("inventory_location_id", locationId)
      .single();
    expect(Number(plentyBalance?.quantity)).toBe(100);

    const { data: ledgerRows } = await client
      .from("inventory_ledger")
      .select("id")
      .eq("product_id", plenty.id)
      .eq("movement_type", "SALE");
    expect(ledgerRows).toHaveLength(0);
  });

  it("a fully valid multi-item sale deducts stock for every line and completes", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-atomic-success");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);

    const a = await makeSaleProduct(client, businessId, { openingQuantity: 50, sellingPrice: 1000 });
    const b = await makeSaleProduct(client, businessId, { openingQuantity: 50, sellingPrice: 2000 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(a.id, 4), saleItem(b.id, 2)],
    });
    expect(result.error).toBeNull();

    const { data: aBalance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", a.id).eq("inventory_location_id", locationId).single();
    expect(Number(aBalance?.quantity)).toBe(46);
    const { data: bBalance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", b.id).eq("inventory_location_id", locationId).single();
    expect(Number(bBalance?.quantity)).toBe(48);

    const { data: sale } = await client.from("sales").select("subtotal, total, status").eq("id", result.data!).single();
    expect(sale?.status).toBe("COMPLETED");
    expect(Number(sale?.subtotal)).toBe(4 * 1000 + 2 * 2000);
    expect(Number(sale?.total)).toBe(4 * 1000 + 2 * 2000);
  });

  it("DUPLICATE_PRODUCT_LINE is rejected — no sale, no stock movement (test D)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-dup-line");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 2), saleItem(product.id, 3)],
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("DUPLICATE_PRODUCT_LINE");

    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(0);
    const { data: balance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    expect(Number(balance?.quantity)).toBe(20);
  });

  it("unit_price is always the catalog selling_price — the RPC has no parameter for the caller to supply a price at all (tests E/F)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-price-authority");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 3333, openingQuantity: 10 });

    // The RPC's own type signature has no unit_price/price/amount field on
    // an item — supplying one is simply extraneous JSON the function never
    // reads, proving there is nothing for a forged value to influence.
    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 2, unit_price: 1 } as never],
    });
    expect(result.error).toBeNull();

    const { data: items } = await client.from("sale_items").select("unit_price, line_total").eq("sale_id", result.data!);
    expect(Number(items![0].unit_price)).toBe(3333);
    expect(Number(items![0].line_total)).toBe(3333 * 2);
  });

  it("a SALES-role caller cannot sell at a forged price either — price authority holds regardless of role (test F)", async () => {
    const { client: ownerClient, businessId, userId } = await createOwnerAndBusiness("sale-price-authority-sales-role");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(ownerClient, businessId, { sellingPrice: 4444, openingQuantity: 10 });

    const sales = await createMemberWithRole(businessId, "sale-price-sales", "SALES");
    cleanupUserIds.push(sales.userId);

    const result = await sales.client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 1, unit_price: 1 } as never],
    });
    expect(result.error).toBeNull();

    const { data: items } = await ownerClient.from("sale_items").select("unit_price").eq("sale_id", result.data!);
    expect(Number(items![0].unit_price)).toBe(4444);
  });

  it("quantity is normalized to numeric(14,3) identically for canonicalization, line_total, sale_items, and the inventory movement", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-qty-precision");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 100 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 2.5)],
    });
    expect(result.error).toBeNull();

    const { data: items } = await client.from("sale_items").select("quantity, line_total").eq("sale_id", result.data!);
    expect(Number(items![0].quantity)).toBe(2.5);
    expect(Number(items![0].line_total)).toBe(250);

    const { data: balance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    expect(Number(balance?.quantity)).toBe(97.5);
  });

  const MALFORMED_CASES: Array<[label: string, items: unknown]> = [
    ["not an array", { product_id: "x", quantity: 1 }],
    ["empty array", []],
    ["missing product_id", [{ quantity: 1 }]],
    ["product_id not a uuid shape", [{ product_id: "not-a-uuid", quantity: 1 }]],
    ["product_id is a number", [{ product_id: 12345, quantity: 1 }]],
    ["missing quantity", [{ product_id: "00000000-0000-0000-0000-000000000000" }]],
    ["quantity is a string", [{ product_id: "00000000-0000-0000-0000-000000000000", quantity: "3" }]],
    ["quantity is zero", [{ product_id: "00000000-0000-0000-0000-000000000000", quantity: 0 }]],
    ["quantity is negative", [{ product_id: "00000000-0000-0000-0000-000000000000", quantity: -1 }]],
    ["quantity is absurdly large", [{ product_id: "00000000-0000-0000-0000-000000000000", quantity: 99999999999 }]],
  ];

  it.each(MALFORMED_CASES)(
    "malformed items (%s) are rejected with a controlled error, never a raw Postgres cast/syntax error",
    async (_label, items) => {
      const { client, businessId, userId } = await createOwnerAndBusiness("sale-malformed");
      cleanupUserIds.push(userId);

      const result = await client.rpc("create_sale", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_items: items as never,
      });
      expect(result.error).not.toBeNull();
      // A controlled error carries our own message text and a normal
      // PostgREST-mapped SQLSTATE-derived code, never a raw
      // "invalid input syntax"/"numeric field overflow" message leaking
      // internal implementation detail.
      expect(result.error?.message).not.toMatch(/invalid input syntax|numeric field overflow|out of range/i);
    }
  );

  it("a hard maximum item count (100) is enforced", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-item-limit");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 1000 });

    const tooMany = Array.from({ length: 101 }, () => saleItem(product.id, 1));
    // 101 identical product_ids would also trip DUPLICATE_PRODUCT_LINE —
    // use distinct nonexistent-but-well-formed uuids instead so the count
    // check is exercised in isolation, before any product lookup.
    const distinctTooMany = Array.from({ length: 101 }, () => saleItem(randomUuid(), 1));
    void tooMany;

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: distinctTooMany,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("TOO_MANY_SALE_ITEMS");
  });

  it("exactly 100 items is accepted (boundary, not off-by-one)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-item-limit-boundary");
    cleanupUserIds.push(userId);

    const products = [];
    for (let i = 0; i < 100; i++) {
      products.push(await makeSaleProduct(client, businessId, { openingQuantity: 5 }));
    }
    const items = products.map((p) => saleItem(p.id, 1));

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: items,
    });
    expect(result.error).toBeNull();

    const { data: saleItems } = await client.from("sale_items").select("id").eq("sale_id", result.data!);
    expect(saleItems).toHaveLength(100);
  }, 30000);

  it("customer/product foreign to another business are rejected", async () => {
    const a = await createOwnerAndBusiness("sale-foreign-a");
    const b = await createOwnerAndBusiness("sale-foreign-b");
    cleanupUserIds.push(a.userId, b.userId);

    const foreignCustomer = await makeCustomer(a.client, a.businessId);
    const foreignProduct = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 10 });

    const wrongCustomer = await b.client.rpc("create_sale", {
      p_business_id: b.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem((await makeSaleProduct(b.client, b.businessId)).id, 1)],
      p_customer_id: foreignCustomer,
    });
    expect(wrongCustomer.error).not.toBeNull();
    expect(wrongCustomer.error?.message).toContain("CUSTOMER_NOT_FOUND");

    const wrongProduct = await b.client.rpc("create_sale", {
      p_business_id: b.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(foreignProduct.id, 1)],
    });
    expect(wrongProduct.error).not.toBeNull();
    expect(wrongProduct.error?.message).toContain("PRODUCT_NOT_FOUND");
  });
});
