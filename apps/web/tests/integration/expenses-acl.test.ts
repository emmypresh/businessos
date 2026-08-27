import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser, createAdminClient } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, makeExpenseCategory, makeExpense } from "./helpers/expenses";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  assertLocalSupabaseUrl(url);
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

describe("Phase 1E effective table/function ACLs", () => {
  it("anon has no useful SELECT and no INSERT on expense_categories/expenses", async () => {
    const anon = createAnonClient();
    for (const table of ["expense_categories", "expenses"] as const) {
      const select = await anon.from(table).select("id").limit(1);
      expect(select.data ?? []).toHaveLength(0);
      const insert = await anon.from(table).insert({} as never);
      expect(insert.error).not.toBeNull();
    }
  });

  it("authenticated CAN insert/update expense_categories (plain RLS-governed metadata edit)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-expcat-writable");
    cleanupUserIds.push(userId);

    const insert = await client.from("expense_categories").insert({ business_id: businessId, name: "ACL Test Category" });
    expect(insert.error).toBeNull();

    const categoryId = await makeExpenseCategory(client, businessId, { name: "Editable" });
    const update = await client.from("expense_categories").update({ name: "Edited" }).eq("id", categoryId);
    expect(update.error).toBeNull();
  });

  it("authenticated cannot DELETE expense_categories", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-expcat-no-delete");
    cleanupUserIds.push(userId);
    const categoryId = await makeExpenseCategory(client, businessId);

    const del = await client.from("expense_categories").delete().eq("id", categoryId);
    expect(del.error).not.toBeNull();

    const { data } = await client.from("expense_categories").select("id").eq("id", categoryId);
    expect(data).toHaveLength(1);
  });

  it("authenticated cannot directly INSERT/UPDATE/DELETE into expenses (RPC-only boundary)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-expenses-writes");
    cleanupUserIds.push(userId);
    const categoryId = await getDefaultCategoryId(client, businessId);

    const insert = await client.from("expenses").insert({
      business_id: businessId, category_id: categoryId, expense_number: "EXP-999999",
      creation_key: randomUuid(),
    } as never);
    expect(insert.error).not.toBeNull();

    const expenseId = await makeExpense(client, businessId, categoryId);
    const update = await client.from("expenses").update({ amount: 1 } as never).eq("id", expenseId);
    expect(update.error).not.toBeNull();
    const del = await client.from("expenses").delete().eq("id", expenseId);
    expect(del.error).not.toBeNull();
  });

  it("service_role cannot directly write to expenses/expense_categories via the real Data API", async () => {
    const admin = createAdminClient();
    const { businessId, userId } = await createOwnerAndBusiness("acl-service-role-writes");
    cleanupUserIds.push(userId);

    const catInsert = await admin.from("expense_categories").insert({ business_id: businessId, name: "SR" } as never);
    expect(catInsert.error).not.toBeNull();
    const expInsert = await admin.from("expenses").insert({
      business_id: businessId, expense_number: "EXP-000000", creation_key: randomUuid(),
    } as never);
    expect(expInsert.error).not.toBeNull();
  });

  it("cross-tenant: business B cannot see business A's categories or expenses via any RLS path", async () => {
    const a = await createOwnerAndBusiness("acl-cross-tenant-a");
    const b = await createOwnerAndBusiness("acl-cross-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    const categoryId = await getDefaultCategoryId(a.client, a.businessId);
    const expenseId = await makeExpense(a.client, a.businessId, categoryId);

    const bCategories = await b.client.from("expense_categories").select("id").eq("id", categoryId);
    expect(bCategories.data ?? []).toHaveLength(0);
    const bExpenses = await b.client.from("expenses").select("id").eq("id", expenseId);
    expect(bExpenses.data ?? []).toHaveLength(0);
  });

  it("private.business_expense_sequences and private.expense_creation_requests are inaccessible through the Data API", async () => {
    const anon = createAnonClient();
    const admin = createAdminClient();
    // `private` is not in config.toml's api.schemas at all, so PostgREST
    // has no route for it regardless of GRANTs — any attempt errors, for
    // every role, identically to requesting a nonexistent table.
    const anonAttempt = await anon.schema("private" as never).from("expense_creation_requests").select("*").limit(1);
    expect(anonAttempt.error).not.toBeNull();
    const adminAttempt = await admin.schema("private" as never).from("business_expense_sequences").select("*").limit(1);
    expect(adminAttempt.error).not.toBeNull();
  });

  it("effective ACLs inspected directly from Postgres match the intended matrix", async () => {
    const sql = createTestDbClient();
    try {
      const tableGrants = await sql<{ grantee: string; table_name: string }[]>`
        select grantee, table_name
        from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = any(${["expense_categories", "expenses"] as unknown as string[]})
          and grantee in ('anon', 'authenticated', 'service_role')
      `;
      expect(tableGrants.filter((g) => g.grantee === "anon")).toHaveLength(0);
      // expenses has ONLY column-restricted SELECT grants (no whole-table
      // row present here at all for authenticated/service_role).
      expect(tableGrants.filter((g) => g.table_name === "expenses" && g.grantee !== "anon")).toHaveLength(0);

      const columnGrants = await sql<
        { grantee: string; table_name: string; column_name: string; privilege_type: string }[]
      >`
        select grantee, table_name, column_name, privilege_type
        from information_schema.column_privileges
        where table_schema = 'public'
          and table_name in ('expenses', 'expense_categories')
          and grantee in ('authenticated', 'service_role')
      `;

      // authenticated/service_role: no write grant of any kind on expenses.
      const expenseWriteGrants = columnGrants.filter(
        (g) => g.table_name === "expenses" && ["INSERT", "UPDATE", "DELETE"].includes(g.privilege_type)
      );
      expect(expenseWriteGrants).toHaveLength(0);
      // creation_key excluded from SELECT entirely.
      expect(columnGrants.some((g) => g.table_name === "expenses" && g.column_name === "creation_key")).toBe(false);

      // expense_categories: authenticated has INSERT restricted to exactly
      // (business_id, name) — never created_by/status/id.
      const catInsertCols = columnGrants
        .filter((g) => g.table_name === "expense_categories" && g.grantee === "authenticated" && g.privilege_type === "INSERT")
        .map((g) => g.column_name)
        .sort();
      expect(catInsertCols).toEqual(["business_id", "name"]);

      // expense_categories: authenticated has UPDATE restricted to exactly
      // (name, status).
      const catUpdateCols = columnGrants
        .filter((g) => g.table_name === "expense_categories" && g.grantee === "authenticated" && g.privilege_type === "UPDATE")
        .map((g) => g.column_name)
        .sort();
      expect(catUpdateCols).toEqual(["name", "status"]);

      // No DELETE grant on expense_categories for authenticated at all.
      expect(
        tableGrants.some((g) => g.table_name === "expense_categories" && g.grantee === "authenticated")
      ).toBe(false); // whole-table DELETE would show up here; column grants above cover INSERT/UPDATE/SELECT
    } finally {
      await sql.end();
    }
  });

  it("SECURITY DEFINER functions have PUBLIC/anon/service_role execution revoked, authenticated granted", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proname: string; proacl: string[] | null }[]>`
        select p.proname, p.proacl::text[]
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('create_expense', 'void_expense', 'get_financial_summary')
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const entries = row.proacl ?? [];
        const publicGrants = entries.filter((e) => e.startsWith("="));
        expect(publicGrants, row.proname).toHaveLength(0);
        expect(entries.some((e) => e.startsWith("anon=")), `${row.proname} anon`).toBe(false);
        expect(entries.some((e) => e.startsWith("service_role=")), `${row.proname} service_role`).toBe(false);
        expect(entries.some((e) => e.startsWith("authenticated=X")), `${row.proname} authenticated`).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });

  it("private_expense_writer / private_expense_voider / private_reports_reader are NOLOGIN/NOINHERIT/BYPASSRLS with narrowed grants", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolname, rolcanlogin, rolinherit, rolbypassrls
        from pg_roles
        where rolname in ('private_expense_writer', 'private_expense_voider', 'private_reports_reader')
        order by rolname
      `;
      expect(roles).toHaveLength(3);
      for (const r of roles) {
        expect(r.rolcanlogin, r.rolname).toBe(false);
        expect(r.rolinherit, r.rolname).toBe(false);
        expect(r.rolbypassrls, r.rolname).toBe(true);
      }

      // private_expense_writer has NO update grant on public.expenses at
      // all — it only ever INSERTs; void_expense's role is the only one
      // with UPDATE there.
      const writerExpenseUpdates = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'expenses'
          and grantee = 'private_expense_writer' and privilege_type = 'UPDATE'
      `;
      expect(writerExpenseUpdates).toHaveLength(0);

      // private_expense_voider's UPDATE on expenses is scoped to EXACTLY
      // the four void-state columns — never amount/category/date/etc.
      const voiderUpdates = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'expenses'
          and grantee = 'private_expense_voider' and privilege_type = 'UPDATE'
        order by column_name
      `;
      expect(voiderUpdates.map((r) => r.column_name).sort()).toEqual(
        ["status", "void_reason", "voided_at", "voided_by"].sort()
      );

      // private_reports_reader has SELECT only, never a write grant, on
      // both sales and expenses.
      const readerWrites = await sql<{ table_name: string; privilege_type: string }[]>`
        select table_name, privilege_type from information_schema.column_privileges
        where table_schema = 'public' and table_name in ('sales', 'expenses')
          and grantee = 'private_reports_reader' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      `;
      expect(readerWrites).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("whole-business deletion cascades expense_categories/expenses/request-ledger/sequences cleanly, no FK violation", async () => {
    const admin = createAdminClient();
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-whole-business-delete");
    cleanupUserIds.push(userId);

    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);
    await client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "pre-delete void" });

    const { error: deleteErr } = await admin.from("businesses").delete().eq("id", businessId);
    expect(deleteErr).toBeNull();

    const sql = createTestDbClient();
    try {
      const remaining = await sql<{ n: string }[]>`
        select
          (select count(*) from public.expense_categories where business_id = ${businessId})
          + (select count(*) from public.expenses where business_id = ${businessId})
          + (select count(*) from private.expense_creation_requests where business_id = ${businessId})
          + (select count(*) from private.business_expense_sequences where business_id = ${businessId})
          as n
      `;
      expect(Number(remaining[0].n)).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
