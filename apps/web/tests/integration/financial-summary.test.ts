import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";
import { getDefaultCategoryId, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const WINDOW_FROM = "2026-03-01T00:00:00Z";
const WINDOW_TO = "2026-04-01T00:00:00Z";

async function getSummary(
  client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"],
  businessId: string,
  from = WINDOW_FROM,
  to = WINDOW_TO
) {
  const result = await client.rpc("get_financial_summary", { p_business_id: businessId, p_from: from, p_to: to });
  return result;
}

describe("get_financial_summary: exact figures", () => {
  it("computes exact gross_sales, cash_collected, outstanding_sales, and sales_count for COMPLETED sales in range", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-sales-exact");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 1000, openingQuantity: 50 });

    // PAID sale: total 2000, amount_paid 2000.
    await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 2)], p_payment_status: "PAID", p_payment_method: "CASH",
    });
    // PARTIALLY_PAID sale: total 3000, amount_paid 1000, outstanding 2000.
    await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 3)], p_payment_status: "PARTIALLY_PAID",
      p_payment_method: "CASH", p_amount_paid: 1000,
    });
    // UNPAID sale: total 1000, amount_paid 0, outstanding 1000.
    await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });

    const { data, error } = await getSummary(client, businessId, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    expect(error).toBeNull();
    const s = data as Record<string, number>;
    expect(s.gross_sales).toBe(2000 + 3000 + 1000);
    expect(s.cash_collected).toBe(2000 + 1000 + 0);
    expect(s.outstanding_sales).toBe(0 + 2000 + 1000);
    expect(s.sales_count).toBe(3);
  });

  it("computes exact POSTED expenses and expense_count, excluding VOIDED ones", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-expenses-exact");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    await makeExpense(client, businessId, categoryId, { amount: 500 });
    await makeExpense(client, businessId, categoryId, { amount: 250 });
    const voidedId = await makeExpense(client, businessId, categoryId, { amount: 9999 });
    await client.rpc("void_expense", { p_business_id: businessId, p_expense_id: voidedId, p_reason: "Excluded from report" });

    const { data } = await getSummary(client, businessId, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    const s = data as Record<string, number>;
    expect(s.expenses).toBe(750);
    expect(s.expense_count).toBe(2);
  });

  it("net_cash_flow = cash_collected - expenses exactly, and can be negative", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-net-cash-flow");
    cleanupUserIds.push(userId);
    const product = await makeSaleProduct(client, businessId, { sellingPrice: 100, openingQuantity: 10 });
    const categoryId = await getDefaultCategoryId(client, businessId);

    await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)], p_payment_status: "PAID", p_payment_method: "CASH",
    }); // cash_collected: 100
    await makeExpense(client, businessId, categoryId, { amount: 900 }); // expenses: 900

    const { data } = await getSummary(client, businessId, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    const s = data as Record<string, number>;
    expect(s.cash_collected).toBe(100);
    expect(s.expenses).toBe(900);
    expect(s.net_cash_flow).toBe(100 - 900);
    expect(s.net_cash_flow).toBeLessThan(0);
  });

  it("an empty period returns numeric zeros, never null", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-empty-period");
    cleanupUserIds.push(userId);

    const { data, error } = await getSummary(client, businessId);
    expect(error).toBeNull();
    const s = data as Record<string, unknown>;
    for (const key of [
      "gross_sales", "cash_collected", "outstanding_sales", "expenses",
      "net_cash_flow", "sales_count", "expense_count",
    ]) {
      expect(s[key], key).not.toBeNull();
      expect(typeof s[key], key).toBe("number");
      expect(s[key]).toBe(0);
    }
    expect(s.currency_code).toBe("NGN");
  });

  it("respects the [p_from, p_to) half-open boundary exactly — a sale AT p_to is excluded, a sale AT p_from is included", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-boundary");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    // incurred_at exactly at p_from -> included ([p_from, ...).
    await makeExpense(client, businessId, categoryId, { amount: 111, incurredAt: WINDOW_FROM });
    // incurred_at exactly at p_to -> excluded (..., p_to)).
    await makeExpense(client, businessId, categoryId, { amount: 222, incurredAt: WINDOW_TO });
    // incurred_at one second before p_to -> included.
    const justBeforeTo = new Date(new Date(WINDOW_TO).getTime() - 1000).toISOString();
    await makeExpense(client, businessId, categoryId, { amount: 333, incurredAt: justBeforeTo });

    const { data } = await getSummary(client, businessId);
    const s = data as Record<string, number>;
    expect(s.expenses).toBe(111 + 333);
    expect(s.expense_count).toBe(2);
  });

  it("requires p_from < p_to", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("finsum-invalid-range");
    cleanupUserIds.push(userId);

    const equal = await getSummary(client, businessId, WINDOW_FROM, WINDOW_FROM);
    expect(equal.error?.message).toContain("INVALID_REPORT_RANGE");

    const inverted = await getSummary(client, businessId, WINDOW_TO, WINDOW_FROM);
    expect(inverted.error?.message).toContain("INVALID_REPORT_RANGE");
  });

  it("tenant isolation: business B's window never includes business A's sales/expenses", async () => {
    const a = await createOwnerAndBusiness("finsum-tenant-a");
    const b = await createOwnerAndBusiness("finsum-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    const product = await makeSaleProduct(a.client, a.businessId, { sellingPrice: 1000, openingQuantity: 10 });
    const categoryId = await getDefaultCategoryId(a.client, a.businessId);

    await a.client.rpc("create_sale", {
      p_business_id: a.businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)], p_payment_status: "PAID", p_payment_method: "CASH",
    });
    await makeExpense(a.client, a.businessId, categoryId, { amount: 500 });

    const { data } = await getSummary(b.client, b.businessId, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    const s = data as Record<string, number>;
    expect(s.gross_sales).toBe(0);
    expect(s.expenses).toBe(0);
    expect(s.sales_count).toBe(0);
    expect(s.expense_count).toBe(0);
  });
});

describe("get_financial_summary: reports.view is independent", () => {
  it("reports.view is required — a member with NO Phase 1E permissions is denied", async () => {
    const owner = await createOwnerAndBusiness("finsum-perm-none");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithRole(owner.businessId, "finsum-perm-none", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    const result = await getSummary(viewer.client, owner.businessId);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });

  it("expenses.view ALONE does not imply reports.view", async () => {
    const owner = await createOwnerAndBusiness("finsum-perm-expenses-view-only");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithCustomPermissions(owner.businessId, "finsum-perm-expenses-view-only", [
      "expenses.view",
    ]);
    cleanupUserIds.push(member.userId);

    const result = await getSummary(member.client, owner.businessId);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });

  it("sales.view ALONE does not imply reports.view", async () => {
    const owner = await createOwnerAndBusiness("finsum-perm-sales-view-only");
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithCustomPermissions(owner.businessId, "finsum-perm-sales-view-only", [
      "sales.view",
    ]);
    cleanupUserIds.push(member.userId);

    const result = await getSummary(member.client, owner.businessId);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });

  it("reports.view ALONE (without expenses.view or sales.view) is sufficient and returns the real, non-zero aggregate", async () => {
    const owner = await createOwnerAndBusiness("finsum-perm-reports-view-only");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 5000, openingQuantity: 10 });
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)], p_payment_status: "PAID", p_payment_method: "CASH",
    });
    await makeExpense(owner.client, owner.businessId, categoryId, { amount: 1234 });

    const member = await createMemberWithCustomPermissions(owner.businessId, "finsum-perm-reports-view-only", [
      "reports.view",
    ]);
    cleanupUserIds.push(member.userId);

    // Confirm this fixture role genuinely lacks sales.view/expenses.view —
    // it cannot read the underlying rows directly at all.
    const { data: directSales } = await member.client.from("sales").select("id").eq("business_id", owner.businessId);
    expect(directSales ?? []).toHaveLength(0);
    const { data: directExpenses } = await member.client.from("expenses").select("id").eq("business_id", owner.businessId);
    expect(directExpenses ?? []).toHaveLength(0);

    const { data, error } = await getSummary(member.client, owner.businessId, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    expect(error).toBeNull();
    const s = data as Record<string, number>;
    expect(s.gross_sales).toBe(5000);
    expect(s.expenses).toBe(1234);
  });

  it("a cross-tenant business_id is denied identically to a nonexistent one (no disclosure)", async () => {
    const a = await createOwnerAndBusiness("finsum-xtenant-a");
    const b = await createOwnerAndBusiness("finsum-xtenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    const foreign = await getSummary(b.client, a.businessId);
    expect(foreign.error).not.toBeNull();
    expect(foreign.error?.message).toMatch(/insufficient_privilege/i);

    const nonexistent = await getSummary(b.client, randomUuid());
    expect(nonexistent.error?.message).toBe(foreign.error?.message);
  });
});
