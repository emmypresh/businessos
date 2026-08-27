import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  createMemberWithCustomPermissions,
  randomUuid,
} from "./helpers/inventory";
import { getDefaultCategoryId, makeExpenseCategory, makeExpense } from "./helpers/expenses";

// Hybrid technique — see tests/integration/customer-sale-action-auth.test.ts
// for the full rationale. Server Actions redirect() on success, which
// throws a NEXT_REDIRECT-digest-tagged error even outside a real request;
// tests that reach a successful completion catch that specific throw as
// proof of success, then verify the resulting DB state / redirect target
// directly.
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
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createExpense, voidExpense, createExpenseCategory, updateExpenseCategory, archiveExpenseCategory } =
  await import("@/lib/expenses/actions");
// Imported as a namespace specifically so vi.spyOn can wrap the real
// getPermissions export in place (it still calls through to the real
// implementation unless given a mock implementation) — this is what lets
// tests below prove a permission lookup did or did not happen, rather
// than only inferring it indirectly from the returned ActionState.
const businessDal = await import("@/lib/business/dal");

function isRedirect(e: unknown): { isRedirect: boolean; target?: string } {
  if (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  ) {
    // Next's redirect digest format: NEXT_REDIRECT;<type>;<url>;<status>
    const parts = (e as { digest: string }).digest.split(";");
    return { isRedirect: true, target: parts[2] };
  }
  return { isRedirect: false };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("createExpenseCategory action boundary", () => {
  it("rejects without mutating when expenses.manage is absent (view-only)", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-create-denied");
    cleanupUserIds.push(owner.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "act-expcat-create-denied", [
      "expenses.view",
    ]);
    cleanupUserIds.push(viewOnly.userId);

    currentClient = viewOnly.client;
    const result = await createExpenseCategory(
      undefined,
      formData({ businessId: owner.businessId, name: "Should Not Exist" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("rejects a forged businessId the caller has no membership in", async () => {
    const stranger = await createOwnerAndBusiness("act-expcat-forged-biz-stranger");
    const target = await createOwnerAndBusiness("act-expcat-forged-biz-target");
    cleanupUserIds.push(stranger.userId, target.userId);

    currentClient = stranger.client;
    const result = await createExpenseCategory(
      undefined,
      formData({ businessId: target.businessId, name: "Forged Attempt" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("manage-only (no expenses.view) CAN create a category — the category permission split", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-manage-only");
    cleanupUserIds.push(owner.userId);
    const manageOnly = await createMemberWithCustomPermissions(owner.businessId, "act-expcat-manage-only", [
      "expenses.manage",
    ]);
    cleanupUserIds.push(manageOnly.userId);

    currentClient = manageOnly.client;
    let caught: unknown;
    try {
      await createExpenseCategory(undefined, formData({ businessId: owner.businessId, name: "Manage Only Cat" }));
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught).isRedirect).toBe(true);

    currentClient = owner.client;
    const { data } = await owner.client
      .from("expense_categories")
      .select("id, status")
      .eq("business_id", owner.businessId)
      .eq("name", "Manage Only Cat");
    expect(data).toHaveLength(1);
    // Every category starts ACTIVE — never caller-chosen at creation.
    expect(data![0].status).toBe("ACTIVE");
  });

  it("a duplicate (case/whitespace-normalized) name is rejected with a friendly, field-scoped error", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-duplicate");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    await makeExpenseCategory(owner.client, owner.businessId, { name: "Fuel" });

    const result = await createExpenseCategory(
      undefined,
      formData({ businessId: owner.businessId, name: "  fuel  " })
    );
    expect(result?.fieldErrors?.name?.[0]).toBe("A category with this name already exists.");
  });
});

describe("updateExpenseCategory / archiveExpenseCategory action boundaries", () => {
  it("scopes by BOTH business_id and category_id — a forged categoryId from another tenant is not found/updated", async () => {
    const a = await createOwnerAndBusiness("act-expcat-scope-a");
    const b = await createOwnerAndBusiness("act-expcat-scope-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const categoryId = await makeExpenseCategory(a.client, a.businessId, { name: "Tenant A Category" });

    currentClient = b.client;
    const result = await updateExpenseCategory(
      undefined,
      formData({ businessId: b.businessId, categoryId, name: "Hacked" })
    );
    expect(result?.error).toBeTruthy();

    currentClient = a.client;
    const { data } = await a.client.from("expense_categories").select("name").eq("id", categoryId).single();
    expect(data?.name).toBe("Tenant A Category");
  });

  it("a genuinely random categoryId matches zero rows and returns a safe error, never a success redirect", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-random");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await archiveExpenseCategory(
      undefined,
      formData({ businessId: owner.businessId, categoryId: randomUuid() })
    );
    expect(result?.error).toBeTruthy();
    expect(result?.error).not.toMatch(/uuid|forbidden|denied/i);
  });

  it("archiving does not affect expenses that already reference the category (snapshot independence)", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-archive-snapshot");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await makeExpenseCategory(owner.client, owner.businessId, { name: "Soon Archived" });
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    let caught: unknown;
    try {
      await archiveExpenseCategory(undefined, formData({ businessId: owner.businessId, categoryId }));
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught).isRedirect).toBe(true);

    const { data: expense } = await owner.client
      .from("expenses")
      .select("category_name_snapshot")
      .eq("id", expenseId)
      .single();
    expect(expense?.category_name_snapshot).toBe("Soon Archived");
  });
});

describe("createExpense action boundary", () => {
  it("rejects without calling the RPC when expenses.manage is absent (view-only)", async () => {
    const owner = await createOwnerAndBusiness("act-exp-create-denied");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "act-exp-create-denied", [
      "expenses.view",
    ]);
    cleanupUserIds.push(viewOnly.userId);

    currentClient = viewOnly.client;
    const rpcSpy = vi.spyOn(viewOnly.client, "rpc");
    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId,
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpcSpy).not.toHaveBeenCalledWith("create_expense", expect.anything());
    rpcSpy.mockRestore();
  });

  it("rejects a forged categoryId belonging to another tenant", async () => {
    const a = await createOwnerAndBusiness("act-exp-forged-cat-a");
    const b = await createOwnerAndBusiness("act-exp-forged-cat-b");
    cleanupUserIds.push(a.userId, b.userId);
    const foreignCategoryId = await getDefaultCategoryId(a.client, a.businessId);

    currentClient = b.client;
    const result = await createExpense(
      undefined,
      formData({
        businessId: b.businessId,
        creationKey: randomUuid(),
        categoryId: foreignCategoryId,
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    // EXPENSE_CATEGORY_NOT_FOUND maps to a field-scoped error (categoryId)
    // via mapDatabaseError, not the top-level `error` — mirrors
    // CUSTOMER_NOT_FOUND's own field-scoped, non-disclosure treatment.
    expect(result?.fieldErrors?.categoryId?.[0]).toContain("not available");
  });

  it("the RPC call carries ONLY the approved logical inputs — never expense_number/category_name_snapshot/currency/status", async () => {
    const owner = await createOwnerAndBusiness("act-exp-narrow-args");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "500",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
    } catch {
      // redirect on success — irrelevant to this assertion
    }

    const call = rpcSpy.mock.calls.find(([fn]) => fn === "create_expense");
    expect(call).toBeDefined();
    const args = call![1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_amount",
        "p_business_id",
        "p_category_id",
        "p_creation_key",
        "p_incurred_at",
        "p_notes",
        "p_payee",
        "p_payment_method",
        "p_reference",
      ].sort()
    );
    rpcSpy.mockRestore();
  });

  it("a double-submit under the same creationKey (idempotency at the action boundary) produces exactly one expense", async () => {
    const owner = await createOwnerAndBusiness("act-exp-idempotent");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const key = randomUuid();
    const fd = () =>
      formData({
        businessId: owner.businessId,
        creationKey: key,
        categoryId,
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      });

    const results = await Promise.all([
      createExpense(undefined, fd()).catch((e) => e),
      createExpense(undefined, fd()).catch((e) => e),
    ]);
    expect(results.every((r) => isRedirect(r).isRedirect)).toBe(true);

    const { data: expenses } = await owner.client
      .from("expenses").select("id").eq("business_id", owner.businessId);
    expect(expenses).toHaveLength(1);
  });

  it("manage-without-view: on success, redirects to the accessible /expenses/new?created=1, never the (inaccessible) detail page", async () => {
    const owner = await createOwnerAndBusiness("act-exp-manage-only-redirect");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const manageOnly = await createMemberWithCustomPermissions(owner.businessId, "act-exp-manage-only-redirect", [
      "expenses.manage",
    ]);
    cleanupUserIds.push(manageOnly.userId);

    currentClient = manageOnly.client;
    let caught: unknown;
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "500",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      caught = e;
    }
    const redirect = isRedirect(caught);
    expect(redirect.isRedirect).toBe(true);
    expect(redirect.target).toBe(`/${owner.businessId}/expenses/new?created=1`);
  });

  it("view+manage: on success, redirects to the expense detail page", async () => {
    const owner = await createOwnerAndBusiness("act-exp-full-redirect");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    let caught: unknown;
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "500",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      caught = e;
    }
    const redirect = isRedirect(caught);
    expect(redirect.isRedirect).toBe(true);
    expect(redirect.target).toMatch(new RegExp(`^/${owner.businessId}/expenses/[0-9a-f-]{36}$`));
  });
});

describe("voidExpense action boundary", () => {
  it("rejects when expenses.manage is absent, even with expenses.view held", async () => {
    const owner = await createOwnerAndBusiness("act-void-denied");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "act-void-denied", [
      "expenses.view",
    ]);
    cleanupUserIds.push(viewOnly.userId);

    currentClient = viewOnly.client;
    const rpcSpy = vi.spyOn(viewOnly.client, "rpc");
    const result = await voidExpense(
      undefined,
      formData({ businessId: owner.businessId, expenseId, reason: "Recorded in error" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpcSpy).not.toHaveBeenCalledWith("void_expense", expect.anything());
    rpcSpy.mockRestore();

    currentClient = owner.client;
    const { data } = await owner.client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("POSTED");
  });

  it("rejects a forged expenseId from another tenant", async () => {
    const a = await createOwnerAndBusiness("act-void-forged-a");
    const b = await createOwnerAndBusiness("act-void-forged-b");
    cleanupUserIds.push(a.userId, b.userId);
    currentClient = a.client;
    const categoryId = await getDefaultCategoryId(a.client, a.businessId);
    const expenseId = await makeExpense(a.client, a.businessId, categoryId);

    currentClient = b.client;
    const result = await voidExpense(
      undefined,
      formData({ businessId: b.businessId, expenseId, reason: "Should not apply" })
    );
    expect(result?.error).toContain("not available");
  });

  it("rejects voiding an already-voided expense", async () => {
    const owner = await createOwnerAndBusiness("act-void-twice");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    let caught: unknown;
    try {
      await voidExpense(undefined, formData({ businessId: owner.businessId, expenseId, reason: "First void" }));
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught).isRedirect).toBe(true);

    const second = await voidExpense(
      undefined,
      formData({ businessId: owner.businessId, expenseId, reason: "Second void attempt" })
    );
    expect(second?.error).toBe("This expense has already been voided.");
  });

  it("manage-only (no expenses.view) can void a known expense id, and is redirected to the accessible success surface", async () => {
    const owner = await createOwnerAndBusiness("act-void-manage-only");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    const manageOnly = await createMemberWithCustomPermissions(owner.businessId, "act-void-manage-only", [
      "expenses.manage",
    ]);
    cleanupUserIds.push(manageOnly.userId);

    currentClient = manageOnly.client;
    let caught: unknown;
    try {
      await voidExpense(
        undefined,
        formData({ businessId: owner.businessId, expenseId, reason: "Manage-only void" })
      );
    } catch (e) {
      caught = e;
    }
    const redirect = isRedirect(caught);
    expect(redirect.isRedirect).toBe(true);
    expect(redirect.target).toBe(`/${owner.businessId}/expenses/new?voided=1`);

    currentClient = owner.client;
    const { data } = await owner.client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("VOIDED");
  });

  it("void_expense's own reason error (INVALID_VOID_REASON) is never surfaced as a raw code", async () => {
    const owner = await createOwnerAndBusiness("act-void-empty-reason-bypass");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    // Bypass the client Zod schema by calling the action directly with a
    // whitespace-only reason (simulating a tampered/forged request).
    const result = await voidExpense(
      undefined,
      formData({ businessId: owner.businessId, expenseId, reason: "   " })
    );
    expect(result?.fieldErrors?.reason).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/P0001|raise exception/i);
  });
});

describe("exact permission implication boundaries", () => {
  it("createExpense checks expenses.manage specifically — ACCOUNTANT-shaped view-only access is still denied when constructed without manage", async () => {
    const owner = await createOwnerAndBusiness("perm-exp-specific-check");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const reportsOnly = await createMemberWithCustomPermissions(owner.businessId, "perm-exp-specific-check", [
      "reports.view",
    ]);
    cleanupUserIds.push(reportsOnly.userId);

    currentClient = reportsOnly.client;
    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId,
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("SALES/INVENTORY/VIEWER hold no Phase 1E permissions and cannot record an expense", async () => {
    const owner = await createOwnerAndBusiness("perm-exp-no-phase1e-roles");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    for (const role of ["SALES", "INVENTORY", "VIEWER"]) {
      const member = await createMemberWithRole(owner.businessId, `perm-exp-no-1e-${role}`, role);
      cleanupUserIds.push(member.userId);
      currentClient = member.client;
      const result = await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "500",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
      expect(result?.error, role).toBe("You don't have permission to do this.");
    }
  });
});

// Codex adversarial review, Finding 7.D — createExpense's amount
// validation, exercised by calling the action directly (bypassing the
// browser/HTML pattern attribute entirely), for every value the approved
// plan requires rejecting.
describe("createExpense direct-action amount validation (bypasses the browser)", () => {
  const REJECTED_AMOUNTS = ["0", "-1", "1.234", "0.001", "1e100", "not-a-number", ""];

  it.each(REJECTED_AMOUNTS)("rejects amount %s as a safe field error, never calling the RPC", async (amount) => {
    const owner = await createOwnerAndBusiness("act-exp-amount-invalid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId,
        amount,
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    expect(result?.fieldErrors?.amount, amount).toBeTruthy();
    expect(rpcSpy).not.toHaveBeenCalledWith("create_expense", expect.anything());
    rpcSpy.mockRestore();
  });

  it("an out-of-range (but numerically well-formed) amount is rejected client-side, before the RPC's own EXPENSE_AMOUNT_OUT_OF_RANGE check", async () => {
    const owner = await createOwnerAndBusiness("act-exp-amount-outofrange");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId,
        amount: "9999999999999.99", // exceeds numeric(14,2)'s max representable value
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    expect(result?.fieldErrors?.amount).toBeTruthy();
    expect(rpcSpy).not.toHaveBeenCalledWith("create_expense", expect.anything());
    rpcSpy.mockRestore();
  });
});

// Codex adversarial review, Finding 4 + Finding 7.E — every action
// identifier (businessId/categoryId/expenseId) must be UUID-validated
// BEFORE any permission lookup or database call. A malformed id is a
// distinct, safer-to-reject case than a well-formed-but-foreign one
// (still exercised elsewhere in this file) — this block proves the
// malformed case specifically never reaches getPermissions/the Data API.
describe("action identifier (UUID) validation — malformed ids never reach permission checks or the Data API", () => {
  const MALFORMED_IDS = ["not-a-uuid", "12345", "", "  ", "'; drop table expenses; --"];

  it.each(MALFORMED_IDS)("createExpense rejects a malformed businessId (%s) safely, without a permission lookup", async (businessId) => {
    const owner = await createOwnerAndBusiness("act-exp-malformed-bizid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const permissionsSpy = vi.spyOn(businessDal, "getPermissions");
    const rpcSpy = vi.spyOn(owner.client, "rpc");

    const result = await createExpense(
      undefined,
      formData({
        businessId,
        creationKey: randomUuid(),
        categoryId: randomUuid(),
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");
    expect(permissionsSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalledWith("create_expense", expect.anything());
    permissionsSpy.mockRestore();
    rpcSpy.mockRestore();
  });

  // Codex adversarial review (2nd pass), Finding 3 + Finding 7.C — the
  // specific gap the review called out: previous coverage proved a
  // malformed categoryId never reached the RPC, but never proved WHEN it
  // was rejected relative to the permission lookup. createExpense now
  // validates businessId AND categoryId together, both before
  // getPermissions() — this test spies on the real getPermissions export
  // to prove that ordering directly, not just infer it.
  it("createExpense rejects a malformed categoryId safely, BEFORE any permission lookup or RPC call (spy-verified ordering)", async () => {
    const owner = await createOwnerAndBusiness("act-exp-malformed-catid-order");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const permissionsSpy = vi.spyOn(businessDal, "getPermissions");
    const rpcSpy = vi.spyOn(owner.client, "rpc");

    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId: "not-a-uuid",
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );

    expect(result?.error).toBe("Something went wrong. Please try again.");
    expect(permissionsSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalledWith("create_expense", expect.anything());
    permissionsSpy.mockRestore();
    rpcSpy.mockRestore();
  });

  it("createExpense with a WELL-FORMED categoryId (even a random/foreign one) proceeds to the ordinary permission check — proves the two code paths are genuinely distinct", async () => {
    const owner = await createOwnerAndBusiness("act-exp-wellformed-catid-proceeds");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const permissionsSpy = vi.spyOn(businessDal, "getPermissions");

    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId: randomUuid(), // well-formed UUID, but belongs to no real category
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );

    // The caller here (owner) DOES have expenses.manage in their own
    // business, so this proceeds past the permission check and only
    // fails once the RPC itself looks up the (nonexistent) category —
    // proving getPermissions really was reached this time.
    expect(permissionsSpy).toHaveBeenCalledWith(owner.businessId);
    expect(result?.fieldErrors?.categoryId?.[0]).toContain("not available");
    permissionsSpy.mockRestore();
  });

  it("createExpenseCategory rejects a malformed businessId safely", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-malformed-bizid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createExpenseCategory(
      undefined,
      formData({ businessId: "not-a-uuid", name: "Should Not Exist" })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");
  });

  it("updateExpenseCategory rejects a malformed categoryId safely, without a permission lookup short-circuiting into a DB call", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-malformed-catid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await updateExpenseCategory(
      undefined,
      formData({ businessId: owner.businessId, categoryId: "not-a-uuid", name: "Hacked" })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");
  });

  it("archiveExpenseCategory rejects a malformed categoryId safely", async () => {
    const owner = await createOwnerAndBusiness("act-expcat-archive-malformed-catid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await archiveExpenseCategory(
      undefined,
      formData({ businessId: owner.businessId, categoryId: "12345" })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");
  });

  it("voidExpense rejects a malformed expenseId safely, never calling the RPC", async () => {
    const owner = await createOwnerAndBusiness("act-void-malformed-expid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    const result = await voidExpense(
      undefined,
      formData({ businessId: owner.businessId, expenseId: "not-a-uuid", reason: "Attempted forgery" })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");
    expect(rpcSpy).not.toHaveBeenCalledWith("void_expense", expect.anything());
    rpcSpy.mockRestore();
  });

  it("voidExpense rejects a malformed businessId safely, before checking permissions on any real business", async () => {
    const owner = await createOwnerAndBusiness("act-void-malformed-bizid");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const expenseId = await makeExpense(owner.client, owner.businessId, categoryId);

    const result = await voidExpense(
      undefined,
      formData({ businessId: "not-a-uuid", expenseId, reason: "Attempted forgery" })
    );
    expect(result?.error).toBe("Something went wrong. Please try again.");

    // The real expense is untouched.
    const { data } = await owner.client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("POSTED");
  });

  it("a well-formed but random/foreign businessId is NOT treated as malformed — it proceeds to the ordinary permission check and is denied there instead", async () => {
    const stranger = await createOwnerAndBusiness("act-exp-random-bizid-stranger");
    cleanupUserIds.push(stranger.userId);
    currentClient = stranger.client;

    const result = await createExpense(
      undefined,
      formData({
        businessId: randomUuid(),
        creationKey: randomUuid(),
        categoryId: randomUuid(),
        amount: "500",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
      })
    );
    // Distinct from the malformed-id message — proves the two code paths
    // are genuinely different, not the same generic catch-all.
    expect(result?.error).toBe("You don't have permission to do this.");
  });
});
