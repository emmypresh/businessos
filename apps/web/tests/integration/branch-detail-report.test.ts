// Phase 1N-C4 — Branch Detailed Report RPC.
// Mirrors customer-inventory-detail-reports.test.ts's own fixture
// conventions exactly (createOwnerAndBusiness, createMemberWithCustomPermissions,
// raw sql for completed_at/incurred_at backdating).
import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";
import { createBranch, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { makeExpenseCategory, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const FAR_PAST = "2020-01-01T00:00:00Z";
const FAR_FUTURE = "2030-01-01T00:00:00Z";

// create_sale requires the CALLER's own operational branch access
// (private.has_branch_access) whenever an explicit p_branch_id is given.
// replace_member_branches (frozen, Phase 1F) forbids a caller from ever
// targeting their OWN membership, so the business owner can never
// self-grant access to a branch beyond their own default one — a
// dedicated seller member must be created and assigned instead. Mirrors
// branch-aware-reporting.test.ts's own identical setUpTwoBranchActivity
// fixture exactly. The report itself is still always read as the OWNER
// (reports.view is business-wide, unrestricted by branch assignment).
async function createSellerAssignedToBranches(
  prefix: string,
  owner: Awaited<ReturnType<typeof createOwnerAndBusiness>>,
  branchIds: string[]
) {
  const seller = await createMemberWithCustomPermissions(owner.businessId, prefix, ["sales.create"]);
  const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
  await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, branchIds, branchIds[0]);
  return seller;
}

async function backdateSaleCompletedAt(saleId: string, isoTimestamp: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.sales set completed_at = ${isoTimestamp}::timestamptz where id = ${saleId}`;
  } finally {
    await sql.end();
  }
}

describe("get_branch_detail_report", () => {
  it("rejects a caller without reports.view", async () => {
    const owner = await createOwnerAndBusiness("branch-report-noperm");
    cleanupUserIds.push(owner.userId);
    const staff = await createMemberWithCustomPermissions(owner.businessId, "branch-report-noperm", ["branches.view"]);
    cleanupUserIds.push(staff.userId);

    const { error } = await staff.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId,
      p_from: FAR_PAST,
      p_to: FAR_FUTURE,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/insufficient_privilege|permission/i);
  });

  it("rejects an inverted/equal range with INVALID_REPORT_RANGE", async () => {
    const owner = await createOwnerAndBusiness("branch-report-range");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_FUTURE, p_to: FAR_PAST,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVALID_REPORT_RANGE/);
  });

  it("cross-tenant: business B's reports.view holder cannot see business A's branches", async () => {
    const a = await createOwnerAndBusiness("branch-report-tenant-a");
    const b = await createOwnerAndBusiness("branch-report-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    await createBranch(a.client, a.businessId, { name: "Only In A" });

    const { data, error } = await b.client.rpc("get_branch_detail_report", {
      p_business_id: b.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
    });
    expect(error).toBeNull();
    const report = data as { rows: { name: string }[] };
    expect(report.rows.find((r) => r.name === "Only In A")).toBeUndefined();
  });

  it("rejects a p_branch_id from another business with BRANCH_NOT_FOUND", async () => {
    const a = await createOwnerAndBusiness("branch-report-foreign-a");
    const b = await createOwnerAndBusiness("branch-report-foreign-b");
    cleanupUserIds.push(a.userId, b.userId);
    const foreignBranchId = await createBranch(a.client, a.businessId, { name: "Foreign Branch" });

    const { error } = await b.client.rpc("get_branch_detail_report", {
      p_business_id: b.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_branch_id: foreignBranchId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/BRANCH_NOT_FOUND/);
  });

  it("returns the real aggregate for a caller with reports.view alone (no branches.view/sales.view)", async () => {
    const owner = await createOwnerAndBusiness("branch-report-agg");
    cleanupUserIds.push(owner.userId);

    const branchId = await createBranch(owner.client, owner.businessId, { name: "Uptown" });
    const seller = await createSellerAssignedToBranches("branch-report-agg", owner, [branchId]);
    cleanupUserIds.push(seller.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Ada" });
    // trackInventory: false — opening stock always lands at the business's
    // DEFAULT branch location, which would otherwise make this
    // non-default-branch sale fail with an unrelated INSUFFICIENT_STOCK
    // (see createSellerAssignedToBranches's own header comment).
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, trackInventory: false });

    const sale = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 3)], p_branch_id: branchId,
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, "2025-06-01T00:00:00Z");

    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "branch-report-agg", ["reports.view"]);
    cleanupUserIds.push(reportsOnly.userId);

    const { data, error } = await reportsOnly.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId,
      p_from: "2025-01-01T00:00:00Z",
      p_to: "2025-12-31T00:00:00Z",
      p_sort: "revenue",
      p_direction: "desc",
    });
    expect(error).toBeNull();
    const report = data as {
      kpis: { active_branches: number; completed_sales: number; revenue: number; units_sold: number; active_customers: number };
      rows: { branch_id: string; name: string; completed_sales: number; revenue: number; units_sold: number; is_active_in_period: boolean }[];
    };
    const row = report.rows.find((r) => r.branch_id === branchId);
    expect(row).toBeDefined();
    expect(row?.completed_sales).toBe(1);
    expect(row?.revenue).toBe(3000);
    expect(row?.units_sold).toBe(3);
    expect(row?.is_active_in_period).toBe(true);
    expect(report.kpis.active_branches).toBeGreaterThanOrEqual(1);
    expect(report.kpis.active_customers).toBeGreaterThanOrEqual(1);
  });

  it("counts a customer active at two branches once in the business-wide active_customers KPI (no double count)", async () => {
    const owner = await createOwnerAndBusiness("branch-report-dedupe");
    cleanupUserIds.push(owner.userId);

    const branchA = await createBranch(owner.client, owner.businessId, { name: "Branch A" });
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const seller = await createSellerAssignedToBranches("branch-report-dedupe", owner, [branchA, branchB]);
    cleanupUserIds.push(seller.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Multi Branch Customer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });

    const saleA = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)], p_branch_id: branchA,
    });
    expect(saleA.error).toBeNull();
    await backdateSaleCompletedAt(saleA.data as string, "2025-06-01T00:00:00Z");

    const saleB = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 1)], p_branch_id: branchB,
    });
    expect(saleB.error).toBeNull();
    await backdateSaleCompletedAt(saleB.data as string, "2025-06-02T00:00:00Z");

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { kpis: { active_customers: number } };
    expect(report.kpis.active_customers).toBe(1);
  });

  it("includes an ACTIVE branch with zero period activity, explicit zero metrics", async () => {
    const owner = await createOwnerAndBusiness("branch-report-zero");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Quiet Branch" });

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { rows: { branch_id: string; completed_sales: number; revenue: number; is_active_in_period: boolean }[] };
    const row = report.rows.find((r) => r.branch_id === branchId);
    expect(row).toBeDefined();
    expect(row?.completed_sales).toBe(0);
    expect(row?.revenue).toBe(0);
    expect(row?.is_active_in_period).toBe(false);
  });

  it("scopes expense_total to POSTED, branch-attributed expenses only (excludes company-wide and VOIDED)", async () => {
    const owner = await createOwnerAndBusiness("branch-report-expenses");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Expense Branch" });
    const categoryId = await makeExpenseCategory(owner.client, owner.businessId);

    // A. POSTED, branch-attributed — the only expense that should count.
    await makeExpense(owner.client, owner.businessId, categoryId, {
      amount: 10000, branchId, incurredAt: "2025-06-01T00:00:00Z",
    });
    // B. VOIDED, branch-attributed — must be excluded despite matching branch/period.
    const voidedExpenseId = await makeExpense(owner.client, owner.businessId, categoryId, {
      amount: 7000, branchId, incurredAt: "2025-06-01T00:00:00Z",
    });
    const voidResult = await owner.client.rpc("void_expense", {
      p_business_id: owner.businessId, p_expense_id: voidedExpenseId, p_reason: "Recorded in error",
    });
    expect(voidResult.error).toBeNull();
    // C. POSTED, company-wide (no branch) — must be excluded from this branch's total.
    await makeExpense(owner.client, owner.businessId, categoryId, {
      amount: 4000, incurredAt: "2025-06-01T00:00:00Z",
    });

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-01-01T00:00:00Z", p_to: "2025-12-31T00:00:00Z",
    });
    expect(error).toBeNull();
    const report = data as { rows: { branch_id: string; expense_total: number }[] };
    const row = report.rows.find((r) => r.branch_id === branchId);
    expect(row?.expense_total).toBe(10000);
  });

  it("returns a selected_branch drilldown with trend and top_products when p_branch_id is given", async () => {
    const owner = await createOwnerAndBusiness("branch-report-drilldown");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Drilldown Branch" });
    const seller = await createSellerAssignedToBranches("branch-report-drilldown", owner, [branchId]);
    cleanupUserIds.push(seller.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 2000, trackInventory: false });

    const sale = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(),
      p_customer_id: customerId, p_items: [saleItem(product.id, 2)], p_branch_id: branchId,
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, "2025-06-15T00:00:00Z");

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: "2025-06-01T00:00:00Z", p_to: "2025-07-01T00:00:00Z", p_branch_id: branchId,
    });
    expect(error).toBeNull();
    const report = data as {
      selected_branch: {
        branch_id: string; revenue: number; completed_sales: number;
        trend: { date: string; revenue: number }[];
        top_products: { product_id: string; units_sold: number }[];
      } | null;
    };
    expect(report.selected_branch).not.toBeNull();
    expect(report.selected_branch?.branch_id).toBe(branchId);
    expect(report.selected_branch?.revenue).toBe(4000);
    expect(report.selected_branch?.completed_sales).toBe(1);
    expect(report.selected_branch?.trend.length).toBeGreaterThan(0);
    const trendDay = report.selected_branch?.trend.find((t) => t.date === "2025-06-15");
    expect(trendDay?.revenue).toBe(4000);
    expect(report.selected_branch?.top_products.find((p) => p.product_id === product.id)?.units_sold).toBe(2);
  });

  it("returns selected_branch for an INACTIVE branch (historical drilldown remains reachable)", async () => {
    const owner = await createOwnerAndBusiness("branch-report-inactive");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Once Active" });

    const sql = createTestDbClient();
    try {
      await sql`update public.business_branches set status = 'INACTIVE' where id = ${branchId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_branch_id: branchId,
    });
    expect(error).toBeNull();
    const report = data as { rows: { branch_id: string }[]; selected_branch: { branch_id: string } | null };
    // INACTIVE branches are omitted from the comparison table...
    expect(report.rows.find((r) => r.branch_id === branchId)).toBeUndefined();
    // ...but remain selectable for drilldown.
    expect(report.selected_branch?.branch_id).toBe(branchId);
  });

  it("matches branch name and code in search", async () => {
    const owner = await createOwnerAndBusiness("branch-report-search");
    cleanupUserIds.push(owner.userId);
    await createBranch(owner.client, owner.businessId, { name: "Lekki Phase 1", code: "LKI" });
    await createBranch(owner.client, owner.businessId, { name: "Yaba" });

    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_search: "lki",
    });
    expect(error).toBeNull();
    const report = data as { rows: { name: string }[] };
    expect(report.rows.some((r) => r.name === "Lekki Phase 1")).toBe(true);
    expect(report.rows.some((r) => r.name === "Yaba")).toBe(false);
  });

  it("clamps p_page_size to 100 and never returns more rows than the cap", async () => {
    const owner = await createOwnerAndBusiness("branch-report-pagesize");
    cleanupUserIds.push(owner.userId);
    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE, p_page_size: 5000,
    });
    expect(error).toBeNull();
    const report = data as { page_size: number };
    expect(report.page_size).toBe(100);
  });

  it("silently falls back to the revenue sort allowlist branch for an out-of-allowlist p_sort value (defense in depth)", async () => {
    const owner = await createOwnerAndBusiness("branch-report-sort-fallback");
    cleanupUserIds.push(owner.userId);
    await createBranch(owner.client, owner.businessId, { name: "Fallback Branch" });

    // v_sort_col's plpgsql case/when has no branch for this value, so it
    // resolves to its `else 'revenue'` default — the ONLY column name that
    // ever reaches format()'s %I. Never the raw p_sort text itself. This
    // must not error and must not execute anything beyond that safe
    // fallback.
    const { data, error } = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
      p_sort: "name; drop table business_branches;",
    });
    expect(error).toBeNull();
    const report = data as { rows: { name: string }[] };
    expect(report.rows.some((r) => r.name === "Fallback Branch")).toBe(true);

    const stillWorks = await owner.client.rpc("get_branch_detail_report", {
      p_business_id: owner.businessId, p_from: FAR_PAST, p_to: FAR_FUTURE,
    });
    expect(stillWorks.error).toBeNull();
  });
});
