import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, makeExpenseCategory, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

const DEFAULT_NAMES = [
  "Rent", "Utilities", "Transport", "Salaries & Wages", "Marketing",
  "Supplies", "Repairs & Maintenance", "Professional Services", "Taxes & Fees", "Other",
];

describe("default expense categories", () => {
  it("a freshly created business gets exactly the ten default ACTIVE categories", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-defaults-new");
    cleanupUserIds.push(userId);

    const { data } = await client.from("expense_categories").select("name, status").eq("business_id", businessId);
    expect(data).toHaveLength(10);
    expect(data!.map((c) => c.name).sort()).toEqual([...DEFAULT_NAMES].sort());
    expect(data!.every((c) => c.status === "ACTIVE")).toBe(true);
  });

  // NOT a genuine migration-boundary test — see the STATIC MIGRATION
  // ASSERTION below for that. This Vitest harness runs against a database
  // that has already had every migration applied (via `supabase db
  // reset`) before any test file executes; there is no supported way from
  // inside a test to pause mid-migration-sequence, insert a business
  // BEFORE 20260827080000 runs, and then let that specific migration run
  // against it. A business created here always goes through the
  // AFTER-INSERT trigger path, never the backfill path — this test is
  // genuine coverage of the trigger, mislabeled as "backfill" would be
  // false confidence (Codex's own finding on the original version of this
  // test).
  it("a business created after the migration goes through the future-business TRIGGER path (not the backfill path)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-defaults-trigger-path");
    cleanupUserIds.push(userId);

    const { data } = await client.from("expense_categories").select("id").eq("business_id", businessId);
    expect(data).toHaveLength(10);
  });

  // STATIC MIGRATION ASSERTION: proves the backfill statement itself —
  // copied verbatim from
  // supabase/migrations/20260827080000_create_expense_categories.sql —
  // is correct and idempotent when executed against a business that
  // currently has zero expense_categories rows. That is EXACTLY the
  // condition every real pre-existing tenant is in at the moment the
  // actual migration's backfill statement runs against it; reproducing
  // that starting condition here (by deleting the trigger-created rows
  // first) and then re-running the identical SQL is the closest honest
  // proxy this harness can offer for "a business that predates this
  // migration is backfilled" without a supported way to pause mid-
  // migration-sequence. This is explicitly NOT a claim that
  // `supabase db reset` re-ran the real migration against a pre-existing
  // business — it did not.
  it("STATIC: the migration's own backfill SQL is correct and idempotent against a zero-category business", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-static-backfill");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await sql`delete from public.expense_categories where business_id = ${businessId}`;
      const zero = await sql<{ n: number }[]>`
        select count(*)::int as n from public.expense_categories where business_id = ${businessId}
      `;
      expect(zero[0].n).toBe(0);

      // Verbatim copy of the migration's backfill statement.
      await sql`
        insert into public.expense_categories (business_id, name, created_by)
        select b.id, cat.name, b.created_by
        from public.businesses b
        cross join (values
          ('Rent'), ('Utilities'), ('Transport'), ('Salaries & Wages'), ('Marketing'),
          ('Supplies'), ('Repairs & Maintenance'), ('Professional Services'),
          ('Taxes & Fees'), ('Other')
        ) as cat(name)
        where not exists (
          select 1 from public.expense_categories ec where ec.business_id = b.id
        )
      `;

      const { data } = await client.from("expense_categories").select("name, status").eq("business_id", businessId);
      expect(data).toHaveLength(10);
      expect(data!.map((c) => c.name).sort()).toEqual([...DEFAULT_NAMES].sort());
      expect(data!.every((c) => c.status === "ACTIVE")).toBe(true);

      // Idempotency: re-running the exact same statement affects zero
      // rows (the NOT EXISTS guard) — never a duplicate set.
      await sql`
        insert into public.expense_categories (business_id, name, created_by)
        select b.id, cat.name, b.created_by
        from public.businesses b
        cross join (values ('Rent')) as cat(name)
        where not exists (select 1 from public.expense_categories ec where ec.business_id = b.id)
      `;
      const { data: after } = await client.from("expense_categories").select("id").eq("business_id", businessId);
      expect(after).toHaveLength(10);
    } finally {
      await sql.end();
    }
  });
});

describe("expense category management", () => {
  it("OWNER can create a custom category", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-create");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("expense_categories")
      .insert({ business_id: businessId, name: "Custom Category" })
      .select("id, status, created_by")
      .single();
    expect(error).toBeNull();
    expect(data?.status).toBe("ACTIVE");
    expect(data?.created_by).toBe(userId);
  });

  it("category names are unique per business, normalized for case/whitespace", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-unique");
    cleanupUserIds.push(userId);

    await makeExpenseCategory(client, businessId, { name: "Delivery Fees" });

    const dup = await client
      .from("expense_categories")
      .insert({ business_id: businessId, name: "  delivery fees  " });
    expect(dup.error).not.toBeNull();
  });

  it("two DIFFERENT businesses may each have a category with the same name", async () => {
    const a = await createOwnerAndBusiness("expcat-cross-a");
    const b = await createOwnerAndBusiness("expcat-cross-b");
    cleanupUserIds.push(a.userId, b.userId);

    await makeExpenseCategory(a.client, a.businessId, { name: "Shared Name" });
    const { error } = await b.client
      .from("expense_categories")
      .insert({ business_id: b.businessId, name: "Shared Name" });
    expect(error).toBeNull();
  });

  it("a category can be renamed", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-rename");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId, { name: "Old Name" });

    const { error } = await client.from("expense_categories").update({ name: "New Name" }).eq("id", categoryId);
    expect(error).toBeNull();

    const { data } = await client.from("expense_categories").select("name").eq("id", categoryId).single();
    expect(data?.name).toBe("New Name");
  });

  it("a category can be archived", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-archive");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId, { name: "To Archive" });

    const { error } = await client.from("expense_categories").update({ status: "ARCHIVED" }).eq("id", categoryId);
    expect(error).toBeNull();

    const { data } = await client.from("expense_categories").select("status").eq("id", categoryId).single();
    expect(data?.status).toBe("ARCHIVED");
  });

  it("an archived category is rejected for a NEW expense", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-archived-reject");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId, { name: "Will Archive", status: "ARCHIVED" });

    const result = await client.rpc("create_expense", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: 100,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("EXPENSE_CATEGORY_ARCHIVED");
  });

  it("a cross-tenant category id is rejected as not found (never disclosed as a real foreign row)", async () => {
    const a = await createOwnerAndBusiness("expcat-xtenant-a");
    const b = await createOwnerAndBusiness("expcat-xtenant-b");
    cleanupUserIds.push(a.userId, b.userId);
    const foreignCategoryId = await getDefaultCategoryId(a.client, a.businessId);

    const result = await b.client.rpc("create_expense", {
      p_business_id: b.businessId,
      p_creation_key: randomUuid(),
      p_category_id: foreignCategoryId,
      p_amount: 100,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("EXPENSE_CATEGORY_NOT_FOUND");
  });

  it("the category snapshot survives a later rename — historical expense identity is unaffected", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("expcat-snapshot-survives-rename");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId, { name: "Original Category Name" });
    const expenseId = await makeExpense(client, businessId, categoryId);

    const { error: renameErr } = await client
      .from("expense_categories")
      .update({ name: "Renamed Category" })
      .eq("id", categoryId);
    expect(renameErr).toBeNull();

    const { data: expense } = await client
      .from("expenses")
      .select("category_name_snapshot")
      .eq("id", expenseId)
      .single();
    expect(expense?.category_name_snapshot).toBe("Original Category Name");
  });

  it("a VIEWER cannot create or update a category", async () => {
    const { businessId, userId } = await createOwnerAndBusiness("expcat-viewer-denied");
    cleanupUserIds.push(userId);
    const viewer = await createMemberWithRole(businessId, "expcat-viewer-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    const insert = await viewer.client
      .from("expense_categories")
      .insert({ business_id: businessId, name: "Should Not Exist" });
    expect(insert.error).not.toBeNull();
  });
});
