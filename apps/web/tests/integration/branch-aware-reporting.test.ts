import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, saleItem } from "./helpers/sales";
import { getDefaultCategoryId, expensePayload } from "./helpers/expenses";
import { getDefaultBranchId, createBranch, assignMemberToBranch, getMemberId } from "./helpers/staff";

// Phase 1G: branch-filterable get_financial_summary
// (20260829080400_branch_aware_financial_summary.sql). Semantics: NULL
// p_branch_id = business-wide (unchanged); a real p_branch_id restricts
// sales to that branch and expenses to that branch's OWN attributed
// expenses only, excluding business-wide (NULL branch_id) expenses.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function setUpTwoBranchActivity(prefix: string) {
  const owner = await createOwnerAndBusiness(prefix);
  // Not tracking inventory: opening stock always lands at the DEFAULT
  // branch's own location (see makeSaleProduct's own comment), which
  // would otherwise make the SECOND branch's sale below fail with an
  // unrelated INSUFFICIENT_STOCK — this fixture is about sale/expense
  // TOTALS per branch, never stock.
  const productId = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, costPrice: 400, trackInventory: false })).id;
  const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
  const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
  const secondBranchId = await createBranch(owner.client, owner.businessId, { name: "Reporting Branch Two" });
  // A dedicated seller, not the OWNER: replace_member_branches (Phase 1F,
  // frozen) forbids a caller from ever targeting their own membership, so
  // the OWNER can never self-grant access to a branch beyond their own
  // default one — see branch-aware-sales.test.ts's own header comment for
  // the full reasoning. Expenses (below) still go through the OWNER
  // directly, since expenses.manage carries no branch-access requirement
  // at all (branch_aware_expenses.sql's own header comment).
  const seller = await createMemberWithCustomPermissions(owner.businessId, prefix, ["sales.create"]);
  const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
  await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [defaultBranchId, secondBranchId]);

  // Every setup call's error is checked explicitly — a silent failure
  // here would otherwise surface only as a confusing "0" total several
  // lines away in whichever test uses this fixture.
  const { error: saleAError } = await seller.client.rpc("create_sale", {
    p_business_id: owner.businessId,
    p_creation_key: randomUuid(),
    p_items: [saleItem(productId, 1)],
    p_branch_id: defaultBranchId,
    p_payment_status: "PAID",
    p_payment_method: "CASH",
  });
  if (saleAError) throw new Error(`setup: default-branch create_sale failed: ${saleAError.message}`);

  const { error: expenseAError } = await owner.client.rpc("create_expense", {
    ...expensePayload(owner.businessId, categoryId, { amount: 100, creationKey: randomUuid() }),
    p_branch_id: defaultBranchId,
  });
  if (expenseAError) throw new Error(`setup: default-branch create_expense failed: ${expenseAError.message}`);

  // Second branch: one PAID sale (1000) + one branch-attributed expense (200).
  const { error: saleBError } = await seller.client.rpc("create_sale", {
    p_business_id: owner.businessId,
    p_creation_key: randomUuid(),
    p_items: [saleItem(productId, 1)],
    p_branch_id: secondBranchId,
    p_payment_status: "PAID",
    p_payment_method: "CASH",
  });
  if (saleBError) throw new Error(`setup: second-branch create_sale failed: ${saleBError.message}`);

  const { error: expenseBError } = await owner.client.rpc("create_expense", {
    ...expensePayload(owner.businessId, categoryId, { amount: 200, creationKey: randomUuid() }),
    p_branch_id: secondBranchId,
  });
  if (expenseBError) throw new Error(`setup: second-branch create_expense failed: ${expenseBError.message}`);

  // One business-wide (NULL branch) expense: 50.
  const { error: businessWideError } = await owner.client.rpc(
    "create_expense",
    expensePayload(owner.businessId, categoryId, { amount: 50, creationKey: randomUuid() })
  );
  if (businessWideError) throw new Error(`setup: business-wide create_expense failed: ${businessWideError.message}`);

  return { owner, seller, defaultBranchId, secondBranchId };
}

describe("get_financial_summary — branch filter", () => {
  it("32/36. business-wide summary (no p_branch_id) is unchanged in meaning — includes every branch's sales AND both branch-attributed and business-wide expenses", async () => {
    const { owner, seller } = await setUpTwoBranchActivity("brep-business-wide");
    cleanupUserIds.push(owner.userId, seller.userId);

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const { data, error } = await owner.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: from,
      p_to: to,
    });
    expect(error).toBeNull();
    expect(Number((data as Record<string, number>).gross_sales)).toBe(2000);
    expect(Number((data as Record<string, number>).expenses)).toBe(350); // 100 + 200 + 50
  });

  it("33/34/35. a single-branch summary includes only that branch's sales and that branch's OWN attributed expenses, excluding business-wide ones", async () => {
    const { owner, seller, defaultBranchId } = await setUpTwoBranchActivity("brep-single-branch");
    cleanupUserIds.push(owner.userId, seller.userId);

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const { data, error } = await owner.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: from,
      p_to: to,
      p_branch_id: defaultBranchId,
    });
    expect(error).toBeNull();
    expect(Number((data as Record<string, number>).gross_sales)).toBe(1000);     // only the default branch's sale
    expect(Number((data as Record<string, number>).expenses)).toBe(100);         // only the default branch's own expense — the 50 business-wide one is excluded
  });

  it("37. reports.view is required — expenses.manage/sales.view alone are insufficient", async () => {
    const owner = await createOwnerAndBusiness("brep-permission");
    cleanupUserIds.push(owner.userId);
    const nonReporter = await createMemberWithCustomPermissions(owner.businessId, "brep-permission", [
      "sales.view",
      "expenses.manage",
    ]);
    cleanupUserIds.push(nonReporter.userId);

    const { error } = await nonReporter.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: new Date(Date.now() - 60_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a branch filter does NOT additionally require has_branch_access — reports.view alone is sufficient, even for a branch the caller has no operational assignment to", async () => {
    const owner = await createOwnerAndBusiness("brep-no-branch-access-needed");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Unassigned Reporting Branch" });
    // ACCOUNTANT-tier: reports.view only, never assigned to `branchId` at all.
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "brep-no-branch-access-needed", ["reports.view"]);
    cleanupUserIds.push(accountant.userId);

    const { data, error } = await accountant.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: new Date(Date.now() - 60_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_branch_id: branchId,
    });
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it("38. an unauthorized/foreign-tenant branch filter is rejected safely", async () => {
    const owner = await createOwnerAndBusiness("brep-foreign-a");
    const stranger = await createOwnerAndBusiness("brep-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

    const { error } = await owner.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: new Date(Date.now() - 60_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_branch_id: strangerBranchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("39. an inactive historical branch can still be reported on — inactive means no NEW activity, never erased history", async () => {
    const { owner, seller, secondBranchId } = await setUpTwoBranchActivity("brep-inactive-reportable");
    cleanupUserIds.push(owner.userId, seller.userId);

    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: secondBranchId });

    const { data, error } = await owner.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: new Date(Date.now() - 60_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_branch_id: secondBranchId,
    });
    expect(error).toBeNull();
    expect(Number((data as Record<string, number>).gross_sales)).toBe(1000);
    expect(Number((data as Record<string, number>).expenses)).toBe(200);
  });
});
