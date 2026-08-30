import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, expensePayload } from "./helpers/expenses";
import { getDefaultBranchId, createBranch } from "./helpers/staff";

// Phase 1G: branch-aware expenses (20260829080300_branch_aware_expenses.sql).
// branch_id is NULLABLE — NULL means business-wide, a real value means
// attributed to that branch. No has_branch_access requirement: expenses.manage
// is a back-office/financial-management permission, not a branch-operational
// one — see the migration's own header comment for the full reasoning.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_expense — branch attribution", () => {
  it("25. a business-wide expense (no p_branch_id) is still valid — the exact pre-Phase-1G calling pattern", async () => {
    const owner = await createOwnerAndBusiness("bexp-business-wide");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    const { data: expenseId, error } = await owner.client.rpc(
      "create_expense",
      expensePayload(owner.businessId, categoryId)
    );
    expect(error).toBeNull();

    const { data: expense } = await owner.client.from("expenses").select("branch_id, branch_name_snapshot").eq("id", expenseId!).single();
    expect(expense!.branch_id).toBeNull();
    expect(expense!.branch_name_snapshot).toBeNull();
  });

  it("26. a same-tenant, ACTIVE branch-attributed expense succeeds — no branch access required of the caller", async () => {
    const owner = await createOwnerAndBusiness("bexp-branch-attrib");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Branch Expense Target" });
    // ACCOUNTANT-tier role: expenses.manage only, deliberately NOT assigned
    // to `branchId` at all — this is exactly the "back-office accountant
    // records a branch's bill without being personally assigned there"
    // workflow the migration's own reasoning describes.
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "bexp-branch-attrib", ["expenses.manage"]);
    cleanupUserIds.push(accountant.userId);

    const { data: expenseId, error } = await accountant.client.rpc(
      "create_expense",
      expensePayload(owner.businessId, categoryId, { creationKey: randomUuid() })
    );
    // First prove the ordinary (no-branch) path works for this role, then
    // the branch-attributed path specifically.
    expect(error).toBeNull();
    expect(expenseId).not.toBeNull();

    const { data: branchExpenseId, error: branchError } = await accountant.client.rpc("create_expense", {
      ...expensePayload(owner.businessId, categoryId, { creationKey: randomUuid() }),
      p_branch_id: branchId,
    });
    expect(branchError).toBeNull();

    const { data: expense } = await owner.client
      .from("expenses")
      .select("branch_id, branch_name_snapshot")
      .eq("id", branchExpenseId!)
      .single();
    expect(expense!.branch_id).toBe(branchId);
    expect(expense!.branch_name_snapshot).toBe("Branch Expense Target");
  });

  it("27. a foreign-tenant branch id is rejected with BRANCH_NOT_FOUND", async () => {
    const owner = await createOwnerAndBusiness("bexp-foreign-a");
    const stranger = await createOwnerAndBusiness("bexp-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

    const { error } = await owner.client.rpc("create_expense", {
      ...expensePayload(owner.businessId, categoryId),
      p_branch_id: strangerBranchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("28. posting against an INACTIVE branch is rejected with BRANCH_NOT_ACTIVE", async () => {
    const owner = await createOwnerAndBusiness("bexp-inactive");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Inactive Expense Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { error } = await owner.client.rpc("create_expense", {
      ...expensePayload(owner.businessId, categoryId),
      p_branch_id: branchId,
    });
    expect(error?.message).toContain("BRANCH_NOT_ACTIVE");
  });

  it("29. branch_id is part of the canonical idempotency payload — a reused key with a different branch is rejected", async () => {
    const owner = await createOwnerAndBusiness("bexp-idem-branch");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Idempotency Branch" });
    const creationKey = randomUuid();

    const { error: firstError } = await owner.client.rpc("create_expense", expensePayload(owner.businessId, categoryId, { creationKey }));
    expect(firstError).toBeNull();

    const { error: secondError } = await owner.client.rpc("create_expense", {
      ...expensePayload(owner.businessId, categoryId, { creationKey }),
      p_branch_id: branchId,
    });
    expect(secondError?.message).toContain("EXPENSE_IDEMPOTENCY_KEY_REUSED");
  });

  it("30/31. a historical branch-attributed expense remains reportable after the branch is deactivated, and business-wide expenses stay branch_id NULL", async () => {
    const owner = await createOwnerAndBusiness("bexp-inactive-history");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "History Branch" });

    const { data: branchExpenseId } = await owner.client.rpc("create_expense", {
      ...expensePayload(owner.businessId, categoryId, { creationKey: randomUuid() }),
      p_branch_id: branchId,
    });
    const { data: businessWideExpenseId } = await owner.client.rpc(
      "create_expense",
      expensePayload(owner.businessId, categoryId, { creationKey: randomUuid() })
    );

    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });

    const { data: rows, error } = await owner.client
      .from("expenses")
      .select("id, branch_id")
      .in("id", [branchExpenseId!, businessWideExpenseId!]);
    expect(error).toBeNull();
    const branchRow = rows!.find((r) => r.id === branchExpenseId);
    const businessWideRow = rows!.find((r) => r.id === businessWideExpenseId);
    expect(branchRow!.branch_id).toBe(branchId);       // still readable, still attributed
    expect(businessWideRow!.branch_id).toBeNull();      // untouched
  });
});
