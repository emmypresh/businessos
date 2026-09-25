import { afterEach, describe, expect, it } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createMemberWithCustomPermissions, createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { makeCustomer, makeSaleProduct, saleItem } from "./helpers/sales";
import { createBranch } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const RANGE = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

async function createCompletedSale(client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"], businessId: string, productId: string, customerId: string) {
  const { data, error } = await client.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_customer_id: customerId,
    p_items: [saleItem(productId, 1)],
    p_payment_status: "PAID",
    p_payment_method: "CASH",
  });
  if (error || !data) throw new Error(`create_sale fixture failed: ${error?.message}`);
  return data as string;
}

async function setCompletedAt(saleId: string, at: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.sales set completed_at = ${at}::timestamptz where id = ${saleId}`;
  } finally {
    await sql.end();
  }
}

async function getAggregateInSessionTimezone(
  userId: string,
  businessId: string,
  timezone: string,
  from: string,
  to: string
) {
  const sql = createTestDbClient();
  try {
    return await sql.begin(async (transaction) => {
      await transaction`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      await transaction`set local role authenticated`;
      await transaction`select set_config('TimeZone', ${timezone}, true)`;
      const [row] = await transaction<{ aggregate: Record<string, unknown> }[]>`
        select public.get_management_reporting_aggregate(${businessId}::uuid, ${from}::timestamptz, ${to}::timestamptz) as aggregate
      `;
      return row.aggregate;
    });
  } finally {
    await sql.end();
  }
}

describe("get_management_reporting_aggregate", () => {
  it("returns correct bounded aggregates, excludes the exclusive end boundary, and scopes branch rows to assignments", async () => {
    const owner = await createOwnerAndBusiness("management-reporting");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 100, openingQuantity: 5 });
    const customer = await makeCustomer(owner.client, owner.businessId, { name: "Reporting Customer" });
    const currentOne = await createCompletedSale(owner.client, owner.businessId, product.id, customer);
    const currentTwo = await createCompletedSale(owner.client, owner.businessId, product.id, customer);
    const endBoundary = await createCompletedSale(owner.client, owner.businessId, product.id, customer);
    await setCompletedAt(currentOne, "2026-09-10T12:00:00.000Z");
    await setCompletedAt(currentTwo, "2026-09-11T12:00:00.000Z");
    await setCompletedAt(endBoundary, RANGE.to);
    await createBranch(owner.client, owner.businessId, { name: "Unassigned branch" });

    const { data, error } = await owner.client.rpc("get_management_reporting_aggregate", {
      p_business_id: owner.businessId,
      p_from: RANGE.from,
      p_to: RANGE.to,
    });
    expect(error).toBeNull();
    const result = data as Record<string, unknown>;
    expect(result.previous_period).toMatchObject({ to: "2026-09-01T00:00:00+00:00", days: 30 });
    const trend = result.sales_trend as Array<Record<string, unknown>>;
    expect(trend).toHaveLength(30);
    expect(trend.find((day) => String(day.date).startsWith("2026-09-10"))?.revenue).toBe(100);
    expect(trend.find((day) => String(day.date).startsWith("2026-09-11"))?.order_count).toBe(1);
    expect(trend.reduce((sum, day) => sum + Number(day.order_count), 0)).toBe(2);
    expect(result.customer_summary).toMatchObject({ new_customers: 1, returning_customers: 0, repeat_customers: 1 });
    expect(result.inventory_risk).toMatchObject({ out_of_stock_products: 0, slow_moving_products: 0 });
    // Owner has only the automatically assigned default branch; the second
    // branch is tenant-valid but absent from this new, assignment-scoped view.
    expect(result.branch_performance).toHaveLength(1);
  });

  it("enforces reports.view and does not turn a foreign business id into an empty aggregate", async () => {
    const owner = await createOwnerAndBusiness("management-reporting-owner");
    const foreign = await createOwnerAndBusiness("management-reporting-foreign");
    const noReports = await createMemberWithCustomPermissions(owner.businessId, "management-reporting-no-reports", ["sales.view"]);
    cleanupUserIds.push(owner.userId, foreign.userId, noReports.userId);

    const denied = await noReports.client.rpc("get_management_reporting_aggregate", { p_business_id: owner.businessId, p_from: RANGE.from, p_to: RANGE.to });
    expect(denied.error?.message).toContain("insufficient_privilege");
    const foreignAttempt = await owner.client.rpc("get_management_reporting_aggregate", { p_business_id: foreign.businessId, p_from: RANGE.from, p_to: RANGE.to });
    expect(foreignAttempt.error?.message).toContain("insufficient_privilege");
  });

  it("rejects an unbounded direct-RPC range before generating daily buckets", async () => {
    const owner = await createOwnerAndBusiness("management-reporting-range-limit");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("get_management_reporting_aggregate", {
      p_business_id: owner.businessId,
      p_from: "2020-01-01T00:00:00.000Z",
      p_to: "2027-01-01T00:00:00.000Z",
    });
    expect(error?.message).toContain("INVALID_REPORT_RANGE");
  });

  it("pins daily buckets to UTC when the calling session uses a non-UTC timezone", async () => {
    const owner = await createOwnerAndBusiness("management-reporting-utc-session");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 100, openingQuantity: 5 });
    const customer = await makeCustomer(owner.client, owner.businessId, { name: "UTC Boundary Customer" });
    const inWindow = await createCompletedSale(owner.client, owner.businessId, product.id, customer);
    const exclusiveEnd = await createCompletedSale(owner.client, owner.businessId, product.id, customer);
    await setCompletedAt(inWindow, "2026-09-10T00:30:00.000Z");
    await setCompletedAt(exclusiveEnd, "2026-09-11T00:00:00.000Z");

    const from = "2026-09-10T00:00:00.000Z";
    const to = "2026-09-11T00:00:00.000Z";
    const utc = await getAggregateInSessionTimezone(owner.userId, owner.businessId, "UTC", from, to);
    const kiritimati = await getAggregateInSessionTimezone(owner.userId, owner.businessId, "Pacific/Kiritimati", from, to);
    const newYork = await getAggregateInSessionTimezone(owner.userId, owner.businessId, "America/New_York", from, to);

    // Phase 1Q-0C: a positive (Kiritimati, UTC+14) AND a negative
    // (New_York, UTC-4) offset both previously produced a spurious extra
    // day and a non-UTC-anchored date string — generate_series(date, date,
    // interval) has no direct overload, so it resolved to the
    // session-TimeZone-dependent (timestamptz, timestamptz, interval) one.
    // Both directions must collapse to the exact same single UTC bucket.
    expect(kiritimati.sales_trend).toEqual(utc.sales_trend);
    expect(newYork.sales_trend).toEqual(utc.sales_trend);
    expect(utc.sales_trend).toEqual([
      expect.objectContaining({ date: "2026-09-10", revenue: 100, order_count: 1 }),
    ]);
    expect((kiritimati.sales_trend as Array<Record<string, unknown>>).reduce((sum, day) => sum + Number(day.order_count), 0)).toBe(1);
    expect((newYork.sales_trend as Array<Record<string, unknown>>).reduce((sum, day) => sum + Number(day.order_count), 0)).toBe(1);
  });
});
