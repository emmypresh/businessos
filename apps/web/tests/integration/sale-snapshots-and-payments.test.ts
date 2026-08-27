import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, getDefaultLocationId, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("sale historical snapshots", () => {
  it("test G: customer snapshots are unchanged after the customer is later edited", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-snap-customer-edit");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });
    const customerId = await makeCustomer(client, businessId, {
      name: "Original Customer", phone: "0801111111", email: "orig@example.test", address: "1 First St",
    });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)], p_customer_id: customerId,
    });
    expect(sale.error).toBeNull();

    await client.from("customers").update({
      name: "Edited Customer", phone: "0802222222", email: "edited@example.test", address: "2 Second St",
    }).eq("id", customerId);

    const { data: saleRow } = await client
      .from("sales")
      .select("customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot")
      .eq("id", sale.data!)
      .single();
    expect(saleRow?.customer_name_snapshot).toBe("Original Customer");
    expect(saleRow?.customer_phone_snapshot).toBe("0801111111");
    expect(saleRow?.customer_email_snapshot).toBe("orig@example.test");
    expect(saleRow?.customer_address_snapshot).toBe("1 First St");
  });

  it("test H: product snapshots are unchanged after the product is later edited", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-snap-product-edit");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, {
      name: "Original Product", sellingPrice: 777, openingQuantity: 5,
    });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();

    await client.from("products").update({ name: "Edited Product", selling_price: 99999, sku: `edited-${randomUuid()}` }).eq("id", product.id);

    const { data: item } = await client
      .from("sale_items")
      .select("product_name_snapshot, unit_price")
      .eq("sale_id", sale.data!)
      .single();
    expect(item?.product_name_snapshot).toBe("Original Product");
    expect(Number(item?.unit_price)).toBe(777);
  });

  it("location snapshot: sale records the location name at creation time, immune to a later rename", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-snap-location-rename");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });
    const locationId = await getDefaultLocationId(client, businessId);

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();

    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      await sql`update public.inventory_locations set name = 'Renamed Store' where id = ${locationId}`;
    } finally {
      await sql.end();
    }

    const { data: saleRow } = await client.from("sales").select("inventory_location_name_snapshot").eq("id", sale.data!).single();
    expect(saleRow?.inventory_location_name_snapshot).toBe("Main Store");
  });

  it("anonymous/walk-in sale: customer_id and every customer snapshot are null together", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-snap-anonymous");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();

    const { data: saleRow } = await client
      .from("sales")
      .select("customer_id, customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot")
      .eq("id", sale.data!)
      .single();
    expect(saleRow?.customer_id).toBeNull();
    expect(saleRow?.customer_name_snapshot).toBeNull();
    expect(saleRow?.customer_phone_snapshot).toBeNull();
    expect(saleRow?.customer_email_snapshot).toBeNull();
    expect(saleRow?.customer_address_snapshot).toBeNull();
  });

  it("cost non-disclosure: unit_cost_snapshot is captured but never SELECT-able by any authenticated role", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-cost-non-disclosure");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { costPrice: 321, sellingPrice: 999, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();

    // Confirmed CAPTURED, via the raw DB client (fixture-verification only,
    // never how the application reads it).
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ unit_cost_snapshot: string }[]>`
        select unit_cost_snapshot from public.sale_items where sale_id = ${sale.data!}
      `;
      expect(Number(rows[0].unit_cost_snapshot)).toBe(321);
    } finally {
      await sql.end();
    }

    // Confirmed NEVER SELECT-able via the real Data API, even with a
    // permission-holding OWNER session.
    const attempt = await client.from("sale_items").select("unit_cost_snapshot").eq("sale_id", sale.data!);
    expect(attempt.error).not.toBeNull();
    const attemptStar = await client.from("sale_items").select("*").eq("sale_id", sale.data!);
    expect(attemptStar.error).not.toBeNull();
  });
});

describe("sale structural CHECK constraints (direct DB-level proof, not just RPC behavior)", () => {
  it("a COMPLETED row without completed_at is rejected at the database level", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("sale-check-completed-biconditional");
    cleanupUserIds.push(userId);
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      const [loc] = await sql<{ id: string }[]>`select id from public.inventory_locations where business_id = ${businessId} limit 1`;
      await expect(
        sql`insert into public.sales (business_id, inventory_location_id, inventory_location_name_snapshot, sale_number, creation_key, created_by, status)
            values (${businessId}, ${loc.id}, 'x', 'SALE-000900', gen_random_uuid(), ${userId}, 'COMPLETED')`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("a non-null customer_id with all-null customer snapshots is rejected at the database level", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-check-customer-snapshot");
    cleanupUserIds.push(userId);
    const customerId = await makeCustomer(client, businessId);
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      const [loc] = await sql<{ id: string }[]>`select id from public.inventory_locations where business_id = ${businessId} limit 1`;
      await expect(
        sql`insert into public.sales (business_id, customer_id, inventory_location_id, inventory_location_name_snapshot, sale_number, creation_key, created_by)
            values (${businessId}, ${customerId}, ${loc.id}, 'x', 'SALE-000901', gen_random_uuid(), ${userId})`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("a null customer_id with a non-null customer snapshot is rejected at the database level", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("sale-check-anonymous-snapshot");
    cleanupUserIds.push(userId);
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      const [loc] = await sql<{ id: string }[]>`select id from public.inventory_locations where business_id = ${businessId} limit 1`;
      await expect(
        sql`insert into public.sales (business_id, customer_id, customer_name_snapshot, inventory_location_id, inventory_location_name_snapshot, sale_number, creation_key, created_by)
            values (${businessId}, null, 'Ghost Name', ${loc.id}, 'x', 'SALE-000902', gen_random_uuid(), ${userId})`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("sale payment invariants", () => {
  it("UNPAID requires amount_paid=0 and payment_method=null (defaults satisfy this)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-unpaid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 500, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();
    const { data: row } = await client.from("sales").select("payment_status, amount_paid, payment_method").eq("id", sale.data!).single();
    expect(row?.payment_status).toBe("UNPAID");
    expect(Number(row?.amount_paid)).toBe(0);
    expect(row?.payment_method).toBeNull();
  });

  it("UNPAID with a payment_method supplied is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-unpaid-with-method");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
      p_payment_status: "UNPAID", p_payment_method: "CASH",
    });
    expect(sale.error).not.toBeNull();
    expect(sale.error?.message).toContain("INVALID_PAYMENT_AMOUNT");
  });

  it("PAID forces amount_paid to the computed total regardless of caller input, requires payment_method when total>0", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-paid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 1500, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 2)],
      p_payment_status: "PAID", p_payment_method: "BANK_TRANSFER", p_amount_paid: 1,
    });
    expect(sale.error).toBeNull();
    const { data: row } = await client.from("sales").select("total, amount_paid").eq("id", sale.data!).single();
    expect(Number(row?.amount_paid)).toBe(Number(row?.total));
    expect(Number(row?.total)).toBe(3000);
  });

  it("PAID without a payment_method is rejected when total>0", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-paid-no-method");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 500, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID",
    });
    expect(sale.error).not.toBeNull();
    expect(sale.error?.message).toContain("INVALID_PAYMENT_AMOUNT");
  });

  it("PARTIALLY_PAID requires 0 < amount_paid < total and a payment_method", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-partial");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 1000, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 2)],
      p_payment_status: "PARTIALLY_PAID", p_payment_method: "CASH", p_amount_paid: 800,
    });
    expect(sale.error).toBeNull();
    const { data: row } = await client.from("sales").select("total, amount_paid").eq("id", sale.data!).single();
    expect(Number(row?.total)).toBe(2000);
    expect(Number(row?.amount_paid)).toBe(800);
  });

  it("PARTIALLY_PAID with amount_paid >= total is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-partial-too-much");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 1000, openingQuantity: 5 });

    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
      p_payment_status: "PARTIALLY_PAID", p_payment_method: "CASH", p_amount_paid: 1000,
    });
    expect(sale.error).not.toBeNull();
    expect(sale.error?.message).toContain("INVALID_PAYMENT_AMOUNT");
  });

  it("PARTIALLY_PAID with amount_paid<=0 or missing payment_method is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("sale-payment-partial-invalid");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 1000, openingQuantity: 5 });

    const zero = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
      p_payment_status: "PARTIALLY_PAID", p_payment_method: "CASH", p_amount_paid: 0,
    });
    expect(zero.error?.message).toContain("INVALID_PAYMENT_AMOUNT");

    const noMethod = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
      p_payment_status: "PARTIALLY_PAID", p_amount_paid: 300,
    });
    expect(noMethod.error?.message).toContain("INVALID_PAYMENT_AMOUNT");
  });
});
