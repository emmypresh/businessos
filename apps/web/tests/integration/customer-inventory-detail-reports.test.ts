// Phase 1N-C3 — Customer & Inventory Detailed Report RPCs.
// Mirrors sales-customers-acl.test.ts / branch-aware-default-sync.test.ts's
// own fixture conventions exactly (createOwnerAndBusiness,
// createMemberWithCustomPermissions, raw sql for completed_at backdating).
import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const FAR_PAST = "2020-01-01T00:00:00Z";
const FAR_FUTURE = "2030-01-01T00:00:00Z";

async function backdateSaleCompletedAt(saleId: string, isoTimestamp: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.sales set completed_at = ${isoTimestamp}::timestamptz where id = ${saleId}`;
  } finally {
    await sql.end();
  }
}

describe("get_customer_detail_report", () => {
  it("rejects a caller without reports.view", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-report-noperm");
    cleanupUserIds.push(userId);
    const staff = await createMemberWithCustomPermissions(businessId, "cust-report-noperm", ["customers.view"]);
    cleanupUserIds.push(staff.userId);

    const { error } = await staff.client.rpc("get_customer_detail_report", {
      p_business_id: businessId,
      p_from: FAR_PAST,
      p_to: FAR_FUTURE,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/insufficient_privilege|permission/i);
    void client;
  });

  it("returns the real aggregate for a caller with reports.view alone (no sales.view/customers.view)", async () => {
    const owner = await createOwnerAndBusiness("cust-report-agg");
    cleanupUserIds.push(owner.userId);

    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Ada Repeat" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 50, sellingPrice: 1000 });

    const saleOld = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(saleOld.error).toBeNull();
    await backdateSaleCompletedAt(saleOld.data as string, "2024-01-01T00:00:00Z");

    const saleNew = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 2)],
    });
    expect(saleNew.error).toBeNull();
    await backdateSaleCompletedAt(saleNew.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-agg", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);

    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId,
      p_from: "2025-01-01T00:00:00Z",
      p_to: "2025-12-31T00:00:00Z",
      p_sort: "revenue",
      p_direction: "desc",
    });
    expect(error).toBeNull();
    const report = data as {
      kpis: { active_customers: number; returning_customers: number; new_customers: number; revenue: number };
      rows: { customer_id: string; total_orders: number; is_returning: boolean; is_new: boolean }[];
      total_count: number;
    };
    expect(report.kpis.active_customers).toBe(1);
    expect(report.kpis.returning_customers).toBe(1);
    expect(report.kpis.new_customers).toBe(0);
    expect(report.total_count).toBeGreaterThanOrEqual(1);
    const row = report.rows.find((r) => r.customer_id === customerId);
    expect(row?.total_orders).toBe(1);
    expect(row?.is_returning).toBe(true);
    expect(row?.is_new).toBe(false);
  });

  it("classifies a customer's first-ever purchase inside the window as new, not returning", async () => {
    const owner = await createOwnerAndBusiness("cust-report-new");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-new", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { kpis: { new_customers: number; returning_customers: number } };
    expect(report.kpis.new_customers).toBe(1);
    expect(report.kpis.returning_customers).toBe(0);
  });

  it("cross-tenant: business B's reports.view holder cannot see business A's customers", async () => {
    const a = await createOwnerAndBusiness("cust-report-tenant-a");
    const b = await createOwnerAndBusiness("cust-report-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    await makeCustomer(a.client, a.businessId, { name: "Only In A" });

    const { data, error } = await b.client.rpc("get_customer_detail_report", {
      p_business_id: b.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
    });
    expect(error).toBeNull();
    const report = data as { rows: { name: string }[] };
    expect(report.rows.find((r) => r.name === "Only In A")).toBeUndefined();
  });

  it("rejects an inverted/equal range with INVALID_REPORT_RANGE", async () => {
    const owner = await createOwnerAndBusiness("cust-report-range");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_FUTURE, p_to: FAR_PAST,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVALID_REPORT_RANGE/);
  });

  it("excludes a customer with no COMPLETED sale in the period from the detail table (period-activity-scoped)", async () => {
    const owner = await createOwnerAndBusiness("cust-report-empty-period");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Only Past Buyer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();
    // Only a purchase BEFORE the report window — no activity inside it.
    await backdateSaleCompletedAt(sale.data as string, "2024-01-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-empty-period", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as {
      kpis: { active_customers: number; revenue: number };
      rows: { customer_id: string }[];
      total_count: number;
    };
    expect(report.kpis.active_customers).toBe(0);
    expect(report.kpis.revenue).toBe(0);
    expect(report.total_count).toBe(0);
    expect(report.rows.find((r) => r.customer_id === customerId)).toBeUndefined();
  });

  it("includes a returning customer (purchase before AND inside the window) in the detail table", async () => {
    const owner = await createOwnerAndBusiness("cust-report-returning");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Returning Buyer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });

    const before = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(before.error).toBeNull();
    await backdateSaleCompletedAt(before.data as string, "2024-01-01T00:00:00Z");

    const during = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(during.error).toBeNull();
    await backdateSaleCompletedAt(during.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-returning", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { rows: { customer_id: string; is_new: boolean; is_returning: boolean }[]; kpis: { active_customers: number } };
    expect(report.kpis.active_customers).toBe(1);
    const row = report.rows.find((r) => r.customer_id === customerId);
    expect(row).toBeDefined();
    expect(row?.is_returning).toBe(true);
    expect(row?.is_new).toBe(false);
  });

  it("includes a new customer (first-ever purchase inside the window) in the detail table", async () => {
    const owner = await createOwnerAndBusiness("cust-report-new-included");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "New Buyer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-new-included", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { rows: { customer_id: string; is_new: boolean; is_returning: boolean }[] };
    const row = report.rows.find((r) => r.customer_id === customerId);
    expect(row).toBeDefined();
    expect(row?.is_new).toBe(true);
    expect(row?.is_returning).toBe(false);
  });

  it("excludes a customer whose only sale in the window is DRAFT/CANCELLED, never COMPLETED", async () => {
    const owner = await createOwnerAndBusiness("cust-report-draft-only");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Draft Only Buyer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();
    // Leave it DRAFT (create_sale's default when no payment is recorded)
    // but backdate it into the window so a status-blind query would
    // wrongly include it.
    const sql = createTestDbClient();
    try {
      await sql`update public.sales set created_at = '2025-06-01T00:00:00Z'::timestamptz where id = ${sale.data as string}`;
    } finally {
      await sql.end();
    }

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "cust-report-draft-only", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { rows: { customer_id: string }[]; total_count: number };
    expect(report.rows.find((r) => r.customer_id === customerId)).toBeUndefined();
  });

  it("clamps page_size and paginates without exceeding the bound", async () => {
    const owner = await createOwnerAndBusiness("cust-report-page");
    cleanupUserIds.push(owner.userId);
    const { data, error } = await owner.client.rpc("get_customer_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_page_size: 9999,
    });
    expect(error).toBeNull();
    const report = data as { page_size: number };
    expect(report.page_size).toBeLessThanOrEqual(100);
  });
});

describe("get_inventory_detail_report", () => {
  it("rejects a caller without reports.view", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("inv-report-noperm");
    cleanupUserIds.push(userId);
    const staff = await createMemberWithCustomPermissions(businessId, "inv-report-noperm", ["inventory.view"]);
    cleanupUserIds.push(staff.userId);
    const { error } = await staff.client.rpc("get_inventory_detail_report", {
      p_business_id: businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/insufficient_privilege|permission/i);
  });

  it("classifies stock status using the product's own low_stock_threshold, never a manufactured default", async () => {
    const owner = await createOwnerAndBusiness("inv-report-status");
    cleanupUserIds.push(owner.userId);

    const outOfStock = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0, name: "Zero Stock" });
    const lowStock = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 3, name: "Low Stock Item" });
    const inStock = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 100, name: "Plenty Stock" });

    const sql = createTestDbClient();
    try {
      await sql`update public.products set low_stock_threshold = 5 where id = ${lowStock.id}`;
    } finally {
      await sql.end();
    }

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "inv-report-status", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_inventory_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_page_size: 100,
    });
    expect(error).toBeNull();
    const report = data as { rows: { product_id: string; stock_status: string }[] };
    expect(report.rows.find((r) => r.product_id === outOfStock.id)?.stock_status).toBe("out_of_stock");
    expect(report.rows.find((r) => r.product_id === lowStock.id)?.stock_status).toBe("low_stock");
    expect(report.rows.find((r) => r.product_id === inStock.id)?.stock_status).toBe("in_stock");
  });

  it("counts units sold in the period from completed sales only", async () => {
    const owner = await createOwnerAndBusiness("inv-report-units");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 50 });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 4)],
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "inv-report-units", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);
    const { data, error } = await reportsOnly.client.rpc("get_inventory_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z", p_page_size: 100,
    });
    expect(error).toBeNull();
    const report = data as { rows: { product_id: string; units_sold: number }[] };
    expect(report.rows.find((r) => r.product_id === product.id)?.units_sold).toBe(4);
  });

  it("cross-tenant: business B cannot see business A's products", async () => {
    const a = await createOwnerAndBusiness("inv-report-tenant-a");
    const b = await createOwnerAndBusiness("inv-report-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    await makeSaleProduct(a.client, a.businessId, { name: "Only In A", openingQuantity: 10 });

    const { data, error } = await b.client.rpc("get_inventory_detail_report", {
      p_business_id: b.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
    });
    expect(error).toBeNull();
    const report = data as { rows: { name: string }[] };
    expect(report.rows.find((r) => r.name === "Only In A")).toBeUndefined();
  });

  it("rejects an inverted/equal range with INVALID_REPORT_RANGE", async () => {
    const owner = await createOwnerAndBusiness("inv-report-range");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("get_inventory_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_FUTURE, p_to: FAR_PAST,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVALID_REPORT_RANGE/);
  });
});
