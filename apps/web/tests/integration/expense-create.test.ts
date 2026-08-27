import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import {
  createOwnerAndBusiness,
  createMemberWithRole,
  createMemberWithCustomPermissions,
  randomUuid,
} from "./helpers/inventory";
import { getDefaultCategoryId, expensePayload, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("create_expense role access", () => {
  const ALLOWED = ["OWNER", "ADMIN", "MANAGER", "ACCOUNTANT"] as const;
  const DENIED = ["SALES", "INVENTORY", "VIEWER"] as const;

  it.each(ALLOWED)("%s can create an expense", async (role) => {
    const owner = await createOwnerAndBusiness(`expcreate-allowed-${role.toLowerCase()}`);
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);

    let actor = owner;
    if (role !== "OWNER") {
      const member = await createMemberWithRole(owner.businessId, `expcreate-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      actor = { ...owner, client: member.client };
    }

    const result = await actor.client.rpc("create_expense", expensePayload(owner.businessId, categoryId));
    expect(result.error, role).toBeNull();
    expect(result.data).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(DENIED)("%s cannot create an expense", async (role) => {
    const owner = await createOwnerAndBusiness(`expcreate-denied-${role.toLowerCase()}`);
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const member = await createMemberWithRole(owner.businessId, `expcreate-denied-${role.toLowerCase()}`, role);
    cleanupUserIds.push(member.userId);

    const result = await member.client.rpc(
      "create_expense",
      expensePayload(owner.businessId, categoryId)
    );
    expect(result.error, role).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });

  it("the check is expenses.manage specifically, independent of role name — a fixture role holding every OTHER permission but that one is still denied", async () => {
    const owner = await createOwnerAndBusiness("expcreate-perm-specific");
    cleanupUserIds.push(owner.userId);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    const member = await createMemberWithCustomPermissions(owner.businessId, "expcreate-perm-specific", [
      "expenses.view", "reports.view", "sales.view", "sales.create", "customers.view", "customers.manage",
    ]);
    cleanupUserIds.push(member.userId);

    const result = await member.client.rpc("create_expense", expensePayload(owner.businessId, categoryId));
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/insufficient_privilege/i);
  });
});

describe("create_expense amount validation", () => {
  it("a positive amount is accepted", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-positive");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: 2500.5 }));
    expect(result.error).toBeNull();
    const { data } = await client.from("expenses").select("amount").eq("id", result.data!).single();
    expect(Number(data?.amount)).toBe(2500.5);
  });

  it("a null amount is rejected with a controlled error", async () => {
    // p_amount is a native `numeric` RPC parameter (mirroring create_sale's
    // own p_discount/p_amount_paid) — a genuinely non-numeric JSON value
    // (e.g. a string) is rejected by PostgREST's own argument binding
    // BEFORE this function body ever runs, exactly as it would be for any
    // numeric-typed RPC parameter; that boundary is not this function's to
    // control. Missing/null, by contrast, IS a value the function body
    // itself validates.
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-null");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", {
      ...expensePayload(businessId, categoryId),
      p_amount: null as never,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_AMOUNT");
  });

  it("a zero amount is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-zero");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: 0 }));
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_AMOUNT");
  });

  it("a negative amount is rejected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-negative");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: -50 }));
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_AMOUNT");
  });

  it("an amount exceeding numeric(14,2)'s representable range is rejected, never a raw overflow error", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-overflow");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: 1e15 }));
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("EXPENSE_AMOUNT_OUT_OF_RANGE");
    expect(result.error?.message).not.toMatch(/numeric field overflow/i);
  });

  it("an amount at the exact numeric(14,2) maximum is accepted", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-amount-max");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { amount: 999999999999.99 })
    );
    expect(result.error).toBeNull();
  });
});

describe("create_expense payment method / field bounds", () => {
  it.each(["CASH", "BANK_TRANSFER", "CARD", "OTHER"])("accepts payment method %s", async (method) => {
    const { client, businessId, userId } = await createOwnerAndBusiness(`expcreate-pm-${method.toLowerCase()}`);
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { paymentMethod: method })
    );
    expect(result.error, method).toBeNull();
  });

  it("rejects an invalid payment method", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-pm-invalid");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { paymentMethod: "CRYPTO" })
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_PAYMENT_METHOD");
  });

  it("accepts payee/reference/notes within bounds and rejects them over bounds", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-field-bounds");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const ok = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { payee: "Landlord Ltd", reference: "INV-1", notes: "note" })
    );
    expect(ok.error).toBeNull();

    const badPayee = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { payee: "x".repeat(201) })
    );
    expect(badPayee.error?.message).toContain("INVALID_EXPENSE_PAYEE");

    const badReference = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { reference: "x".repeat(101) })
    );
    expect(badReference.error?.message).toContain("INVALID_EXPENSE_REFERENCE");

    const badNotes = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { notes: "x".repeat(2001) })
    );
    expect(badNotes.error?.message).toContain("INVALID_EXPENSE_NOTES");
  });

  it("rejects a null/missing incurred_at date", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-date-missing");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", {
      ...expensePayload(businessId, categoryId),
      p_incurred_at: null as never,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_DATE");
  });

  it("rejects a date meaningfully in the future", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-date-future");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { incurredAt: future })
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("INVALID_EXPENSE_DATE");
  });

  it("accepts a historical (past) incurred_at date", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-date-past");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const past = new Date("2020-01-01T00:00:00Z").toISOString();
    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { incurredAt: past })
    );
    expect(result.error).toBeNull();
  });
});

describe("create_expense idempotency", () => {
  it("an exact replay under the same creation_key returns the original expense_id", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-idem-exact");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();
    const payload = expensePayload(businessId, categoryId, { creationKey: key });

    const first = await client.rpc("create_expense", payload);
    expect(first.error).toBeNull();
    const second = await client.rpc("create_expense", payload);
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);
  });

  it("a conflicting replay (same key, different amount) is rejected, original untouched", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-idem-conflict");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const first = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, amount: 100 })
    );
    expect(first.error).toBeNull();

    const conflicting = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, amount: 200 })
    );
    expect(conflicting.error).not.toBeNull();
    expect(conflicting.error?.message).toContain("EXPENSE_IDEMPOTENCY_KEY_REUSED");

    const { data: expense } = await client.from("expenses").select("amount").eq("id", first.data!).single();
    expect(Number(expense?.amount)).toBe(100);
  });

  it("concurrent identical requests under the same creation_key produce exactly one expense", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-idem-concurrent");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const payload = expensePayload(businessId, categoryId, { creationKey: randomUuid() });

    const [a, b] = await Promise.all([
      client.rpc("create_expense", payload),
      client.rpc("create_expense", payload),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).toBe(b.data);

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);
  });

  it("a failed request (invalid category) does not poison the creation_key for a subsequent valid attempt", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-idem-failure-not-poisoned");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const failed = await client.rpc("create_expense", {
      ...expensePayload(businessId, categoryId, { creationKey: key }),
      p_category_id: randomUuid(), // nonexistent category -> EXPENSE_CATEGORY_NOT_FOUND
    });
    expect(failed.error).not.toBeNull();
    expect(failed.error?.message).toContain("EXPENSE_CATEGORY_NOT_FOUND");

    // The failed attempt must not have claimed the key: nothing was
    // committed (the whole transaction rolled back), so a subsequent
    // genuinely valid attempt under the SAME key succeeds fresh, rather
    // than being told the key was already used.
    const retry = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key })
    );
    expect(retry.error).toBeNull();

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);
  });

  it("create_expense's RPC response contains only the bare expense_id", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcreate-narrow-return");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId));
    expect(result.error).toBeNull();
    expect(typeof result.data).toBe("string");
    expect(result.data).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("expense_number sequencing", () => {
  it("expense numbers are unique per business and sequential", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expnum-uniqueness");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await makeExpense(client, businessId, categoryId));
    }
    const { data } = await client.from("expenses").select("expense_number").in("id", ids);
    const numbers = data!.map((e) => e.expense_number);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.sort()).toEqual(["EXP-000001", "EXP-000002", "EXP-000003"]);
  });

  it("999998 -> 999999 -> 1000000 -> 1000001: no truncation, no collision at the six-digit boundary", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expnum-boundary");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const sql = createTestDbClient();
    try {
      await sql`
        insert into private.business_expense_sequences (business_id, next_number)
        values (${businessId}, 999998)
        on conflict (business_id) do update set next_number = 999998
      `;
    } finally {
      await sql.end();
    }

    const expected = ["EXP-999998", "EXP-999999", "EXP-1000000", "EXP-1000001"];
    for (const expectedNumber of expected) {
      const id = await makeExpense(client, businessId, categoryId);
      const { data } = await client.from("expenses").select("expense_number").eq("id", id).single();
      expect(data?.expense_number, `expected ${expectedNumber}`).toBe(expectedNumber);
    }
  });

  it("a failed create_expense attempt rolls back its sequence claim (no gap-causing consumption on that specific failure)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expnum-rollback");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    // Consume EXP-000001 for real.
    const first = await makeExpense(client, businessId, categoryId);
    const { data: firstRow } = await client.from("expenses").select("expense_number").eq("id", first).single();
    expect(firstRow?.expense_number).toBe("EXP-000001");

    // Archive the category, then attempt a NEW (different key) expense
    // against it — fails AFTER the sequence claim would occur in program
    // order, but the category check happens BEFORE the sequence claim in
    // create_expense, so this specific failure never even reaches the
    // sequence table. Proven by the next successful call still landing on
    // EXP-000002, not EXP-000003.
    await client.from("expense_categories").update({ status: "ARCHIVED" }).eq("id", categoryId);
    const failed = await client.rpc("create_expense", expensePayload(businessId, categoryId));
    expect(failed.error?.message).toContain("EXPENSE_CATEGORY_ARCHIVED");

    const freshCategoryId = await getDefaultCategoryId(client, businessId, "Utilities");
    const second = await makeExpense(client, businessId, freshCategoryId);
    const { data: secondRow } = await client.from("expenses").select("expense_number").eq("id", second).single();
    expect(secondRow?.expense_number).toBe("EXP-000002");
  });
});
