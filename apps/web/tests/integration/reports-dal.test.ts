import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";
import { getDefaultCategoryId, makeExpense } from "./helpers/expenses";

// Hybrid technique — see tests/integration/sale-dal.test.ts for the full
// rationale.
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

const { getFinancialSummary } = await import("@/lib/reports/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const WIDE_RANGE = {
  from: "2000-01-01T00:00:00.000Z",
  to: "2100-01-01T00:00:00.000Z",
};

describe("getFinancialSummary — reports.view is independent of sales.view/expenses.view", () => {
  it("a caller with ONLY reports.view sees the REAL aggregate, not a zeroed-out result", async () => {
    const owner = await createOwnerAndBusiness("report-dal-independence");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const product = await makeSaleProduct(owner.client, owner.businessId, {
      sellingPrice: 1000,
      openingQuantity: 5,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
    });
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    await makeExpense(owner.client, owner.businessId, categoryId, { amount: 300 });

    const reportsOnly = await createMemberWithCustomPermissions(
      owner.businessId,
      "report-dal-independence",
      ["reports.view"]
    );
    cleanupUserIds.push(reportsOnly.userId);

    // Prove reports.view alone grants no direct row visibility — the
    // point of routing exclusively through get_financial_summary's own
    // BYPASSRLS reader role.
    currentClient = reportsOnly.client;
    const { data: rawSales } = await reportsOnly.client.from("sales").select("id").eq("business_id", owner.businessId);
    expect(rawSales).toEqual([]);
    const { data: rawExpenses } = await reportsOnly.client
      .from("expenses").select("id").eq("business_id", owner.businessId);
    expect(rawExpenses).toEqual([]);

    const summary = await getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to);
    expect(summary.grossSales).toBeGreaterThanOrEqual(1000);
    expect(summary.cashCollected).toBeGreaterThanOrEqual(1000);
    expect(summary.expenses).toBeGreaterThanOrEqual(300);
    expect(summary.salesCount).toBeGreaterThanOrEqual(1);
    expect(summary.expenseCount).toBeGreaterThanOrEqual(1);
  });

  it("a caller lacking reports.view (even with sales.view + expenses.view) is rejected", async () => {
    const owner = await createOwnerAndBusiness("report-dal-no-permission");
    cleanupUserIds.push(owner.userId);
    const salesExpensesOnly = await createMemberWithCustomPermissions(
      owner.businessId,
      "report-dal-no-permission",
      ["sales.view", "expenses.view"]
    );
    cleanupUserIds.push(salesExpensesOnly.userId);

    currentClient = salesExpensesOnly.client;
    await expect(
      getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to)
    ).rejects.toThrow();
  });

  it("a forged/foreign businessId the caller has no membership in is rejected, not just zeroed", async () => {
    const target = await createOwnerAndBusiness("report-dal-forge-target");
    const stranger = await createOwnerAndBusiness("report-dal-forge-stranger");
    cleanupUserIds.push(target.userId, stranger.userId);

    currentClient = stranger.client;
    await expect(
      getFinancialSummary(target.businessId, WIDE_RANGE.from, WIDE_RANGE.to)
    ).rejects.toThrow();
  });
});

describe("getFinancialSummary — range and shape", () => {
  it("rejects an inverted/equal [from, to) range", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("report-dal-invalid-range");
    cleanupUserIds.push(userId);
    currentClient = client;

    await expect(getFinancialSummary(businessId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).rejects.toThrow();
    await expect(getFinancialSummary(businessId, "2026-06-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).rejects.toThrow();
  });

  // Codex adversarial review, Finding 5 + Finding 7 — getFinancialSummary
  // must route its RPC error through the SAME safe error-mapping
  // architecture (lib/errors.ts's mapDatabaseError) every Server Action
  // already uses, never interpolate the raw Postgres error.message into
  // what it throws.
  it("INVALID_REPORT_RANGE resolves to its stable, controlled message — never the raw Postgres error text", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("report-dal-safe-range-error");
    cleanupUserIds.push(userId);
    currentClient = client;

    await expect(
      getFinancialSummary(businessId, "2026-06-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
    ).rejects.toThrow("The selected date range is invalid.");
  });

  it("insufficient_privilege (lacking reports.view) resolves to the generic permission message, never a raw SQLSTATE/constraint", async () => {
    const owner = await createOwnerAndBusiness("report-dal-safe-permission-error");
    cleanupUserIds.push(owner.userId);
    const salesOnly = await createMemberWithCustomPermissions(owner.businessId, "report-dal-safe-permission-error", [
      "sales.view",
    ]);
    cleanupUserIds.push(salesOnly.userId);

    currentClient = salesOnly.client;
    let caught: unknown;
    try {
      await getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe("You don't have permission to do this.");
    // Never leaks raw Postgres detail: SQLSTATE codes, constraint names,
    // function/schema context, or the RPC's own raw exception string.
    expect(message).not.toMatch(/42501|P0001|insufficient_privilege|get_financial_summary|SQLSTATE/i);
  });

  it("an empty range with no activity returns zeros for every field, not an error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("report-dal-empty-range");
    cleanupUserIds.push(userId);
    currentClient = client;

    const summary = await getFinancialSummary(businessId, "1999-01-01T00:00:00.000Z", "1999-02-01T00:00:00.000Z");
    expect(summary).toEqual({
      currencyCode: "NGN",
      grossSales: 0,
      cashCollected: 0,
      outstandingSales: 0,
      expenses: 0,
      netCashFlow: 0,
      salesCount: 0,
      expenseCount: 0,
    });
  });

  it("the returned shape contains ONLY the eight approved fields — never profit/margin/cost", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("report-dal-shape");
    cleanupUserIds.push(userId);
    currentClient = client;

    const summary = await getFinancialSummary(businessId, WIDE_RANGE.from, WIDE_RANGE.to);
    expect(Object.keys(summary).sort()).toEqual(
      [
        "cashCollected",
        "currencyCode",
        "expenseCount",
        "expenses",
        "grossSales",
        "netCashFlow",
        "outstandingSales",
        "salesCount",
      ].sort()
    );
    const serialized = JSON.stringify(summary).toLowerCase();
    expect(serialized).not.toMatch(/profit|margin|cogs|cost/);
  });

  it("net_cash_flow is exactly cash_collected minus expenses, as returned by the database (never client-recomputed)", async () => {
    const owner = await createOwnerAndBusiness("report-dal-netcashflow");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 2000, openingQuantity: 5 });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 2000,
    });
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    await makeExpense(owner.client, owner.businessId, categoryId, { amount: 750 });

    const summary = await getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to);
    expect(summary.netCashFlow).toBe(summary.cashCollected - summary.expenses);
  });

  it("a voided expense does not count toward the expenses aggregate", async () => {
    const owner = await createOwnerAndBusiness("report-dal-voided-excluded");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId, { amount: 4242 });

    const before = await getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to);
    await owner.client.rpc("void_expense", {
      p_business_id: owner.businessId,
      p_expense_id: expenseId,
      p_reason: "excluded from report",
    });
    const after = await getFinancialSummary(owner.businessId, WIDE_RANGE.from, WIDE_RANGE.to);

    expect(after.expenses).toBe(before.expenses - 4242);
    expect(after.expenseCount).toBe(before.expenseCount - 1);
  });
});
