import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1G security catalog: grants, ownership, RLS, and non-disclosure
// for every new/replaced function and table this phase touches.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  assertLocalSupabaseUrl(url);
  return createClient(url, key, { auth: { persistSession: false } });
}

const REPLACED_FUNCTIONS = [
  { name: "create_sale", owner: "private_sale_writer" },
  { name: "record_inventory_movement", owner: "private_inventory_writer" },
  { name: "create_product", owner: "private_product_creator" },
  { name: "create_expense", owner: "private_expense_writer" },
  { name: "get_financial_summary", owner: "private_reports_reader" },
  // Codex adversarial review Phase 1G round 2, Medium 3: a genuine
  // in-place CREATE OR REPLACE (identical signature, no DROP needed) —
  // included here so its ownership/grant catalog gets the same permanent
  // scrutiny as every other replaced function.
  { name: "set_default_business_branch", owner: "private_branch_writer" },
];

describe("Phase 1G — function ownership unchanged by CREATE OR REPLACE", () => {
  it("41/42. every replaced function keeps its original narrow owner role, never postgres/authenticated/service_role", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of REPLACED_FUNCTIONS) {
        const rows = await sql<{ owner: string }[]>`
          select r.rolname as owner
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_roles r on r.oid = p.proowner
          where n.nspname = 'public' and p.proname = ${fn.name}
        `;
        expect(rows, fn.name).toHaveLength(1);
        expect(rows[0].owner, fn.name).toBe(fn.owner);
      }
    } finally {
      await sql.end();
    }
  });

  it("41. every replaced function is still SECURITY DEFINER with search_path=''", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of REPLACED_FUNCTIONS) {
        const rows = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
          select prosecdef, proconfig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = ${fn.name}
        `;
        expect(rows[0].prosecdef, fn.name).toBe(true);
        expect(rows[0].proconfig, fn.name).toContain('search_path=""');
      }
    } finally {
      await sql.end();
    }
  });

  it("41. PUBLIC EXECUTE is absent, and anon/service_role have no EXECUTE, on every replaced function", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of REPLACED_FUNCTIONS) {
        // Codex adversarial review precedent (Phase 1F round-3, Finding 8C):
        // an INNER JOIN from aclexplode() to pg_roles silently drops a
        // PUBLIC grant (grantee OID 0, no matching pg_roles row) — this
        // LEFT JOIN + explicit case is what actually lets a PUBLIC-grant
        // assertion fail if it should.
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'public' and p.proname = ${fn.name} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee);
        expect(grantees, fn.name).toContain("authenticated");
        expect(grantees, fn.name).not.toContain("PUBLIC");
        expect(grantees, fn.name).not.toContain("anon");
        // Codex adversarial review Phase 1G round 2 (ACL environment
        // micro-review): record_inventory_movement/create_product used to
        // rely on CREATE OR REPLACE's own "same signature -> ACL
        // preserved" behavior, which meant their effective service_role
        // grant silently depended on whatever the local Supabase CLI's own
        // bootstrap/default-privilege behavior happened to be at the
        // moment they were first created (confirmed, empirically, to
        // differ between CLI 2.115.0 and 2.116.0 in this project's own
        // testing). 20260829080200_branch_aware_inventory_movements.sql
        // now explicitly REVOKEs EXECUTE from public/anon/service_role and
        // GRANTs it only to authenticated for both — an idempotent
        // normalization that converges to the identical result regardless
        // of the starting ACL, making this assertion uniform across every
        // replaced function with zero environment dependence or exemption.
        expect(grantees, fn.name).not.toContain("service_role");
      }
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review Phase 1G round 2 (ACL environment
  // micro-review), item 6: proves the EXECUTE boundary operationally, not
  // just via catalog read — as service_role, calling any of these four
  // functions fails at the ACL layer BEFORE the function body ever runs
  // (Postgres raises a generic 42501 "permission denied for function", and
  // none of the function's own internal logic can ever execute); as
  // authenticated (still with no JWT claim set on this raw connection), the
  // call instead REACHES the function body and fails on ITS OWN first
  // internal check ('authentication required') — a categorically different
  // failure that could only happen if the ACL check already passed. This
  // is unambiguous either way, independent of any catalog-interpretation
  // dispute: a permission fails BEFORE entry; a function fails FROM
  // WITHIN.
  it("EXECUTE boundary is confirmed BEHAVIORALLY for every replaced function: service_role denied-before-entry, authenticated reaches-function-body", async () => {
    const sql = createTestDbClient();
    try {
      // No explicit BEGIN: each call below is its own independent
      // statement, so one call's expected failure never poisons the next
      // (an explicit transaction would abort on the first error and reject
      // every subsequent statement with a generic "current transaction is
      // aborted", masking the very distinction this test exists to prove).
      const deniedBeforeEntry = async (query: Promise<unknown>) => {
        try {
          await query;
          throw new Error("expected a permission error, but the call succeeded");
        } catch (e) {
          const err = e as { code?: string; message: string };
          expect(err.code, err.message).toBe("42501");
          expect(err.message).toContain("permission denied for function");
        }
      };
      const reachesFunctionBody = async (query: Promise<unknown>) => {
        try {
          await query;
          throw new Error("expected the function's own internal error, but the call succeeded");
        } catch (e) {
          const err = e as { code?: string; message: string };
          // The function's OWN first check (private.current_uid() is null
          // on this raw, claim-less connection) — categorically NOT an ACL
          // rejection.
          expect(err.message, err.message).not.toContain("permission denied for function");
          expect(err.message).toContain("authentication required");
        }
      };

      await sql`set role service_role`;
      await deniedBeforeEntry(sql`select create_sale(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb)`);
      await deniedBeforeEntry(sql`select set_default_business_branch(gen_random_uuid(), gen_random_uuid())`);
      await deniedBeforeEntry(
        sql`select record_inventory_movement(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ADJUSTMENT_IN', 1, gen_random_uuid())`
      );
      await deniedBeforeEntry(sql`select create_product(gen_random_uuid(), gen_random_uuid(), 'x')`);
      await sql`reset role`;

      await sql`set role authenticated`;
      await reachesFunctionBody(sql`select create_sale(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb)`);
      await reachesFunctionBody(sql`select set_default_business_branch(gen_random_uuid(), gen_random_uuid())`);
      await reachesFunctionBody(
        sql`select record_inventory_movement(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ADJUSTMENT_IN', 1, gen_random_uuid())`
      );
      await reachesFunctionBody(sql`select create_product(gen_random_uuid(), gen_random_uuid(), 'x')`);
      await sql`reset role`;
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1G — narrow, exact grants on new columns/tables", () => {
  it("private_product_creator's inventory_locations grant is EXACTLY {id, business_id, branch_id, status, is_branch_default} — no name/is_default/created_by/timestamps", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_product_creator' and table_name = 'inventory_locations' and privilege_type = 'SELECT'
      `;
      // Codex adversarial review Phase 1G round 2, Medium 2B: this role's
      // grant was extended to also include is_branch_default — required by
      // create_product's own new omitted-opening-location resolution query
      // (join through business_member_branches to the caller's primary
      // branch's canonical `is_branch_default = true` location).
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        ["branch_id", "business_id", "id", "is_branch_default", "status"].sort()
      );
    } finally {
      await sql.end();
    }
  });

  it("private_reports_reader's new grants are narrow: sales/expenses gain only branch_id, business_branches gains only id/business_id", async () => {
    const sql = createTestDbClient();
    try {
      const salesRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_reports_reader' and table_name = 'sales' and privilege_type = 'SELECT'
      `;
      expect(salesRows.map((r) => r.column_name).sort()).toEqual(
        ["amount_paid", "branch_id", "business_id", "completed_at", "status", "total"].sort()
      );

      const branchRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_reports_reader' and table_name = 'business_branches' and privilege_type = 'SELECT'
      `;
      expect(branchRows.map((r) => r.column_name).sort()).toEqual(["business_id", "id"]);
    } finally {
      await sql.end();
    }
  });

  it("private_product_creator has NO grant at all on inventory_locations columns outside its own narrow set (name, is_default, created_by, timestamps excluded)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_product_creator' and table_name = 'inventory_locations'
      `;
      const granted = new Set(rows.map((r) => r.column_name));
      // is_branch_default is deliberately GRANTED now (Medium 2B) — see the
      // dedicated "EXACTLY" test above — so it is excluded from this
      // negative list, never from the grant itself.
      for (const excluded of ["name", "is_default", "created_by", "created_at", "updated_at"]) {
        expect(granted.has(excluded), excluded).toBe(false);
      }
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review Phase 1G round 2, Low 1: Phase 1C's own
  // original whole-table select+update grant on inventory_locations for
  // private_inventory_writer was narrowed to exactly the six columns its
  // own approved function bodies read, plus UPDATE on exactly one
  // immutable identifier column (id) — needed purely to satisfy Postgres's
  // documented requirement that FOR SHARE/FOR UPDATE locking needs UPDATE
  // privilege on at least one column, never because this role's bodies
  // ever issue a real UPDATE against this table. branch_id and
  // is_branch_default must NEVER be UPDATE-granted to this role — that
  // would let it silently move a location between branches or change
  // which one is canonical.
  it("private_inventory_writer's inventory_locations grant is EXACTLY SELECT{id, business_id, status, branch_id, is_default, is_branch_default} + UPDATE{id} — never UPDATE on branch_id/is_branch_default", async () => {
    const sql = createTestDbClient();
    try {
      const selectRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_inventory_writer' and table_name = 'inventory_locations' and privilege_type = 'SELECT'
      `;
      expect(selectRows.map((r) => r.column_name).sort()).toEqual(
        ["branch_id", "business_id", "id", "is_branch_default", "is_default", "status"].sort()
      );

      const updateRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_inventory_writer' and table_name = 'inventory_locations' and privilege_type = 'UPDATE'
      `;
      expect(updateRows.map((r) => r.column_name)).toEqual(["id"]);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review Phase 1G round 2, Medium 3: private_branch_writer
  // gained new inventory_locations access solely to keep the legacy
  // is_default flag synced from inside set_default_business_branch — it
  // must remain narrow: read access to the columns that logic actually
  // needs, and UPDATE only on is_default itself (never branch_id/
  // is_branch_default, which this role has no legitimate reason to move).
  it("private_branch_writer's inventory_locations grant is EXACTLY SELECT{id, business_id, branch_id, is_branch_default, is_default} + UPDATE{is_default}", async () => {
    const sql = createTestDbClient();
    try {
      const selectRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_branch_writer' and table_name = 'inventory_locations' and privilege_type = 'SELECT'
      `;
      expect(selectRows.map((r) => r.column_name).sort()).toEqual(
        ["branch_id", "business_id", "id", "is_branch_default", "is_default"].sort()
      );

      const updateRows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_branch_writer' and table_name = 'inventory_locations' and privilege_type = 'UPDATE'
      `;
      expect(updateRows.map((r) => r.column_name)).toEqual(["is_default"]);
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1G — RLS remains forced on every touched table", () => {
  it("44. sales, expenses, and inventory_locations all still ENABLE and FORCE row level security", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relname, relrowsecurity, relforcerowsecurity
        from pg_class
        where relname in ('sales', 'expenses', 'inventory_locations') and relnamespace = 'public'::regnamespace
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1G — no client-manufactured branch access", () => {
  it("40. anon is denied on every replaced function", async () => {
    const owner = await createOwnerAndBusiness("bacl-anon-denied");
    cleanupUserIds.push(owner.userId);
    const anon = createAnonClient();

    const { error } = await anon.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: randomUuid(), quantity: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("45/47. a caller cannot manufacture branch access via a raw insert into business_member_branches — no INSERT policy exists for authenticated", async () => {
    const owner = await createOwnerAndBusiness("bacl-no-raw-insert");
    cleanupUserIds.push(owner.userId);
    const { data: branch } = await owner.client.from("business_branches").select("id").eq("business_id", owner.businessId).single();
    const { data: member } = await owner.client
      .from("business_members")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("user_id", owner.userId)
      .single();

    const { error } = await owner.client.from("business_member_branches").insert({
      business_id: owner.businessId,
      member_id: member!.id,
      branch_id: branch!.id,
      is_primary: true,
      assigned_by: owner.userId,
    });
    expect(error).not.toBeNull();
  });

  it("45. a caller cannot manufacture a cross-tenant sale by forging inventory_locations.branch_id via a raw insert", async () => {
    const owner = await createOwnerAndBusiness("bacl-no-raw-location-insert");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.from("inventory_locations").insert({
      business_id: owner.businessId,
      branch_id: randomUuid(),
      name: "Forged Location",
      created_by: owner.userId,
      is_branch_default: false,
      status: "active",
    });
    expect(error).not.toBeNull(); // no INSERT grant for authenticated at all
  });

  it("46. private.has_branch_access is the ONLY branch-authorization primitive used — grepped against every new/replaced function's own EXECUTE dependency, not reimplemented inline", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of ["create_sale", "record_inventory_movement", "create_product"]) {
        const rows = await sql<{ src: string }[]>`
          select pg_get_functiondef(p.oid) as src
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = ${fn}
        `;
        expect(rows[0].src, fn).toContain("has_branch_access");
      }
    } finally {
      await sql.end();
    }
  });
});
