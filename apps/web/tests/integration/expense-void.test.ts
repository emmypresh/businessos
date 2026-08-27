import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("void_expense", () => {
  it("POSTED -> VOIDED: sets status/voided_at/voided_by/void_reason, leaves every other field untouched", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-basic");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, { amount: 777, payee: "Landlord" });

    const result = await client.rpc("void_expense", {
      p_business_id: businessId,
      p_expense_id: expenseId,
      p_reason: "Recorded in error",
    });
    expect(result.error).toBeNull();
    expect(result.data).toBe(expenseId);

    const { data } = await client
      .from("expenses")
      .select("status, voided_at, voided_by, void_reason, amount, payee, category_id, payment_method")
      .eq("id", expenseId)
      .single();
    expect(data?.status).toBe("VOIDED");
    expect(data?.voided_at).not.toBeNull();
    expect(data?.voided_by).toBe(userId);
    expect(data?.void_reason).toBe("Recorded in error");
    // Amount and every other original field is unchanged.
    expect(Number(data?.amount)).toBe(777);
    expect(data?.payee).toBe("Landlord");
    expect(data?.category_id).toBe(categoryId);
    expect(data?.payment_method).toBe("CASH");
  });

  it("a void reason is required — empty/whitespace-only is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-reason-required");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    const empty = await client.rpc("void_expense", {
      p_business_id: businessId, p_expense_id: expenseId, p_reason: "",
    });
    expect(empty.error?.message).toContain("INVALID_VOID_REASON");

    const whitespace = await client.rpc("void_expense", {
      p_business_id: businessId, p_expense_id: expenseId, p_reason: "   ",
    });
    expect(whitespace.error?.message).toContain("INVALID_VOID_REASON");

    const { data } = await client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("POSTED");
  });

  it("voiding an already-voided expense returns a controlled EXPENSE_ALREADY_VOIDED error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-already-voided");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    const first = await client.rpc("void_expense", {
      p_business_id: businessId, p_expense_id: expenseId, p_reason: "First void",
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("void_expense", {
      p_business_id: businessId, p_expense_id: expenseId, p_reason: "Second void attempt",
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain("EXPENSE_ALREADY_VOIDED");

    // The original void reason is unchanged by the rejected second attempt.
    const { data } = await client.from("expenses").select("void_reason").eq("id", expenseId).single();
    expect(data?.void_reason).toBe("First void");
  });

  it("a foreign-tenant expense id fails safely, indistinguishable from a nonexistent one", async () => {
    const a = await createOwnerAndBusiness("expvoid-foreign-a");
    const b = await createOwnerAndBusiness("expvoid-foreign-b");
    cleanupUserIds.push(a.userId, b.userId);
    const categoryId = await getDefaultCategoryId(a.client, a.businessId);
    const expenseId = await makeExpense(a.client, a.businessId, categoryId);

    const foreignAttempt = await b.client.rpc("void_expense", {
      p_business_id: b.businessId, p_expense_id: expenseId, p_reason: "Attempted cross-tenant void",
    });
    expect(foreignAttempt.error).not.toBeNull();
    expect(foreignAttempt.error?.message).toContain("EXPENSE_NOT_FOUND");

    const nonexistentAttempt = await b.client.rpc("void_expense", {
      p_business_id: b.businessId, p_expense_id: randomUuid(), p_reason: "Attempted nonexistent void",
    });
    expect(nonexistentAttempt.error?.message).toBe(foreignAttempt.error?.message);

    // The real (foreign) expense is untouched.
    const { data } = await a.client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("POSTED");
  });

  it("only expenses.manage holders may void — VIEWER is denied", async () => {
    const { businessId, client: ownerClient, userId } = await createOwnerAndBusiness("expvoid-denied");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(ownerClient, businessId);
    const expenseId = await makeExpense(ownerClient, businessId, categoryId);

    const viewer = await createMemberWithRole(businessId, "expvoid-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    const result = await viewer.client.rpc("void_expense", {
      p_business_id: businessId, p_expense_id: expenseId, p_reason: "Should not be allowed",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });

  it("no direct authenticated UPDATE or DELETE on expenses exists — void is RPC-only", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-no-direct-write");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    const update = await client.from("expenses").update({ status: "VOIDED" } as never).eq("id", expenseId);
    expect(update.error).not.toBeNull();

    const del = await client.from("expenses").delete().eq("id", expenseId);
    expect(del.error).not.toBeNull();

    const { data } = await client.from("expenses").select("status").eq("id", expenseId).single();
    expect(data?.status).toBe("POSTED");
  });

  it("a voided expense remains queryable and historically visible (never removed from listings)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-remains-queryable");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    await client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "Voided" });

    const { data } = await client.from("expenses").select("id, status").eq("business_id", businessId);
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(expenseId);
    expect(data![0].status).toBe("VOIDED");
  });

  it("the amount cannot be mutated by voiding, and no other column is touched by the immutability trigger's exclusion list", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expvoid-amount-immutable");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      amount: 12345.67, incurredAt: "2026-02-01T00:00:00Z", reference: "REF-VOID-TEST",
    });
    const before = await client
      .from("expenses")
      .select("expense_number, category_id, amount, currency_code, payment_method, reference, incurred_at, created_by, created_at")
      .eq("id", expenseId)
      .single();

    await client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "Voided" });

    const after = await client
      .from("expenses")
      .select("expense_number, category_id, amount, currency_code, payment_method, reference, incurred_at, created_by, created_at")
      .eq("id", expenseId)
      .single();
    expect(after.data).toEqual(before.data);
  });
});
