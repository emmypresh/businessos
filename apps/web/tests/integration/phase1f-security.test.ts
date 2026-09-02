import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { deleteTestUser, createAdminClient } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { createBranch, inviteMember, randomEmail } from "./helpers/staff";

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

const PHASE_1F_TABLES = [
  "business_branches",
  "business_member_branches",
  "business_invitations",
  "business_invitation_branches",
] as const;

describe("RLS enabled + FORCED on every Phase 1F table", () => {
  it.each(PHASE_1F_TABLES)("%s has both relrowsecurity and relforcerowsecurity set", async (table) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity
        from pg_class
        where relname = ${table} and relnamespace = 'public'::regnamespace
      `;
      expect(rows, table).toHaveLength(1);
      expect(rows[0].relrowsecurity, table).toBe(true);
      expect(rows[0].relforcerowsecurity, table).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it.each(["business_branch_creation_requests", "business_invitation_requests"])(
    "private.%s has both relrowsecurity and relforcerowsecurity set",
    async (table) => {
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select relrowsecurity, relforcerowsecurity
          from pg_class
          where relname = ${table} and relnamespace = 'private'::regnamespace
        `;
        expect(rows, table).toHaveLength(1);
        expect(rows[0].relrowsecurity, table).toBe(true);
        expect(rows[0].relforcerowsecurity, table).toBe(true);
      } finally {
        await sql.end();
      }
    }
  );
});

describe("anon is denied on every Phase 1F table and RPC", () => {
  it.each(PHASE_1F_TABLES)("anon has no useful SELECT and cannot INSERT on %s", async (table) => {
    const anon = createAnonClient();
    const select = await anon.from(table).select("id").limit(1);
    expect(select.data ?? []).toHaveLength(0);
    const insert = await anon.from(table).insert({} as never);
    expect(insert.error).not.toBeNull();
  });

  it("anon cannot call any Phase 1F RPC", async () => {
    const anon = createAnonClient();
    const calls = [
      anon.rpc("create_business_branch", { p_business_id: randomUuid(), p_creation_key: randomUuid(), p_name: "x" }),
      anon.rpc("change_member_role", { p_business_id: randomUuid(), p_member_id: randomUuid(), p_role: "VIEWER" }),
      anon.rpc("suspend_member", { p_business_id: randomUuid(), p_member_id: randomUuid() }),
      anon.rpc("create_business_invitation", { p_business_id: randomUuid(), p_creation_key: randomUuid(), p_email: "a@b.test", p_role: "VIEWER" }),
      anon.rpc("accept_business_invitation", { p_invitation_id: randomUuid() }),
      anon.rpc("has_branch_access", { p_business_id: randomUuid(), p_branch_id: randomUuid() }),
    ];
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r.error).not.toBeNull();
    }
  });
});

describe("RPC EXECUTE ACLs are narrow and explicit", () => {
  const RPCS = [
    "create_business_branch",
    "update_business_branch",
    "set_default_business_branch",
    "deactivate_business_branch",
    "reactivate_business_branch",
    "change_member_role",
    "suspend_member",
    "reactivate_member",
    "replace_member_branches",
    "create_business_invitation",
    "revoke_business_invitation",
    "accept_business_invitation",
    "has_branch_access",
  ];

  // Codex adversarial review, Finding 8C: the ORIGINAL query used an
  // INNER JOIN from aclexplode(p.proacl) to pg_roles on acl.grantee =
  // r.oid. A PUBLIC grant is recorded in the ACL array with grantee OID
  // 0 — a sentinel with NO matching row in pg_roles at all — so an INNER
  // JOIN silently DROPS that row before it ever reaches the SELECT list.
  // That made `expect(grantees).not.toContain("PUBLIC")` structurally
  // unable to fail: even if this RPC WERE (mis)granted to PUBLIC, the
  // query would simply never surface it, and the test would report a
  // clean pass regardless. Fixed with a LEFT JOIN plus an explicit CASE
  // that names the OID-0 sentinel row "PUBLIC" instead of letting it
  // disappear as a NULL.
  it.each(RPCS)("%s: EXECUTE is granted to authenticated, never to anon or PUBLIC", async (fn) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      expect(grantees, fn).toContain("authenticated");
      expect(grantees, fn).not.toContain("anon");
      expect(grantees, fn).not.toContain("PUBLIC");
    } finally {
      await sql.end();
    }
  });
});

describe("SECURITY DEFINER functions: search_path is locked, ownership is narrow", () => {
  const DEFINER_FUNCTIONS = [
    "create_business_branch",
    "update_business_branch",
    "set_default_business_branch",
    "deactivate_business_branch",
    "reactivate_business_branch",
    "change_member_role",
    "suspend_member",
    "reactivate_member",
    "replace_member_branches",
    "create_business_invitation",
    "revoke_business_invitation",
    "accept_business_invitation",
  ];

  it.each(DEFINER_FUNCTIONS)("%s is SECURITY DEFINER with search_path = ''", async (fn) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
        select prosecdef, proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = ${fn}
      `;
      expect(rows, fn).toHaveLength(1);
      expect(rows[0].prosecdef, fn).toBe(true);
      // Postgres serializes an empty search_path as literal `""` in
      // proconfig — `search_path=` (no quotes) is never the real stored
      // form, so asserting the exact string keeps this test unable to
      // pass on a merely-truthy-looking proconfig value.
      expect(rows[0].proconfig, fn).toContain('search_path=""');
    } finally {
      await sql.end();
    }
  });

  it("private.current_verified_email stays owned by postgres (never transferred) — the one function that reads auth.users", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ owner: string; prosecdef: boolean }[]>`
        select r.rolname as owner, p.prosecdef
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'private' and p.proname = 'current_verified_email'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].owner).toBe("postgres");
      expect(rows[0].prosecdef).toBe(true);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review, Finding 8C: same LEFT JOIN + explicit
  // grantee-0-is-PUBLIC fix as the RPC EXECUTE ACL test above — an INNER
  // JOIN here would equally have made the `not.toContain("PUBLIC")`
  // assertion below structurally unable to fail.
  it("private.current_verified_email has EXECUTE granted ONLY to its known, trusted consumer roles — never authenticated/anon/PUBLIC", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'private' and p.proname = 'current_verified_email' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      // "postgres" (the function's owner, never transferred — see the
      // previous test) is expected here too: once an object's ACL is
      // touched by any explicit GRANT/REVOKE at all, Postgres
      // materializes the owner's own implicit all-privileges grant into
      // the same ACL array — this is normal serialization, not a
      // second, unintended EXECUTE grant. The actual security property
      // this test protects is the ABSENCE of authenticated/anon/PUBLIC
      // and the PRESENCE of exactly the known, reviewed consumer roles —
      // updated for Phase 1J's own instrumentation round
      // (20260902100000_instrument_core_audit_events.sql), which added
      // ten more private writer roles as legitimate consumers (each
      // derives an actor_email_snapshot for its own audit event from this
      // same, already-audited function — never a new, separate read of
      // auth.users).
      expect(grantees).toContain("private_invitation_acceptor");
      expect(grantees).not.toContain("authenticated");
      expect(grantees).not.toContain("anon");
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees.sort()).toEqual(
        [
          "postgres",
          "private_invitation_acceptor",
          "private_branch_writer",
          "private_customer_creator",
          "private_expense_writer",
          "private_inventory_writer",
          "private_invitation_writer",
          "private_invoice_payment_writer",
          "private_invoice_writer",
          "private_product_creator",
          "private_sale_return_writer",
          "private_sale_writer",
        ].sort()
      );
    } finally {
      await sql.end();
    }
  });
});

describe("private writer roles: narrow, non-login, no privilege escalation", () => {
  const ROLES = [
    "private_branch_writer",
    "private_staff_writer",
    "private_invitation_writer",
    "private_invitation_acceptor",
  ];

  it.each(ROLES)("%s is NOLOGIN, NOINHERIT, BYPASSRLS", async (role) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = ${role}
      `;
      expect(rows, role).toHaveLength(1);
      expect(rows[0].rolcanlogin, role).toBe(false);
      expect(rows[0].rolinherit, role).toBe(false);
      expect(rows[0].rolbypassrls, role).toBe(true);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review, Finding 8D: the ORIGINAL test checked every
  // role's granted tables against ONE shared, unioned allowlist covering
  // all four roles' needs combined — so e.g. private_branch_writer being
  // mistakenly granted onto business_invitations (a table it has no
  // legitimate reason to touch at all) would pass silently, because
  // business_invitations is legitimately in private_invitation_writer's
  // own needs and the shared set couldn't tell the roles apart. Replaced
  // with an exact, independent table set PER role, asserted as full
  // equality (not just "every granted table is somewhere in some role's
  // needs") — each set transcribed directly from that role's own GRANT
  // statements in its defining migration file, so this test breaks the
  // moment any role's actual grants drift from what its own RPCs
  // document needing.
  const EXACT_TABLES_BY_ROLE: Record<string, string[]> = {
    // 20260828080300_business_branch_rpcs.sql, extended by Phase 1G's
    // 20260829080000_branch_aware_inventory_locations.sql (Codex
    // adversarial review Phase 1G round 2, Medium 3): set_default_business_branch
    // now also syncs the legacy inventory_locations.is_default flag, which
    // legitimately requires this role to read/write a narrow set of
    // inventory_locations columns too.
    private_branch_writer: ["business_branches", "business_branch_creation_requests", "inventory_locations"],
    // 20260828080500_member_management_rpcs.sql
    private_staff_writer: ["business_members", "roles", "business_branches", "business_member_branches"],
    // 20260828080700_business_invitation_rpcs.sql (create_business_invitation / revoke_business_invitation)
    private_invitation_writer: [
      "business_invitations", "business_invitation_branches", "business_branches",
      "roles", "business_members", "business_invitation_requests",
    ],
    // 20260828080700_business_invitation_rpcs.sql (accept_business_invitation)
    private_invitation_acceptor: [
      "business_invitations", "business_invitation_branches", "business_branches",
      "business_members", "business_member_branches",
    ],
  };

  it.each(ROLES)("%s holds grants on EXACTLY its own documented set of tables — no more, no less", async (role) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_name: string }[]>`
        select distinct table_name from information_schema.role_table_grants
        where grantee = ${role}
        union
        select distinct table_name from information_schema.role_column_grants
        where grantee = ${role}
      `;
      const actual = [...new Set(rows.map((r) => r.table_name))].sort();
      const expected = [...EXACT_TABLES_BY_ROLE[role]].sort();
      expect(actual, role).toEqual(expected);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review round 3, Finding C: the table-name-only test
  // above proves each role touches the RIGHT TABLES, but says nothing
  // about WHICH PRIVILEGE on WHICH COLUMN — a role could hold
  // table_name-correct but wildly overbroad grants (e.g. UPDATE on every
  // column of a table it should only be able to SELECT two columns of)
  // and this suite would still report a clean pass. This test pins the
  // EXACT (schema, table, column, privilege) tuple set per role,
  // transcribed directly from that role's own GRANT statements in its
  // defining migration file — any drift, in either direction (an
  // over-grant OR an accidentally-dropped grant a function actually
  // needs), fails this test. Deliberately FOUR INDEPENDENT expectations,
  // never a shared/unioned set — a privilege that belongs to a
  // DIFFERENT role must not silently satisfy this one.
  //
  // Column-level grants (SELECT/INSERT/UPDATE) are read from
  // information_schema.role_column_grants; DELETE is inherently
  // table-level in Postgres (a DELETE removes whole rows, never
  // individual columns, so it can never appear as a column grant) and is
  // read from information_schema.role_table_grants instead — confirmed
  // empirically that role_table_grants carries ONLY such genuinely
  // table-level entries (TRUNCATE/REFERENCES/TRIGGER/DELETE), never a
  // duplicate of a column-restricted SELECT/INSERT/UPDATE.
  type ColGrant = { schema: string; table: string; column: string; privilege: "SELECT" | "INSERT" | "UPDATE" };
  type TableGrant = { schema: string; table: string; privilege: "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER" };

  function branches(schema: string, table: string, cols: Record<string, ("SELECT" | "INSERT" | "UPDATE")[]>): ColGrant[] {
    const out: ColGrant[] = [];
    for (const [column, privileges] of Object.entries(cols)) {
      for (const privilege of privileges) out.push({ schema, table, column, privilege });
    }
    return out;
  }

  const EXACT_COLUMN_GRANTS_BY_ROLE: Record<string, ColGrant[]> = {
    // 20260828080300_business_branch_rpcs.sql
    private_branch_writer: [
      ...branches("public", "business_branches", {
        id: ["SELECT"], business_id: ["SELECT", "INSERT"], name: ["SELECT", "INSERT", "UPDATE"],
        code: ["SELECT", "INSERT", "UPDATE"], is_default: ["SELECT", "UPDATE"], status: ["SELECT", "UPDATE"],
        address_line1: ["INSERT", "UPDATE"], address_line2: ["INSERT", "UPDATE"], city: ["INSERT", "UPDATE"],
        state: ["INSERT", "UPDATE"], country_code: ["INSERT", "UPDATE"], phone: ["INSERT", "UPDATE"],
        created_by: ["INSERT"],
      }),
      ...branches("private", "business_branch_creation_requests", {
        business_id: ["SELECT", "INSERT"], creation_key: ["SELECT", "INSERT"],
        canonical_payload: ["SELECT", "INSERT"], branch_id: ["SELECT", "UPDATE"],
      }),
      // Phase 1G, 20260829080000_branch_aware_inventory_locations.sql,
      // Medium 3: exactly the columns set_default_business_branch's own
      // is_default-sync logic reads (id/business_id/branch_id/is_branch_default
      // as WHERE-clause predicates and the resolved-location lookup) plus
      // UPDATE on is_default alone — branch_id and is_branch_default are
      // deliberately SELECT-only, never UPDATE, for this role.
      ...branches("public", "inventory_locations", {
        id: ["SELECT"], business_id: ["SELECT"], branch_id: ["SELECT"],
        is_branch_default: ["SELECT"], is_default: ["SELECT", "UPDATE"],
      }),
    ],
    // 20260828080500_member_management_rpcs.sql
    private_staff_writer: [
      ...branches("public", "business_members", {
        id: ["SELECT"], business_id: ["SELECT"], user_id: ["SELECT"],
        role_id: ["SELECT", "UPDATE"], status: ["SELECT", "UPDATE"],
      }),
      ...branches("public", "roles", { id: ["SELECT"], name: ["SELECT"] }),
      ...branches("public", "business_branches", { id: ["SELECT"], business_id: ["SELECT"], status: ["SELECT"] }),
      ...branches("public", "business_member_branches", {
        id: ["SELECT"], business_id: ["SELECT", "INSERT"], member_id: ["SELECT", "INSERT"],
        branch_id: ["SELECT", "INSERT"], is_primary: ["SELECT", "INSERT", "UPDATE"], assigned_by: ["INSERT"],
      }),
    ],
    // 20260828080700_business_invitation_rpcs.sql (create_business_invitation / revoke_business_invitation)
    private_invitation_writer: [
      ...branches("public", "business_invitations", {
        id: ["SELECT"], business_id: ["SELECT", "INSERT"], email: ["SELECT", "INSERT"],
        status: ["SELECT", "UPDATE"], expires_at: ["SELECT", "INSERT"], role_id: ["SELECT", "INSERT"],
        invited_by: ["INSERT"], creation_key: ["INSERT"], revoked_by: ["UPDATE"], revoked_at: ["UPDATE"],
      }),
      ...branches("public", "business_invitation_branches", {
        id: ["SELECT"], business_id: ["INSERT"], invitation_id: ["INSERT"], branch_id: ["INSERT"], is_primary: ["INSERT"],
      }),
      ...branches("public", "business_branches", { id: ["SELECT"], business_id: ["SELECT"], status: ["SELECT"] }),
      ...branches("public", "roles", { id: ["SELECT"], name: ["SELECT"] }),
      ...branches("public", "business_members", {
        id: ["SELECT"], business_id: ["SELECT"], user_id: ["SELECT"], role_id: ["SELECT"], status: ["SELECT"],
      }),
      ...branches("private", "business_invitation_requests", {
        business_id: ["SELECT", "INSERT"], creation_key: ["SELECT", "INSERT"],
        canonical_payload: ["SELECT", "INSERT"], invitation_id: ["SELECT", "UPDATE"],
      }),
    ],
    // 20260828080700_business_invitation_rpcs.sql (accept_business_invitation)
    private_invitation_acceptor: [
      ...branches("public", "business_invitations", {
        id: ["SELECT"], business_id: ["SELECT"], email: ["SELECT"], role_id: ["SELECT"], status: ["SELECT", "UPDATE"],
        expires_at: ["SELECT"], accepted_by: ["UPDATE"], accepted_at: ["UPDATE"],
      }),
      ...branches("public", "business_invitation_branches", {
        id: ["SELECT"], invitation_id: ["SELECT"], branch_id: ["SELECT"], is_primary: ["SELECT"],
      }),
      ...branches("public", "business_branches", { id: ["SELECT"], business_id: ["SELECT"], status: ["SELECT"], created_by: ["UPDATE"] }),
      ...branches("public", "business_members", {
        id: ["SELECT"], business_id: ["SELECT", "INSERT"], user_id: ["SELECT", "INSERT"], role_id: ["INSERT"], status: ["INSERT"],
      }),
      ...branches("public", "business_member_branches", {
        business_id: ["INSERT"], member_id: ["INSERT"], branch_id: ["INSERT"], is_primary: ["INSERT"], assigned_by: ["INSERT"],
      }),
    ],
  };

  const EXACT_TABLE_LEVEL_GRANTS_BY_ROLE: Record<string, TableGrant[]> = {
    private_branch_writer: [],
    // grant delete on public.business_member_branches to private_staff_writer;
    // — DELETE has no column list at all in the migration; it is the one
    // genuinely table-level grant among these four roles.
    private_staff_writer: [{ schema: "public", table: "business_member_branches", privilege: "DELETE" }],
    private_invitation_writer: [],
    private_invitation_acceptor: [],
  };

  function sortColGrants(rows: ColGrant[]) {
    return [...rows].sort((a, b) =>
      `${a.schema}.${a.table}.${a.column}.${a.privilege}`.localeCompare(`${b.schema}.${b.table}.${b.column}.${b.privilege}`)
    );
  }
  function sortTableGrants(rows: TableGrant[]) {
    return [...rows].sort((a, b) => `${a.schema}.${a.table}.${a.privilege}`.localeCompare(`${b.schema}.${b.table}.${b.privilege}`));
  }

  it.each(ROLES)("%s: exact (schema, table, column, privilege) column-grant set — no more, no less", async (role) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_schema: string; table_name: string; column_name: string; privilege_type: string }[]>`
        select table_schema, table_name, column_name, privilege_type
        from information_schema.role_column_grants
        where grantee = ${role}
      `;
      const actual = sortColGrants(
        rows.map((r) => ({
          schema: r.table_schema, table: r.table_name, column: r.column_name,
          privilege: r.privilege_type as ColGrant["privilege"],
        }))
      );
      const expected = sortColGrants(EXACT_COLUMN_GRANTS_BY_ROLE[role]);
      expect(actual, role).toEqual(expected);
    } finally {
      await sql.end();
    }
  });

  it.each(ROLES)(
    "%s: exact table-level grant set (DELETE/TRUNCATE/REFERENCES/TRIGGER) — sensitive broader privileges are absent unless explicitly expected",
    async (role) => {
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ table_schema: string; table_name: string; privilege_type: string }[]>`
          select table_schema, table_name, privilege_type
          from information_schema.role_table_grants
          where grantee = ${role}
            and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
        `;
        const actual = sortTableGrants(
          rows.map((r) => ({ schema: r.table_schema, table: r.table_name, privilege: r.privilege_type as TableGrant["privilege"] }))
        );
        const expected = sortTableGrants(EXACT_TABLE_LEVEL_GRANTS_BY_ROLE[role]);
        expect(actual, role).toEqual(expected);
      } finally {
        await sql.end();
      }
    }
  );

  // SELECT/INSERT/UPDATE must never appear as a bare table-level grant for
  // any of these four roles — every real grant of those three privilege
  // types is deliberately column-restricted (see the column-grant test
  // above); a table-level SELECT/INSERT/UPDATE row here would mean some
  // migration accidentally granted a WHOLE table's worth of columns
  // instead of the intended narrow subset.
  it.each(ROLES)("%s: SELECT/INSERT/UPDATE never appear as table-wide (unrestricted-column) grants", async (role) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants
        where grantee = ${role} and privilege_type in ('SELECT', 'INSERT', 'UPDATE')
      `;
      expect(rows[0].n, role).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("no client write bypass — every Phase 1F mutation is RPC-only", () => {
  it.each(PHASE_1F_TABLES)("authenticated has no direct INSERT grant on %s", async (table) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'authenticated' and table_name = ${table} and privilege_type = 'INSERT'
      `;
      expect(rows[0].n, table).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it.each(PHASE_1F_TABLES)("authenticated has no direct UPDATE grant on %s", async (table) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'authenticated' and table_name = ${table} and privilege_type = 'UPDATE'
      `;
      expect(rows[0].n, table).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it.each(PHASE_1F_TABLES)("authenticated has no DELETE grant on %s at all", async (table) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'authenticated' and table_name = ${table} and privilege_type = 'DELETE'
      `;
      expect(rows[0].n, table).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("business deletion still works with Phase 1F tables present", () => {
  it("deleting a business cascades branches, member-branches, invitations, and invitation-branches without error", async () => {
    const owner = await createOwnerAndBusiness("phase1f-business-delete");
    cleanupUserIds.push(owner.userId);

    const branchId = await createBranch(owner.client, owner.businessId, { name: "Cascade Branch" });
    await inviteMember(owner.client, owner.businessId, randomEmail("cascade-invite"), "VIEWER", {
      branchIds: [branchId],
      primaryBranchId: branchId,
    });

    const admin = createAdminClient();

    // Phase 1J, SEC-01J: audit_events.business_id is deliberately
    // `on delete restrict` (never cascade) — a business with any audit
    // history (which createBranch/inviteMember above now generate, via
    // create_business_branch's own branch.created and
    // create_business_invitation's own staff.invited instrumentation)
    // can no longer be hard-deleted at all, by design (see
    // 20260902090000_create_audit_events.sql's own header comment). This
    // test's own purpose is proving Phase 1F tables cascade cleanly — an
    // orthogonal concern to audit durability — so the business's own
    // audit trail is cleared first.
    const cleanupSql = createTestDbClient();
    try {
      await cleanupSql`delete from public.audit_events where business_id = ${owner.businessId}`;
    } finally {
      await cleanupSql.end();
    }

    const { error } = await admin.from("businesses").delete().eq("id", owner.businessId);
    expect(error).toBeNull();

    const sql = createTestDbClient();
    try {
      for (const table of [...PHASE_1F_TABLES]) {
        const rows = await sql`select count(*)::int as n from public.${sql(table)} where business_id = ${owner.businessId}`;
        expect((rows[0] as { n: number }).n, table).toBe(0);
      }

      // Codex adversarial review round 3, Finding H: the ORIGINAL version
      // of this test only checked the PUBLIC Phase 1F tables — the
      // private idempotency-ledger tables (never exposed via PostgREST,
      // so only reachable with this privileged direct-SQL connection)
      // were never verified to cascade-delete at all. Both the branch
      // creation above (via createBranch → create_business_branch, which
      // claims a private.business_branch_creation_requests row) and the
      // invitation above (via inviteMember → create_business_invitation,
      // which claims a private.business_invitation_requests row) leave
      // real ledger rows for this business — this proves the business_id
      // FK's own ON DELETE CASCADE reaches into the private schema too,
      // not merely the public tables.
      for (const table of ["business_branch_creation_requests", "business_invitation_requests"] as const) {
        const rows = await sql`select count(*)::int as n from private.${sql(table)} where business_id = ${owner.businessId}`;
        expect((rows[0] as { n: number }).n, table).toBe(0);
      }
    } finally {
      await sql.end();
    }
  });
});
