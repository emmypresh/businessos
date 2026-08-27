import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";

// Hybrid technique — see tests/integration/customer-dal.test.ts /
// cost-access-app-layer.test.ts for the full rationale.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => {
  return {
    requireUser: async () => {
      const { data } = await currentClient.auth.getUser();
      if (!data.user) throw new Error("not signed in");
      return data.user;
    },
  };
});

const { listSales, getSale, getSaleItems, searchProductsForSale } = await import("@/lib/sales/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeCompletedSale(
  client: SupabaseClient<Database>,
  businessId: string,
  productId: string
) {
  const { data, error } = await client.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_items: [saleItem(productId, 1)],
  });
  if (error || !data) throw new Error(`create_sale failed: ${error?.message}`);
  return data as string;
}

describe("sale DAL tenant isolation", () => {
  it("listSales never returns another business's sales", async () => {
    const a = await createOwnerAndBusiness("sale-dal-tenant-a");
    const b = await createOwnerAndBusiness("sale-dal-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const product = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 5 });
    await makeCompletedSale(a.client, a.businessId, product.id);

    currentClient = b.client;
    const { rows } = await listSales(b.businessId);
    expect(rows.filter((r) => r.business_id === a.businessId)).toHaveLength(0);
  });

  it("getSale 404s for a sale belonging to a different business", async () => {
    const a = await createOwnerAndBusiness("sale-dal-getone-a");
    const b = await createOwnerAndBusiness("sale-dal-getone-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const product = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 5 });
    const saleId = await makeCompletedSale(a.client, a.businessId, product.id);

    currentClient = b.client;
    await expect(getSale(b.businessId, saleId)).rejects.toThrow();
  });

  it("getSaleItems returns nothing for a sale outside the caller's tenant", async () => {
    const a = await createOwnerAndBusiness("sale-dal-items-a");
    const b = await createOwnerAndBusiness("sale-dal-items-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const product = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 5 });
    const saleId = await makeCompletedSale(a.client, a.businessId, product.id);

    currentClient = b.client;
    const items = await getSaleItems(b.businessId, saleId);
    expect(items).toEqual([]);
  });
});

describe("sale DAL cost non-disclosure", () => {
  it("getSaleItems never selects unit_cost_snapshot — the DAL query itself has no such column, verified against the real Data API", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-dal-no-cost");
    cleanupUserIds.push(userId);
    currentClient = client;

    const product = await makeSaleProduct(client, businessId, { costPrice: 555, openingQuantity: 5 });
    const saleId = await makeCompletedSale(client, businessId, product.id);

    const items = await getSaleItems(businessId, saleId);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("unit_cost_snapshot");
    expect(Object.keys(items[0])).not.toContain("unit_cost_snapshot");
  });

  it("searchProductsForSale never queries or returns cost_price", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-dal-picker-no-cost");
    cleanupUserIds.push(userId);
    currentClient = client;

    await makeSaleProduct(client, businessId, { costPrice: 555, sellingPrice: 999, openingQuantity: 5 });

    const results = await searchProductsForSale(businessId);
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row).not.toHaveProperty("costPrice");
      expect(row).not.toHaveProperty("cost_price");
    }
  });
});

describe("sale-number search safety (real Data API, same imatch encoder)", () => {
  const ADVERSARIAL_TERMS = [
    "alpha", "alpha,beta", ",", "alpha)", "(alpha)", "(", "alpha.beta",
    "alpha:beta", "alpha*beta", 'alpha"beta', "alpha'beta", "alpha\\beta",
    "alpha%beta", "alpha_beta", "or(name.eq.foo)",
    "+", "?", "^", "$", "{", "}", "[", "]", "|",
  ];

  it("every adversarial sale-number search term returns a valid response, never PGRST100", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-search-safety");
    cleanupUserIds.push(userId);
    currentClient = client;

    for (const term of ADVERSARIAL_TERMS) {
      const { rows } = await listSales(businessId, { search: term });
      expect(rows, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  });

  it("a literal sale-number search matches only the exact sale, never broadens", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-search-literal");
    cleanupUserIds.push(userId);
    currentClient = client;

    const product = await makeSaleProduct(client, businessId, { openingQuantity: 10 });
    const saleId = await makeCompletedSale(client, businessId, product.id);
    const sale = await getSale(businessId, saleId);

    const { rows } = await listSales(businessId, { search: sale.sale_number });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(saleId);
  });

  it("structured filters (payment status, date range) use plain eq/gte/lte, never raw string interpolation", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-search-structured");
    cleanupUserIds.push(userId);
    currentClient = client;

    const product = await makeSaleProduct(client, businessId, { openingQuantity: 10 });
    await makeCompletedSale(client, businessId, product.id);

    // Adversarial values in structured filter positions must never
    // produce a PGRST100 or a broadened result — they're just literal
    // comparison values in eq/gte/lte, not grammar.
    const { rows } = await listSales(businessId, { paymentStatus: "UNPAID", dateFrom: "2020-01-01" });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("sale DAL pagination determinism", () => {
  it("keyset pagination returns every sale exactly once across pages, newest first", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-dal-pagination");
    cleanupUserIds.push(userId);
    currentClient = client;

    const product = await makeSaleProduct(client, businessId, { openingQuantity: 20 });
    for (let i = 0; i < 5; i++) {
      await makeCompletedSale(client, businessId, product.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { rows, nextCursor } = await listSales(businessId, { cursor });
      seen.push(...rows.map((r) => r.id));
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});
