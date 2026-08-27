import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, expensePayload, makeExpense, makeExpenseCategory } from "./helpers/expenses";

/**
 * Codex round-2 adversarial findings on the Phase 1E database foundation.
 * Every test here is PERMANENT regression coverage for a confirmed gap,
 * not exploratory — see the corresponding migration comments for the
 * fixes these tests lock in.
 */

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("A. amount precision — accept/reject matrix, no side effects on rejection", () => {
  const ACCEPTED = [1, 1.0, 1.00, 1.2, 1.23, 0.01, 999999999999.99];
  const REJECTED = [1.234, 1.235, 0.001, 999999999999.999];

  it.each(ACCEPTED)("accepts amount %s", async (amount) => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expprec-accept");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const result = await client.rpc("create_expense", expensePayload(businessId, categoryId, { amount }));
    expect(result.error, String(amount)).toBeNull();
  });

  it.each(REJECTED)("rejects amount %s — no expense row, no request-ledger row, no sequence advancement", async (amount) => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expprec-reject");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const result = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { amount, creationKey: key })
    );
    expect(result.error, String(amount)).not.toBeNull();

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses, String(amount)).toHaveLength(0);

    const sql = createTestDbClient();
    try {
      const ledger = await sql<{ n: string }[]>`
        select count(*)::int as n from private.expense_creation_requests
        where business_id = ${businessId} and creation_key = ${key}
      `;
      expect(Number(ledger[0].n), String(amount)).toBe(0);

      const seq = await sql<{ n: string }[]>`
        select count(*)::int as n from private.business_expense_sequences where business_id = ${businessId}
      `;
      expect(Number(seq[0].n), String(amount)).toBe(0);
    } finally {
      await sql.end();
    }

    // The key was never poisoned — a retry with a corrected amount, same
    // key, succeeds fresh.
    const retry = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { amount: 1.23, creationKey: key })
    );
    expect(retry.error, String(amount)).toBeNull();
  });
});

describe("B. amount canonical idempotency — numerically equal amounts replay as the same intent", () => {
  // JS itself has no decimal-literal-preserving number type — 1, 1.0, and
  // 1.00 are the exact same JS `number` (and therefore the exact same
  // JSON wire value) regardless of how the source literal is written, so
  // a supabase-js client can never actually send textually-different
  // representations of the same amount. What DOES need to be pinned down
  // is that create_expense's own canonicalization (v_amount_narrowed, a
  // numeric(14,2) value, ::text'd for the payload) is what makes this
  // safe — proven by asserting a replay with the SAME numeric amount
  // succeeds — and that an incidental, ignored difference elsewhere in
  // the request (a fresh incurred_at per call, unless pinned) does NOT
  // silently merge into a false replay. incurred_at is pinned to a fixed
  // instant here so amount is the only variable under test.
  const FIXED_INCURRED_AT = "2026-05-01T00:00:00Z";

  it("identical amount, submitted twice under the same key: one expense, same UUID", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcanon-identical-replay");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();
    const payload = expensePayload(businessId, categoryId, {
      amount: 1, creationKey: key, incurredAt: FIXED_INCURRED_AT,
    });

    const first = await client.rpc("create_expense", payload);
    expect(first.error).toBeNull();

    const replay = await client.rpc("create_expense", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);

    const sql = createTestDbClient();
    try {
      const ledgerCount = await sql<{ n: number }[]>`
        select count(*)::int as n from private.expense_creation_requests
        where business_id = ${businessId} and creation_key = ${key}
      `;
      expect(Number(ledgerCount[0].n)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("the canonicalization expression itself: differently-scaled but numerically equal inputs produce identical text (locks in the Finding-4 fix directly)", async () => {
    // Reproduces the EXACT scenario Codex's finding demonstrated at the
    // SQL level: '1'::numeric, '1.0'::numeric, and '1.00'::numeric carry
    // different display scale and therefore ::text differently — UNLESS
    // first narrowed through numeric(14,2), which is exactly what
    // create_expense's v_amount_narrowed does before building the
    // canonical payload. This proves that fix directly, independent of
    // any client's inability to send differently-scaled literals over
    // JSON.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ a: string; b: string; c: string }[]>`
        select
          ((1::numeric)::numeric(14,2))::text as a,
          ((1.0::numeric)::numeric(14,2))::text as b,
          ((1.00::numeric)::numeric(14,2))::text as c
      `;
      expect(rows[0].a).toBe(rows[0].b);
      expect(rows[0].b).toBe(rows[0].c);
      expect(rows[0].a).toBe("1.00");
    } finally {
      await sql.end();
    }
  });

  it("the persisted amount is stored at exactly numeric(14,2) scale regardless of caller formatting", async () => {
    // Queried via the raw DB client, not PostgREST/supabase-js: PostgREST's
    // own numeric->JSON serialization trims trailing zeros (1.00 arrives
    // client-side as the JSON number 1), which is a transport-layer
    // detail unrelated to actual column storage — the raw driver reflects
    // the real stored value, exactly like the column's own numeric(14,2)
    // type declares.
    const { client, businessId, userId } = await createOwnerAndBusiness("expcanon-normalized-storage");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const expenseId = await makeExpense(client, businessId, categoryId, { amount: 1, incurredAt: FIXED_INCURRED_AT });

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ amount_text: string }[]>`
        select amount::text as amount_text from public.expenses where id = ${expenseId}
      `;
      expect(rows[0].amount_text).toBe("1.00");
    } finally {
      await sql.end();
    }
  });
});

describe("C. currency structural invariant", () => {
  it("a privileged direct SQL INSERT with currency_code = 'USD' is rejected by the table CHECK", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcurr-structural-reject");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.expenses (
            business_id, expense_number, category_id, category_name_snapshot,
            amount, currency_code, payment_method, incurred_at, creation_key, created_by
          ) values (
            ${businessId}, 'EXP-999999', ${categoryId}, 'Rent',
            100.00, 'USD', 'CASH', now(), ${randomUuid()}, ${userId}
          )
        `
      ).rejects.toThrow(/currency_code/i);
    } finally {
      await sql.end();
    }
  });

  it("create_expense always persists NGN regardless of anything else about the request", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcurr-rpc-always-ngn");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const expenseId = await makeExpense(client, businessId, categoryId);
    const { data } = await client.from("expenses").select("currency_code").eq("id", expenseId).single();
    expect(data?.currency_code).toBe("NGN");
  });
});

describe("D. expenses.manage without expenses.view: the category management contract", () => {
  it("can read/create/rename/archive categories, but cannot read expenses directly", async () => {
    const owner = await createOwnerAndBusiness("expmanageonly-contract");
    cleanupUserIds.push(owner.userId);
    const existingCategoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    await makeExpense(owner.client, owner.businessId, existingCategoryId);

    const member = await createMemberWithCustomPermissions(owner.businessId, "expmanageonly-contract", [
      "expenses.manage",
    ]);
    cleanupUserIds.push(member.userId);

    // SELECT succeeds — visibility granted via expenses.manage in the OR
    // clause, not because manage implies view.
    const { data: categories, error: selectErr } = await member.client
      .from("expense_categories")
      .select("id, name")
      .eq("business_id", owner.businessId);
    expect(selectErr).toBeNull();
    expect((categories ?? []).length).toBe(10);

    // CREATE succeeds.
    const { data: created, error: createErr } = await member.client
      .from("expense_categories")
      .insert({ business_id: owner.businessId, name: "Manage-Only Category" })
      .select("id")
      .single();
    expect(createErr).toBeNull();

    // RENAME succeeds.
    const { error: renameErr } = await member.client
      .from("expense_categories")
      .update({ name: "Renamed By Manage-Only" })
      .eq("id", created!.id);
    expect(renameErr).toBeNull();

    // ARCHIVE succeeds.
    const { error: archiveErr } = await member.client
      .from("expense_categories")
      .update({ status: "ARCHIVED" })
      .eq("id", created!.id);
    expect(archiveErr).toBeNull();

    // Direct expenses SELECT remains denied — expenses.manage does NOT
    // imply expenses.view; public.expenses' own SELECT policy is
    // untouched by the category-visibility fix.
    const { data: expenses, error: expensesErr } = await member.client
      .from("expenses")
      .select("id")
      .eq("business_id", owner.businessId);
    expect(expensesErr).toBeNull();
    expect(expenses ?? []).toHaveLength(0);
  });

  it("expenses.view alone: can read categories, cannot insert/update them", async () => {
    const owner = await createOwnerAndBusiness("expviewonly-contract");
    cleanupUserIds.push(owner.userId);

    const member = await createMemberWithCustomPermissions(owner.businessId, "expviewonly-contract", [
      "expenses.view",
    ]);
    cleanupUserIds.push(member.userId);

    const { data: categories, error: selectErr } = await member.client
      .from("expense_categories")
      .select("id, name")
      .eq("business_id", owner.businessId);
    expect(selectErr).toBeNull();
    expect((categories ?? []).length).toBe(10);

    const insert = await member.client
      .from("expense_categories")
      .insert({ business_id: owner.businessId, name: "Should Not Exist" });
    expect(insert.error).not.toBeNull();

    // The UPDATE's USING clause (expenses.manage) evaluates false for
    // every row this caller can even see, so Postgres matches zero rows —
    // that is not itself a Postgres error (the same "zero-row update
    // succeeds trivially" behavior documented for updateCustomer in Phase
    // 1D). The real, meaningful assertion is that the row is unchanged.
    const anyCategoryId = categories![0].id;
    const originalName = categories![0].name;
    const update = await member.client
      .from("expense_categories")
      .update({ name: "Should Not Change" })
      .eq("id", anyCategoryId);
    expect(update.error).toBeNull();

    const { data: after } = await owner.client
      .from("expense_categories")
      .select("name")
      .eq("id", anyCategoryId)
      .single();
    expect(after?.name).toBe(originalName);
  });
});

describe("F. concurrent same-key, different intent", () => {
  it("exactly one of two genuinely concurrent conflicting requests succeeds; the other gets EXPENSE_IDEMPOTENCY_KEY_REUSED; exactly one sequence number consumed", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expconcurrent-conflict");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const [a, b] = await Promise.all([
      client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: 100, creationKey: key })),
      client.rpc("create_expense", expensePayload(businessId, categoryId, { amount: 200, creationKey: key })),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("EXPENSE_IDEMPOTENCY_KEY_REUSED");

    const { data: expenses } = await client.from("expenses").select("id, expense_number").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);
    expect(expenses![0].id).toBe(succeeded[0].data);

    const sql = createTestDbClient();
    try {
      const seq = await sql<{ next_number: string }[]>`
        select next_number from private.business_expense_sequences where business_id = ${businessId}
      `;
      // Exactly one allocation happened: the counter started implicitly
      // at 1 and is now 2 — the losing request never reached the
      // sequence claim at all (it fails at the replay-comparison step,
      // which runs before any category/sequence work). bigint columns
      // come back as strings from the postgres driver (precision safety).
      expect(seq).toHaveLength(1);
      expect(Number(seq[0].next_number)).toBe(2);
    } finally {
      await sql.end();
    }
  });
});

describe("G. concurrent double void", () => {
  it("exactly one of two genuinely concurrent void attempts succeeds; the other gets EXPENSE_ALREADY_VOIDED; final state is consistent", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expconcurrent-void");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    const [a, b] = await Promise.all([
      client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "Concurrent void A" }),
      client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "Concurrent void B" }),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("EXPENSE_ALREADY_VOIDED");

    const { data } = await client
      .from("expenses")
      .select("status, voided_at, voided_by, void_reason")
      .eq("id", expenseId)
      .single();
    expect(data?.status).toBe("VOIDED");
    expect(data?.voided_at).not.toBeNull();
    expect(["Concurrent void A", "Concurrent void B"]).toContain(data?.void_reason);
  });
});

describe("H/I. timestamp canonicalization", () => {
  it("H: the same instant expressed with a different UTC offset replays as the same intent", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expts-offset-equivalence");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const first = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, incurredAt: "2026-08-27T10:00:00Z" })
    );
    expect(first.error).toBeNull();

    // 11:00+01:00 is the exact same instant as 10:00Z.
    const replay = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, incurredAt: "2026-08-27T11:00:00+01:00" })
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);
  });

  it("I: microsecond-different instants under the same key are a genuine conflict, never silently merged", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expts-fractional-precision");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);
    const key = randomUuid();

    const first = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, incurredAt: "2026-08-27T10:00:00.123456Z" })
    );
    expect(first.error).toBeNull();

    const conflicting = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, incurredAt: "2026-08-27T10:00:00.123457Z" })
    );
    expect(conflicting.error).not.toBeNull();
    expect(conflicting.error?.message).toContain("EXPENSE_IDEMPOTENCY_KEY_REUSED");

    // The identical microsecond-precise instant, restated, still replays
    // cleanly (equivalent-offset/equivalent-representation equality is
    // preserved even at microsecond precision).
    const exactReplay = await client.rpc(
      "create_expense",
      expensePayload(businessId, categoryId, { creationKey: key, incurredAt: "2026-08-27T10:00:00.123456Z" })
    );
    expect(exactReplay.error).toBeNull();
    expect(exactReplay.data).toBe(first.data);
  });
});

describe("J. category mutation replay", () => {
  it("renaming then archiving the category after creation does not affect an exact replay of the original request", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-mutation-replay");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId, { name: "Original Category" });
    const key = randomUuid();
    const payload = expensePayload(businessId, categoryId, { creationKey: key });

    const original = await client.rpc("create_expense", payload);
    expect(original.error).toBeNull();

    await client.from("expense_categories").update({ name: "Renamed Category" }).eq("id", categoryId);
    await client.from("expense_categories").update({ status: "ARCHIVED" }).eq("id", categoryId);

    const replay = await client.rpc("create_expense", payload);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(original.data);

    const { data: expenses } = await client.from("expenses").select("id").eq("business_id", businessId);
    expect(expenses).toHaveLength(1);

    // The original snapshot is unaffected either.
    const { data: expense } = await client
      .from("expenses")
      .select("category_name_snapshot")
      .eq("id", original.data!)
      .single();
    expect(expense?.category_name_snapshot).toBe("Original Category");
  });
});
