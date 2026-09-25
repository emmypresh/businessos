import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  randomUuid,
  setBusinessCountryCurrencyForTest,
} from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1Q-0C Slice 3: products.currency_code derives from the owning
// business, never a client-supplied value or the old hardcoded 'NGN'
// default (20260924080000_product_currency_from_business.sql). Mirrors
// tests/integration/sales-payments-refunds-reporting-currency.test.ts's
// own pattern exactly. The non-NGN activation gate inside create_business
// stays CLOSED throughout this file — every non-NG fixture is produced
// via setBusinessCountryCurrencyForTest, never by calling create_business
// itself with a non-NG country.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("products.currency_code derives from the owning business, never a client-supplied value or a hardcoded default", () => {
  it("an NG business's product is durably NGN when no currency is specified", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-ng");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "NG Product",
      p_sku: `ng-cur-${randomUuid()}`,
      p_selling_price: 500,
    });
    expect(error).toBeNull();
    expect(data?.currency_code).toBe("NGN");
  });

  it("an NG business's product created with an explicit, matching NGN currency succeeds", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-ng-explicit");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "NG Product Explicit",
      p_sku: `ng-cur-exp-${randomUuid()}`,
      p_selling_price: 500,
      p_currency_code: "NGN",
    });
    expect(error).toBeNull();
    expect(data?.currency_code).toBe("NGN");
  });

  it("an NG business's product creation is REJECTED when a mismatched currency (USD) is explicitly requested", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-ng-usd");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Spoofed USD Product",
      p_sku: `ng-cur-usd-${randomUuid()}`,
      p_selling_price: 500,
      p_currency_code: "USD",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("PRODUCT_CURRENCY_MISMATCH");
    expect(data).toBeNull();
  });

  it("a GH-fixture business's product is durably GHS, even though nothing in the create call mentions currency", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-gh");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GH", "GHS");

    const { data, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "GH Product",
      p_sku: `gh-cur-${randomUuid()}`,
      p_selling_price: 750,
    });
    expect(error).toBeNull();
    expect(data?.currency_code).toBe("GHS");
  });

  it("a GH-fixture business's product creation is REJECTED when the old NGN default is explicitly requested", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-gh-ngn");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GH", "GHS");

    const { data, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Spoofed NGN Product",
      p_sku: `gh-cur-ngn-${randomUuid()}`,
      p_selling_price: 750,
      p_currency_code: "NGN",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("PRODUCT_CURRENCY_MISMATCH");
    expect(data).toBeNull();
  });

  it.each([
    ["KE", "KES"],
    ["ZA", "ZAR"],
    ["GB", "GBP"],
    ["US", "USD"],
  ] as const)(
    "a %s-fixture business's product is durably %s when no currency is specified",
    async (country, currency) => {
      const owner = await createOwnerAndBusiness(`prod-cur-${country.toLowerCase()}`);
      cleanupUserIds.push(owner.userId);
      await setBusinessCountryCurrencyForTest(owner.businessId, country, currency);

      const { data, error } = await owner.client.rpc("create_product", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_name: `${country} Product`,
        p_sku: `${country.toLowerCase()}-cur-${randomUuid()}`,
        p_selling_price: 500,
      });
      expect(error).toBeNull();
      expect(data?.currency_code).toBe(currency);
    }
  );

  it.each([
    ["KE", "KES"],
    ["ZA", "ZAR"],
    ["GB", "GBP"],
    ["US", "USD"],
  ] as const)(
    "a %s-fixture business's product created with an explicit, matching %s currency succeeds",
    async (country, currency) => {
      const owner = await createOwnerAndBusiness(`prod-cur-${country.toLowerCase()}-exp`);
      cleanupUserIds.push(owner.userId);
      await setBusinessCountryCurrencyForTest(owner.businessId, country, currency);

      const { data, error } = await owner.client.rpc("create_product", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_name: `${country} Product Explicit`,
        p_sku: `${country.toLowerCase()}-cur-exp-${randomUuid()}`,
        p_selling_price: 500,
        p_currency_code: currency,
      });
      expect(error).toBeNull();
      expect(data?.currency_code).toBe(currency);
    }
  );

  it.each([
    ["KE", "KES"],
    ["ZA", "ZAR"],
    ["GB", "GBP"],
    ["US", "USD"],
  ] as const)(
    "a %s-fixture business's product creation is REJECTED when a mismatched currency (NGN) is explicitly requested",
    async (country, currency) => {
      const owner = await createOwnerAndBusiness(`prod-cur-${country.toLowerCase()}-mismatch`);
      cleanupUserIds.push(owner.userId);
      await setBusinessCountryCurrencyForTest(owner.businessId, country, currency);

      const { data, error } = await owner.client.rpc("create_product", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_name: "Spoofed NGN Product",
        p_sku: `${country.toLowerCase()}-cur-ngn-${randomUuid()}`,
        p_selling_price: 500,
        p_currency_code: "NGN",
      });
      expect(error).not.toBeNull();
      expect(error?.message).toContain("PRODUCT_CURRENCY_MISMATCH");
      expect(data).toBeNull();
    }
  );

  it.each([
    ["KE", "KES"],
    ["ZA", "ZAR"],
    ["GB", "GBP"],
    ["US", "USD"],
  ] as const)(
    "a %s-fixture business's direct database insert of a product with a mismatched currency_code is rejected",
    async (country, currency) => {
      const owner = await createOwnerAndBusiness(`prod-cur-${country.toLowerCase()}-direct`);
      cleanupUserIds.push(owner.userId);
      await setBusinessCountryCurrencyForTest(owner.businessId, country, currency);

      const sql = createTestDbClient();
      try {
        await expect(
          sql`
            insert into public.products (
              business_id, name, sku, currency_code, creation_key, created_by
            )
            select ${owner.businessId}, 'Direct Insert Product', ${"direct-" + randomUuid()}, 'NGN', ${randomUuid()}, id
            from auth.users where id = ${owner.userId}
          `
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    }
  );

  it("a GB-fixture business's product currency cannot be changed away from GBP via a direct authenticated UPDATE, and the stored value is unchanged", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-gb-immutable");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GB", "GBP");

    const { data: product, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "GB Update Target Product",
      p_sku: `gb-update-target-${randomUuid()}`,
      p_selling_price: 300,
    });
    expect(error).toBeNull();
    expect(product?.currency_code).toBe("GBP");

    const sql = createTestDbClient();
    try {
      await expect(
        sql`update public.products set currency_code = 'USD' where id = ${product?.id as string}`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }

    const { data: unchanged } = await owner.client
      .from("products")
      .select("currency_code")
      .eq("id", product?.id as string)
      .single();
    expect(unchanged?.currency_code).toBe("GBP");
  });

  it("a direct database insert of a product with a currency_code that does not match its own business is rejected", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-direct-mismatch");
    cleanupUserIds.push(owner.userId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.products (
            business_id, name, sku, currency_code, creation_key, created_by
          )
          select ${owner.businessId}, 'Direct Insert Product', ${"direct-" + randomUuid()}, 'USD', ${randomUuid()}, id
          from auth.users where id = ${owner.userId}
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("a direct database UPDATE attempting to change a product's currency_code away from its business's currency is rejected", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-direct-update");
    cleanupUserIds.push(owner.userId);

    const { data: product, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Update Target Product",
      p_sku: `update-target-${randomUuid()}`,
      p_selling_price: 300,
    });
    expect(error).toBeNull();

    const sql = createTestDbClient();
    try {
      await expect(
        sql`update public.products set currency_code = 'USD' where id = ${product?.id as string}`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }

    // The row itself is unchanged — the rejected UPDATE never partially
    // applied.
    const { data: unchanged } = await owner.client
      .from("products")
      .select("currency_code")
      .eq("id", product?.id as string)
      .single();
    expect(unchanged?.currency_code).toBe("NGN");
  });

  it("updateProduct's own client-facing UPDATE grant no longer includes currency_code at all", async () => {
    const owner = await createOwnerAndBusiness("prod-cur-grant");
    cleanupUserIds.push(owner.userId);

    const { data: product, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Grant Check Product",
      p_sku: `grant-check-${randomUuid()}`,
      p_selling_price: 300,
    });
    expect(error).toBeNull();

    // Even via the authenticated client's own row-level UPDATE (not the
    // service-role SQL client above), currency_code is no longer a
    // grantable column — this proves the client-facing surface, not just
    // the trigger backstop, is closed.
    const { error: updateError } = await owner.client
      .from("products")
      .update({ currency_code: "USD" } as never)
      .eq("id", product?.id as string);
    expect(updateError).not.toBeNull();
  });
});
