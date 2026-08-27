import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

// numeric(14,2)'s exact maximum representable value (12 digits before the
// decimal point, 2 after) — mirrors the v_max_money constant in
// create_sale itself.
const MAX_MONEY = 999999999999.99;

describe("create_sale numeric overflow fails safely (never a raw Postgres error)", () => {
  it("discount = 1e100 is rejected with SALE_AMOUNT_OUT_OF_RANGE, never a raw overflow error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-discount");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 10 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_discount: 1e100,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("SALE_AMOUNT_OUT_OF_RANGE");
    expect(result.error?.message).not.toMatch(/numeric field overflow|out of range/i);
  });

  it("amount_paid = 1e100 (PARTIALLY_PAID) is rejected with SALE_AMOUNT_OUT_OF_RANGE, never a raw overflow error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-amount-paid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 5000, openingQuantity: 10 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_payment_status: "PARTIALLY_PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1e100,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("SALE_AMOUNT_OUT_OF_RANGE");
    expect(result.error?.message).not.toMatch(/numeric field overflow|out of range/i);
  });

  it("a valid numeric(14,2) selling_price times a valid quantity that would exceed numeric(14,2) is rejected (line_total overflow)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-line-total");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    // selling_price itself is a perfectly valid numeric(14,2) value (the
    // maximum representable one); the CHECK on products.selling_price
    // only requires >= 0, no upper bound, so this is a realistic
    // adversarial/misconfigured-catalog scenario, not a contrived one.
    const product = await makeSaleProduct(client, businessId, {
      sellingPrice: MAX_MONEY,
      openingQuantity: 1000,
    });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1000)],
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("SALE_AMOUNT_OUT_OF_RANGE");
    expect(result.error?.message).not.toMatch(/numeric field overflow|out of range/i);

    // Rollback proven: no sale, no sale_items, stock untouched.
    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(0);
    const { data: balance } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    expect(Number(balance?.quantity)).toBe(1000);
  });

  it("many valid-individually line_totals whose SUM exceeds numeric(14,2) are rejected (subtotal overflow)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-subtotal");
    cleanupUserIds.push(userId);
    // Each line's own total (price * qty) individually fits numeric(14,2)
    // comfortably, but two of them summed together exceed it — proving
    // the accumulator check, not just the per-line check, is real.
    const perLineTotal = MAX_MONEY * 0.6;
    const a = await makeSaleProduct(client, businessId, { sellingPrice: perLineTotal, openingQuantity: 5 });
    const b = await makeSaleProduct(client, businessId, { sellingPrice: perLineTotal, openingQuantity: 5 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(a.id, 1), saleItem(b.id, 1)],
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("SALE_AMOUNT_OUT_OF_RANGE");
    expect(result.error?.message).not.toMatch(/numeric field overflow|out of range/i);

    const { data: sales } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(sales).toHaveLength(0);
  });

  it("rollback and idempotency: an overflow-rejected attempt leaves nothing behind, and the same creation_key succeeds when retried with valid data", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-rollback-idempotency");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: MAX_MONEY, openingQuantity: 1000 });
    const key = randomUuid();

    const failed = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: key,
      p_items: [saleItem(product.id, 1000)], // overflows line_total
    });
    expect(failed.error?.message).toContain("SALE_AMOUNT_OUT_OF_RANGE");

    // Nothing committed for the failed attempt: no sale row, no
    // sale_items, no inventory movement, and — critically — the
    // request-ledger claim itself rolled back too (proven below by a
    // successful retry under the SAME key).
    const { data: salesAfterFail } = await client.from("sales").select("id").eq("business_id", businessId);
    expect(salesAfterFail).toHaveLength(0);
    const { data: ledgerAfterFail } = await client
      .from("inventory_ledger").select("id").eq("product_id", product.id).eq("movement_type", "SALE");
    expect(ledgerAfterFail).toHaveLength(0);
    const { data: balanceAfterFail } = await client
      .from("inventory_balances").select("quantity").eq("product_id", product.id).eq("inventory_location_id", locationId).single();
    expect(Number(balanceAfterFail?.quantity)).toBe(1000);

    // Retry the SAME creation_key with valid data (a small, in-range
    // quantity) — this only succeeds if the failed attempt's claim row
    // was genuinely rolled back, not left behind to collide.
    const retried = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: key,
      p_items: [saleItem(product.id, 1)],
    });
    expect(retried.error).toBeNull();

    const { data: item } = await client.from("sale_items").select("line_total").eq("sale_id", retried.data!).single();
    expect(Number(item?.line_total)).toBeCloseTo(MAX_MONEY, 1);
  });

  it("PAID with an extreme (but in-range-shaped) total still derives amount_paid safely from the computed total, never the caller's own overflow-prone value", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("overflow-paid-derivation");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 500000, openingQuantity: 10 });

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 2)],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      // An absurd caller-supplied amount_paid — PAID's own canonicalization
      // (correction 4, prior round) already ignores this value entirely;
      // it must never reach an overflow-prone assignment either.
      p_amount_paid: 1e100,
    });
    expect(result.error).toBeNull();

    const { data: sale } = await client.from("sales").select("total, amount_paid").eq("id", result.data!).single();
    expect(Number(sale?.amount_paid)).toBe(Number(sale?.total));
    expect(Number(sale?.total)).toBe(1000000);
  });
});
