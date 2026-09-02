import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser, createAdminClient } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";

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

const TABLES = ["customers", "sales", "sale_items"] as const;

describe("Phase 1D effective table/function ACLs", () => {
  it("anon has no INSERT/UPDATE/DELETE on customers/sales/sale_items, and no useful SELECT", async () => {
    const anon = createAnonClient();
    for (const table of TABLES) {
      const select = await anon.from(table).select("id").limit(1);
      expect(select.data ?? []).toHaveLength(0);
      const insert = await anon.from(table).insert({} as never);
      expect(insert.error).not.toBeNull();
    }
  });

  it("authenticated cannot directly INSERT/UPDATE/DELETE into sales or sale_items (RPC-only boundary)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-sales-writes");
    cleanupUserIds.push(userId);

    const insertSale = await client.from("sales").insert({
      business_id: businessId, sale_number: "SALE-999999", creation_key: randomUuid(),
    } as never);
    expect(insertSale.error).not.toBeNull();

    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });
    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });

    const updateSale = await client.from("sales").update({ total: 0 } as never).eq("id", sale.data!);
    expect(updateSale.error).not.toBeNull();
    const deleteSale = await client.from("sales").delete().eq("id", sale.data!);
    expect(deleteSale.error).not.toBeNull();

    const insertItem = await client.from("sale_items").insert({
      business_id: businessId, sale_id: sale.data!, product_id: product.id,
      product_name_snapshot: "x", unit_price: 1, quantity: 1, line_total: 1,
    } as never);
    expect(insertItem.error).not.toBeNull();
  });

  it("authenticated cannot directly INSERT into customers (RPC-only boundary)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-customers-insert");
    cleanupUserIds.push(userId);
    const insert = await client.from("customers").insert({
      business_id: businessId, name: "Direct Insert Attempt",
    } as never);
    expect(insert.error).not.toBeNull();
  });

  it("authenticated CAN update customers metadata (plain RLS-governed edit, no bundled side effect)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-customers-update");
    cleanupUserIds.push(userId);
    const customerId = await makeCustomer(client, businessId, { name: "Editable" });
    const { error } = await client.from("customers").update({ name: "Edited" }).eq("id", customerId);
    expect(error).toBeNull();
  });

  it("service_role cannot directly write to customers/sales/sale_items via the real Data API", async () => {
    const admin = createAdminClient();
    const { businessId, userId } = await createOwnerAndBusiness("acl-service-role-writes");
    cleanupUserIds.push(userId);

    const custInsert = await admin.from("customers").insert({ business_id: businessId, name: "SR" } as never);
    expect(custInsert.error).not.toBeNull();
    const saleInsert = await admin.from("sales").insert({
      business_id: businessId, sale_number: "SALE-000000", creation_key: randomUuid(),
    } as never);
    expect(saleInsert.error).not.toBeNull();
  });

  it("cross-tenant: business B cannot see business A's customers or sales via any RLS path", async () => {
    const a = await createOwnerAndBusiness("acl-cross-tenant-a");
    const b = await createOwnerAndBusiness("acl-cross-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    const customerId = await makeCustomer(a.client, a.businessId);
    const product = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 5 });
    const sale = await a.client.rpc("create_sale", {
      p_business_id: a.businessId, p_creation_key: randomUuid(), p_items: [saleItem(product.id, 1)],
    });
    expect(sale.error).toBeNull();

    const bCustomers = await b.client.from("customers").select("id").eq("id", customerId);
    expect(bCustomers.data ?? []).toHaveLength(0);
    const bSales = await b.client.from("sales").select("id").eq("id", sale.data!);
    expect(bSales.data ?? []).toHaveLength(0);
    const bItems = await b.client.from("sale_items").select("id").eq("sale_id", sale.data!);
    expect(bItems.data ?? []).toHaveLength(0);
  });

  it("effective ACLs inspected directly from Postgres match the intended matrix", async () => {
    const sql = createTestDbClient();
    try {
      const tableGrants = await sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
        select grantee, table_name, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = any(${["customers", "sales", "sale_items"] as unknown as string[]})
          and grantee in ('anon', 'authenticated', 'service_role')
        order by table_name, grantee, privilege_type
      `;

      expect(tableGrants.filter((g) => g.grantee === "anon")).toHaveLength(0);

      // customers/sales/sale_items ALL have COLUMN-restricted grants only
      // (select (col1, col2, ...) / update (col1, ...)) — these do NOT
      // appear in information_schema.role_table_grants at all (that view
      // only reports whole-table ACL entries from pg_class.relacl),
      // exactly matching products/inventory_ledger's own treatment in
      // Phase 1C (see inventory-acl.test.ts). Asserted as zero
      // whole-table rows here; the real column-level grants are verified
      // via information_schema.column_privileges below instead.
      for (const role of ["authenticated", "service_role"]) {
        for (const table of ["customers", "sales", "sale_items"]) {
          const rows = tableGrants.filter((g) => g.table_name === table && g.grantee === role);
          expect(rows, `${table}/${role} should have no whole-table grant`).toHaveLength(0);
        }
      }

      const columnGrants = await sql<
        { grantee: string; table_name: string; column_name: string; privilege_type: string }[]
      >`
        select grantee, table_name, column_name, privilege_type
        from information_schema.column_privileges
        where table_schema = 'public'
          and table_name in ('sales', 'sale_items')
          and grantee in ('authenticated', 'service_role')
      `;

      // authenticated/service_role have SELECT on approved sales/sale_items
      // columns and NO INSERT/UPDATE/DELETE at all on either (creation and
      // finalization are RPC-only, running as private_sale_writer).
      for (const role of ["authenticated", "service_role"]) {
        const writeGrants = columnGrants.filter(
          (g) => g.grantee === role && ["INSERT", "UPDATE", "DELETE"].includes(g.privilege_type)
        );
        expect(writeGrants, `${role} should have no write grant on sales/sale_items`).toHaveLength(0);
        expect(
          columnGrants.some(
            (g) => g.grantee === role && g.table_name === "sales" && g.column_name === "total" && g.privilege_type === "SELECT"
          ),
          `${role} SELECT on sales.total`
        ).toBe(true);
      }

      const costGrants = columnGrants.filter((g) => g.column_name === "unit_cost_snapshot");
      expect(costGrants).toHaveLength(0);

      // private_sale_writer's grant on public.sales is column-restricted
      // to exactly the finalize-step columns for UPDATE — never a
      // whole-table UPDATE.
      const saleWriterGrants = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'sales'
          and grantee = 'private_sale_writer' and privilege_type = 'UPDATE'
        order by column_name
      `;
      expect(saleWriterGrants.map((r) => r.column_name).sort()).toEqual(
        ["amount_paid", "completed_at", "discount", "notes", "payment_method", "payment_status", "status", "subtotal", "total"].sort()
      );

      // private_sale_writer's UPDATE on products is scoped to exactly
      // creation_key (the FOR SHARE lock-privilege technique) — never id,
      // never a whole-table grant.
      const productLockGrant = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'products'
          and grantee = 'private_sale_writer' and privilege_type = 'UPDATE'
      `;
      expect(productLockGrant.map((r) => r.column_name)).toEqual(["creation_key"]);

      // private_customer_creator's / private_sale_writer's UPDATE on
      // their own request-ledger tables is scoped to exactly one column.
      const custReqGrant = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'private' and table_name = 'customer_creation_requests'
          and grantee = 'private_customer_creator' and privilege_type = 'UPDATE'
      `;
      expect(custReqGrant.map((r) => r.column_name)).toEqual(["customer_id"]);

      const saleReqGrant = await sql<{ column_name: string }[]>`
        select column_name from information_schema.column_privileges
        where table_schema = 'private' and table_name = 'sale_creation_requests'
          and grantee = 'private_sale_writer' and privilege_type = 'UPDATE'
      `;
      expect(saleReqGrant.map((r) => r.column_name)).toEqual(["sale_id"]);
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
          and p.proname in ('create_customer', 'create_sale')
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const entries = row.proacl ?? [];
        const publicGrants = entries.filter((e) => e.startsWith("="));
        expect(publicGrants, row.proname).toHaveLength(0);
        expect(entries.some((e) => e.startsWith("anon=")), `${row.proname} anon`).toBe(false);
        expect(entries.some((e) => e.startsWith("service_role=")), `${row.proname} service_role`).toBe(false);
        expect(entries.some((e) => e.startsWith("authenticated=X")), `${row.proname} authenticated`).toBe(true);
      }

      // Private helper functions never have PUBLIC or anon grants either.
      const privateRows = await sql<{ proname: string; proacl: string[] | null }[]>`
        select p.proname, p.proacl::text[]
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname in ('apply_inventory_movement', 'enforce_customer_immutable_fields')
      `;
      for (const row of privateRows) {
        const entries = row.proacl ?? [];
        expect(entries.some((e) => e.startsWith("=")), row.proname).toBe(false);
        expect(entries.some((e) => e.startsWith("anon=")), row.proname).toBe(false);
      }
    } finally {
      await sql.end();
    }
  });

  it("whole-business deletion cascades customers/sales/sale_items cleanly, no FK violation", async () => {
    const admin = createAdminClient();
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-whole-business-delete");
    cleanupUserIds.push(userId);

    const customerId = await makeCustomer(client, businessId);
    const product = await makeSaleProduct(client, businessId, { openingQuantity: 5 });
    const sale = await client.rpc("create_sale", {
      p_business_id: businessId, p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)], p_customer_id: customerId,
    });
    expect(sale.error).toBeNull();

    // Phase 1J, SEC-01J: audit_events.business_id is deliberately
    // `on delete restrict` (never cascade) — a business with any audit
    // history (which create_sale/create_customer above now generate) can
    // no longer be hard-deleted at all, by design (see
    // 20260902090000_create_audit_events.sql's own header comment). This
    // test's own purpose is proving customers/sales/sale_items cascade
    // cleanly — an orthogonal concern to audit durability — so the
    // business's own audit trail is cleared first, via a privileged
    // connection, exactly like this file's own other privileged-cleanup
    // patterns.
    const cleanupSql = createTestDbClient();
    try {
      await cleanupSql`delete from public.audit_events where business_id = ${businessId}`;
    } finally {
      await cleanupSql.end();
    }

    const { error: deleteErr } = await admin.from("businesses").delete().eq("id", businessId);
    expect(deleteErr).toBeNull();

    const sql = createTestDbClient();
    try {
      const remaining = await sql<{ n: string }[]>`
        select
          (select count(*) from public.customers where business_id = ${businessId})
          + (select count(*) from public.sales where business_id = ${businessId})
          + (select count(*) from public.sale_items where business_id = ${businessId})
          as n
      `;
      expect(Number(remaining[0].n)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("test N: private_customer_creator / private_sale_writer remain NOLOGIN/NOINHERIT/BYPASSRLS with exactly the narrowed SELECT grants", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolname, rolcanlogin, rolinherit, rolbypassrls
        from pg_roles
        where rolname in ('private_customer_creator', 'private_sale_writer')
        order by rolname
      `;
      expect(roles).toHaveLength(2);
      for (const r of roles) {
        expect(r.rolcanlogin, r.rolname).toBe(false);
        expect(r.rolinherit, r.rolname).toBe(false);
        expect(r.rolbypassrls, r.rolname).toBe(true);
      }

      const selectGrants = await sql<{ grantee: string; table_name: string; column_name: string }[]>`
        select grantee, table_name, column_name
        from information_schema.column_privileges
        where table_schema = 'public'
          and privilege_type = 'SELECT'
          and grantee in ('private_customer_creator', 'private_sale_writer')
        order by grantee, table_name, column_name
      `;

      const byGranteeTable = (grantee: string, table: string) =>
        selectGrants.filter((g) => g.grantee === grantee && g.table_name === table).map((g) => g.column_name).sort();

      // private_customer_creator: SELECT narrowed to exactly `id` on
      // customers — it never reads any other column back.
      expect(byGranteeTable("private_customer_creator", "customers")).toEqual(["id"]);

      // private_sale_writer: SELECT narrowed to exactly the columns the
      // function body reads, per table.
      expect(byGranteeTable("private_sale_writer", "customers")).toEqual(
        ["address", "business_id", "email", "id", "name", "phone", "status"].sort()
      );
      expect(byGranteeTable("private_sale_writer", "products")).toEqual(
        ["business_id", "cost_price", "id", "name", "selling_price", "sku", "status", "track_inventory"].sort()
      );
      expect(byGranteeTable("private_sale_writer", "sales")).toEqual(["id"]);
      // sale_items: no SELECT at all — the function only INSERTs, never
      // reads them back (no RETURNING, no subsequent SELECT).
      expect(byGranteeTable("private_sale_writer", "sale_items")).toEqual([]);

      // Public RPC EXECUTE ACLs unchanged by this hardening pass:
      // authenticated only, never PUBLIC/anon/service_role.
      const funcs = await sql<{ proname: string; proacl: string[] | null }[]>`
        select p.proname, p.proacl::text[]
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('create_customer', 'create_sale')
      `;
      for (const f of funcs) {
        const entries = f.proacl ?? [];
        expect(entries.some((e) => e.startsWith("=")), f.proname).toBe(false);
        expect(entries.some((e) => e.startsWith("anon=")), f.proname).toBe(false);
        expect(entries.some((e) => e.startsWith("service_role=")), f.proname).toBe(false);
        expect(entries.some((e) => e.startsWith("authenticated=X")), f.proname).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });
});
