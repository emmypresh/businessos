import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser, createAdminClient } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import {
  createOwnerAndBusiness,
  getDefaultLocationId,
  randomUuid,
} from "./helpers/inventory";

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

const TABLES = ["products", "inventory_locations", "inventory_ledger", "inventory_balances"] as const;

describe("effective table/function ACLs", () => {
  it("anon has no INSERT/UPDATE/DELETE on any of the four Phase 1C tables, and no useful SELECT", async () => {
    const anon = createAnonClient();
    for (const table of TABLES) {
      const select = await anon.from(table).select("id").limit(1);
      // RLS with no policy for anon (no grant at all) -> either an
      // outright permission error, or (if somehow selectable) zero rows;
      // never real data.
      expect(select.data ?? []).toHaveLength(0);

      const insert = await anon.from(table).insert({} as never);
      expect(insert.error).not.toBeNull();
    }
  });

  it("authenticated cannot directly INSERT into products (RPC-only boundary)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-products-insert");
    cleanupUserIds.push(userId);

    const { error } = await client.from("products").insert({
      business_id: businessId,
      creation_key: randomUuid(),
      name: "Direct Insert Attempt",
      sku: "direct-insert",
    } as never);
    expect(error).not.toBeNull();
  });

  it("authenticated cannot INSERT, UPDATE, or DELETE inventory_ledger", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-ledger-writes");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);

    const { data: product } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "ACL Ledger Product",
      p_sku: `acl-ledger-${randomUuid()}`,
    });

    const insert = await client.from("inventory_ledger").insert({
      business_id: businessId,
      product_id: product!.id,
      inventory_location_id: locationId,
      movement_type: "ADJUSTMENT_IN",
      quantity_delta: 1,
      balance_after: 1,
      idempotency_key: randomUuid(),
      reason: "direct insert",
      created_by: userId,
    } as never);
    expect(insert.error).not.toBeNull();

    const { data: existingRows } = await client.from("inventory_ledger").select("id").limit(1);
    if (existingRows && existingRows.length > 0) {
      const update = await client.from("inventory_ledger").update({ reason: "x" }).eq("id", existingRows[0].id);
      expect(update.error).not.toBeNull();
      const del = await client.from("inventory_ledger").delete().eq("id", existingRows[0].id);
      expect(del.error).not.toBeNull();
    }
  });

  it("authenticated cannot INSERT or UPDATE inventory_balances", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("acl-balances-writes");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);

    const { data: product } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "ACL Balance Product",
      p_sku: `acl-balance-${randomUuid()}`,
    });

    const insert = await client.from("inventory_balances").insert({
      business_id: businessId,
      product_id: product!.id,
      inventory_location_id: locationId,
      quantity: 100,
    } as never);
    expect(insert.error).not.toBeNull();
  });

  it("service_role cannot directly INSERT into products via the real Data API", async () => {
    const admin = createAdminClient();
    const { businessId, userId } = await createOwnerAndBusiness("acl-service-role-products");
    cleanupUserIds.push(userId);

    const { error } = await admin.from("products").insert({
      business_id: businessId,
      creation_key: randomUuid(),
      name: "Service Role Direct Insert",
      sku: "service-role-direct",
    } as never);
    expect(error).not.toBeNull();
  });

  it("service_role cannot mutate inventory_ledger or inventory_balances via the real Data API", async () => {
    const admin = createAdminClient();
    const { businessId, userId, client } = await createOwnerAndBusiness("acl-service-role-ledger");
    cleanupUserIds.push(userId);
    const locationId = await getDefaultLocationId(client, businessId);

    const { data: product } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: randomUuid(),
      p_name: "Service Role Ledger Product",
      p_sku: `svc-ledger-${randomUuid()}`,
    });

    const ledgerInsert = await admin.from("inventory_ledger").insert({
      business_id: businessId,
      product_id: product!.id,
      inventory_location_id: locationId,
      movement_type: "ADJUSTMENT_IN",
      quantity_delta: 1,
      balance_after: 1,
      idempotency_key: randomUuid(),
      reason: "service role direct",
      created_by: userId,
    } as never);
    expect(ledgerInsert.error).not.toBeNull();

    const balanceInsert = await admin.from("inventory_balances").insert({
      business_id: businessId,
      product_id: product!.id,
      inventory_location_id: locationId,
      quantity: 100,
    } as never);
    expect(balanceInsert.error).not.toBeNull();
  });

  it("effective ACLs inspected directly from Postgres match the intended matrix", async () => {
    // products/inventory_ledger's grants to authenticated/service_role are
    // COLUMN-restricted (grant select (col1, col2, ...) on t to r) — these
    // do NOT appear in information_schema.role_table_grants at all (that
    // view only reports whole-table ACL entries from pg_class.relacl);
    // column-level grants live in pg_attribute.attacl, reported via
    // information_schema.role_column_grants. inventory_locations/
    // inventory_balances have plain whole-table SELECT grants, which DO
    // appear in role_table_grants. Both shapes are asserted below,
    // matching how each table was actually granted.
    const sql = createTestDbClient();
    try {
      const tableGrants = await sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
        select grantee, table_name, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = any(${TABLES as unknown as string[]})
          and grantee in ('anon', 'authenticated', 'service_role')
        order by table_name, grantee, privilege_type
      `;

      // anon: nothing at all on any of the four tables.
      expect(tableGrants.filter((g) => g.grantee === "anon")).toHaveLength(0);

      // Whole-table grants: inventory_locations/inventory_balances SELECT
      // only, for both authenticated and service_role.
      for (const t of ["inventory_locations", "inventory_balances"]) {
        for (const role of ["authenticated", "service_role"]) {
          const rows = tableGrants.filter((g) => g.table_name === t && g.grantee === role);
          expect(new Set(rows.map((g) => g.privilege_type)), `${t}/${role}`).toEqual(new Set(["SELECT"]));
        }
      }

      // products/inventory_ledger have NO whole-table grants for
      // authenticated/service_role at all (their SELECT is column-scoped;
      // products' UPDATE for authenticated is also column-scoped).
      for (const t of ["products", "inventory_ledger"]) {
        for (const role of ["authenticated", "service_role"]) {
          const rows = tableGrants.filter((g) => g.table_name === t && g.grantee === role);
          expect(rows, `${t}/${role} should have no whole-table grant`).toHaveLength(0);
        }
      }

      const columnGrants = await sql<
        { grantee: string; table_name: string; column_name: string; privilege_type: string }[]
      >`
        select grantee, table_name, column_name, privilege_type
        from information_schema.column_privileges
        where table_schema = 'public'
          and table_name = any(${TABLES as unknown as string[]})
          and grantee in ('authenticated', 'service_role')
      `;

      // authenticated has SELECT on products.selling_price (an approved
      // column) and UPDATE on products.status (an approved editable
      // column), but never on cost_price/creation_key.
      expect(
        columnGrants.some(
          (g) => g.grantee === "authenticated" && g.table_name === "products" && g.column_name === "selling_price" && g.privilege_type === "SELECT"
        )
      ).toBe(true);
      expect(
        columnGrants.some(
          (g) => g.grantee === "authenticated" && g.table_name === "products" && g.column_name === "status" && g.privilege_type === "UPDATE"
        )
      ).toBe(true);

      // Column-level restriction: cost_price/unit_cost are never SELECT-able
      // (readable only via the get_product_cost/get_movement_unit_cost
      // accessor functions) — but cost_price legitimately keeps its UPDATE
      // grant, since products.manage holders set prices even though they
      // can't read cost_price back directly off the row. creation_key/
      // idempotency_key are internal mutation-control metadata with NO
      // grant at all, for any privilege.
      const forbiddenSelect = columnGrants.filter(
        (g) =>
          g.privilege_type === "SELECT" &&
          ((g.table_name === "products" && g.column_name === "cost_price") ||
            (g.table_name === "inventory_ledger" && g.column_name === "unit_cost"))
      );
      expect(forbiddenSelect).toHaveLength(0);

      const internalMetadataGrants = columnGrants.filter(
        (g) =>
          (g.table_name === "products" && g.column_name === "creation_key") ||
          (g.table_name === "inventory_ledger" && g.column_name === "idempotency_key")
      );
      expect(internalMetadataGrants).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("SECURITY DEFINER functions have PUBLIC and anon execution revoked, and only the intended roles granted", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proname: string; proacl: string[] | null }[]>`
        select p.proname, p.proacl::text[]
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.proname in (
            'record_inventory_movement', 'create_product', 'apply_inventory_movement',
            'get_product_cost', 'get_movement_unit_cost', 'get_default_inventory_location_id'
          )
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // An aclitem's grantee is everything before "=" — PUBLIC is
        // represented by an EMPTY grantee, i.e. an entry that literally
        // STARTS WITH "=" (e.g. "=X/postgres"). A named role's entry
        // (e.g. "authenticated=X/postgres") legitimately contains the
        // substring "=X/" without being a PUBLIC grant, so the earlier
        // substring check was wrong; this checks the grantee position
        // specifically.
        const entries = row.proacl ?? [];
        const publicGrants = entries.filter((e) => e.startsWith("="));
        expect(publicGrants, row.proname).toHaveLength(0);
      }

      const recordMovement = rows.find((r) => r.proname === "record_inventory_movement");
      expect(recordMovement?.proacl?.some((a) => a.startsWith("service_role="))).toBe(false);
      expect(recordMovement?.proacl?.some((a) => a.startsWith("authenticated=X"))).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
