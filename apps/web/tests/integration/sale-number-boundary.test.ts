import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

/**
 * lpad(string, length) TRUNCATES (keeping only the leftmost `length`
 * characters) when the input is already longer than `length` — confirmed
 * live: lpad('1000000', 6, '0') = '100000', which collides with the
 * truncated form of 1000001 too. The fix (greatest(6, length(...))) is
 * exercised here by driving the real business_sale_sequences counter up
 * to and past the six-digit boundary via a raw-SQL fixture (the
 * documented, race-safe way to reach this state — no application RPC
 * exists to set the counter directly, and Phase 1D does not need one),
 * then creating every sale through the REAL create_sale RPC.
 */
describe("sale_number formatting never truncates above 999999", () => {
  it("999998 -> 999999 -> 1000000 -> 1000001: exact values, no truncation, no collision", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-number-boundary");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 100 });

    const sql = createTestDbClient();
    try {
      // Force the business's counter to 999998 as its NEXT allocation —
      // the same lazy INSERT ... ON CONFLICT DO UPDATE the RPC itself
      // uses, just pre-seeded to the boundary instead of starting at 1.
      await sql`
        insert into private.business_sale_sequences (business_id, next_number)
        values (${businessId}, 999998)
        on conflict (business_id) do update set next_number = 999998
      `;
    } finally {
      await sql.end();
    }

    const expected = ["SALE-999998", "SALE-999999", "SALE-1000000", "SALE-1000001"];
    const saleIds: string[] = [];

    for (const expectedNumber of expected) {
      const result = await client.rpc("create_sale", {
        p_business_id: businessId,
        p_creation_key: randomUuid(),
        p_items: [saleItem(product.id, 1)],
      });
      expect(result.error, `allocating ${expectedNumber}`).toBeNull();
      saleIds.push(result.data!);

      const { data: sale } = await client.from("sales").select("sale_number").eq("id", result.data!).single();
      expect(sale?.sale_number, `expected ${expectedNumber}`).toBe(expectedNumber);
    }

    // Uniqueness: no collision even at the truncation boundary — 1000000
    // and 1000001 must never both resolve to the same truncated string.
    const { data: allSales } = await client.from("sales").select("sale_number").eq("business_id", businessId);
    const numbers = allSales!.map((s) => s.sale_number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.sort()).toEqual([...expected].sort());
    expect(new Set(saleIds).size).toBe(saleIds.length);
  });

  it("a seven-digit sale_number is never truncated to six digits (direct boundary proof for 1000000)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-number-1000000-direct");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });

    const sql = createTestDbClient();
    try {
      await sql`
        insert into private.business_sale_sequences (business_id, next_number)
        values (${businessId}, 1000000)
        on conflict (business_id) do update set next_number = 1000000
      `;
    } finally {
      await sql.end();
    }

    const result = await client.rpc("create_sale", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
    });
    expect(result.error).toBeNull();

    const { data: sale } = await client.from("sales").select("sale_number").eq("id", result.data!).single();
    // The buggy lpad(text, 6, '0') would have produced 'SALE-100000' here.
    expect(sale?.sale_number).toBe("SALE-1000000");
    expect(sale?.sale_number).not.toBe("SALE-100000");
  });
});
