import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { createBranch, assignMemberToBranch, getMemberId } from "./helpers/staff";

// Codex adversarial review, application-layer round 3 — the ONE additive
// migration this remediation is permitted to add
// (20260830080000_branch_option_rpc.sql). These tests exercise
// public.get_business_branch_options directly, independent of the
// application layer, exactly like invitation-branch-options.test.ts does
// for get_invitation_branch_options.
//
// Every fixture below uses a deliberately custom, minimal permission set
// (createMemberWithCustomPermissions) that NEVER includes branches.view
// unless a test is specifically about branches.view being irrelevant —
// the whole point of this RPC is that none of its five scopes may ever
// depend on it.

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

describe("get_business_branch_options — operations scope", () => {
  it("1. sales.create without branches.view can retrieve assigned ACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-sales");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ops Sales Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-sales", ["sales.create"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data, error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(branchB);
    expect(data![0].name).toBe("Ops Sales Branch");
    expect(data![0].is_primary).toBe(true);
  });

  it("2. inventory.adjust without branches.view can retrieve assigned ACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-inv");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ops Inventory Branch" });
    // inventory.view_cost is bundled alongside inventory.adjust here only
    // to respect rbac-implication.test.ts's own global invariant ("every
    // role with inventory.adjust also has inventory.view_cost" — a
    // pre-existing assumption checked across the whole roles table, not
    // scoped to this test) — it plays no role in what THIS test verifies.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-inv", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data, error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("3. products.manage without branches.view can retrieve assigned ACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-prod");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ops Product Branch" });
    // inventory.view_cost is bundled alongside products.manage here only
    // to respect rbac-implication.test.ts's own global invariant ("every
    // role with products.manage also has inventory.view_cost") — it plays
    // no role in what THIS test verifies.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-prod", [
      "products.manage",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data, error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("4. a branch the caller is NOT assigned to is excluded", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-unassigned");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Ops Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-unassigned", ["sales.create"]);
    cleanupUserIds.push(worker.userId);
    // Never assigned to branchB — worker keeps only their auto-assigned
    // default branch.

    const { data, error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(false);
  });

  it("5. an inactive branch the caller is still assigned to is excluded", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-inactive");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Deactivating Ops Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-inactive", ["sales.create"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    const { data, error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(false);
  });

  it("6. a foreign business is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-foreign-a");
    const stranger = await createOwnerAndBusiness("bopt-ops-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a caller with NONE of the three operational permissions is denied, even with a real assignment", async () => {
    const owner = await createOwnerAndBusiness("bopt-ops-no-perm");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-ops-no-perm", ["expenses.manage"]);
    cleanupUserIds.push(worker.userId);

    const { error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("get_business_branch_options — expenses scope", () => {
  it("7. expenses.manage without branches.view can retrieve all same-business ACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-active");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Expense Branch B" });
    const clerk = await createMemberWithCustomPermissions(owner.businessId, "bopt-exp-active", ["expenses.manage"]);
    cleanupUserIds.push(clerk.userId);
    // clerk is never assigned to branchB — expenses scope imposes no
    // assignment restriction at all.

    const { data, error } = await clerk.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("8. an inactive branch is excluded", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-inactive");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Inactive Expense Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    const clerk = await createMemberWithCustomPermissions(owner.businessId, "bopt-exp-inactive", ["expenses.manage"]);
    cleanupUserIds.push(clerk.userId);

    const { data } = await clerk.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    expect(data!.some((b) => b.id === branchB)).toBe(false);
  });

  it("9. a foreign business is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-foreign-a");
    const stranger = await createOwnerAndBusiness("bopt-exp-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  // expenses.view ALONE (no expenses.manage) must also resolve this
  // scope — the expense LIST page's own branch filter is reachable on
  // expenses.view alone (a real, tested app-layer role composition; see
  // tests/e2e/expenses.spec.ts's "a view-only user (expenses.view, no
  // expenses.manage) can browse..." test), and this RPC backs that filter
  // exactly as much as it backs the expenses.manage-gated create form.
  // Mirrors expense_categories' own "expenses.view OR expenses.manage"
  // SELECT policy precedent (create_expense_categories.sql).
  it("expenses.view ALONE (no expenses.manage) can also retrieve all same-business ACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-view-only");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "View-Only Expense Branch" });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "bopt-exp-view-only", ["expenses.view"]);
    cleanupUserIds.push(viewer.userId);

    const { data, error } = await viewer.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("a caller with NEITHER expenses.view nor expenses.manage is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-neither");
    cleanupUserIds.push(owner.userId);
    const nobody = await createMemberWithCustomPermissions(owner.businessId, "bopt-exp-neither", ["sales.view"]);
    cleanupUserIds.push(nobody.userId);

    const { error } = await nobody.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("flags the caller's own primary branch's row, even in this business-wide result", async () => {
    const owner = await createOwnerAndBusiness("bopt-exp-primary");
    cleanupUserIds.push(owner.userId);
    const clerk = await createMemberWithCustomPermissions(owner.businessId, "bopt-exp-primary", ["expenses.manage"]);
    cleanupUserIds.push(clerk.userId);
    const { data: defaultBranch } = await owner.client.from("business_branches").select("id").eq("business_id", owner.businessId).eq("is_default", true).single();

    const { data } = await clerk.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "expenses",
    });
    const own = data!.find((b) => b.id === defaultBranch!.id);
    expect(own?.is_primary).toBe(true);
  });
});

describe("get_business_branch_options — reports scope", () => {
  it("10. reports.view without branches.view can retrieve same-business ACTIVE + INACTIVE branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-rep-both");
    cleanupUserIds.push(owner.userId);
    const activeBranch = await createBranch(owner.client, owner.businessId, { name: "Report Active Branch" });
    const inactiveBranch = await createBranch(owner.client, owner.businessId, { name: "Report Inactive Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: inactiveBranch });
    const analyst = await createMemberWithCustomPermissions(owner.businessId, "bopt-rep-both", ["reports.view"]);
    cleanupUserIds.push(analyst.userId);

    const { data, error } = await analyst.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "reports",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === activeBranch && b.status === "ACTIVE")).toBe(true);
    expect(data!.some((b) => b.id === inactiveBranch && b.status === "INACTIVE")).toBe(true);
  });

  it("11. a foreign business is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-rep-foreign-a");
    const stranger = await createOwnerAndBusiness("bopt-rep-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "reports",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("get_business_branch_options — sales_filter scope", () => {
  it("12. sales.view without branches.view gets business-wide filter branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-sf-wide");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Sales Filter Branch B" });
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "bopt-sf-wide", ["sales.view"]);
    cleanupUserIds.push(accountant.userId);
    // accountant is never assigned to branchB.

    const { data, error } = await accountant.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "sales_filter",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("13. a historical inactive branch is included", async () => {
    const owner = await createOwnerAndBusiness("bopt-sf-inactive");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Historical Sales Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "bopt-sf-inactive", ["sales.view"]);
    cleanupUserIds.push(accountant.userId);

    const { data } = await accountant.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "sales_filter",
    });
    expect(data!.some((b) => b.id === branchB && b.status === "INACTIVE")).toBe(true);
  });
});

describe("get_business_branch_options — inventory_filter scope", () => {
  it("14. inventory.view without branches.view gets business-wide current filter branches", async () => {
    const owner = await createOwnerAndBusiness("bopt-if-wide");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Inventory Filter Branch B" });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "bopt-if-wide", ["inventory.view"]);
    cleanupUserIds.push(viewer.userId);

    const { data, error } = await viewer.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "inventory_filter",
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("15. no staff-assignment restriction — an unassigned viewer still sees every ACTIVE branch", async () => {
    const owner = await createOwnerAndBusiness("bopt-if-unassigned");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Inventory Filter Branch" });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "bopt-if-unassigned", ["inventory.view"]);
    cleanupUserIds.push(viewer.userId);

    const { data } = await viewer.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "inventory_filter",
    });
    expect(data!.some((b) => b.id === branchB)).toBe(true);
  });

  it("an inactive branch is excluded", async () => {
    const owner = await createOwnerAndBusiness("bopt-if-inactive");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Inactive Inventory Filter Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "bopt-if-inactive", ["inventory.view"]);
    cleanupUserIds.push(viewer.userId);

    const { data } = await viewer.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "inventory_filter",
    });
    expect(data!.some((b) => b.id === branchB)).toBe(false);
  });
});

describe("get_business_branch_options — security", () => {
  it("16. PUBLIC is denied", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = 'get_business_branch_options' and acl.privilege_type = 'EXECUTE'
      `;
      expect(rows.map((r) => r.grantee)).not.toContain("PUBLIC");
    } finally {
      await sql.end();
    }
  });

  it("17. anon is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-sec-anon");
    cleanupUserIds.push(owner.userId);
    const anon = createAnonClient();

    const { data, error } = await anon.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("18. service_role is denied", async () => {
    const owner = await createOwnerAndBusiness("bopt-sec-service");
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();

    const { data, error } = await admin.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("19. authenticated execution is allowed", async () => {
    const owner = await createOwnerAndBusiness("bopt-sec-authenticated");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-sec-authenticated", ["sales.create"]);
    cleanupUserIds.push(worker.userId);

    const { error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(error).toBeNull();
  });

  it("20. an unknown p_scope is rejected", async () => {
    const owner = await createOwnerAndBusiness("bopt-sec-unknown-scope");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-sec-unknown-scope", ["sales.create"]);
    cleanupUserIds.push(worker.userId);

    const { error } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      // p_scope is typed as a plain string at the generated-client
      // boundary (never a literal union), so nothing at the TypeScript
      // layer stops a caller from sending an arbitrary string — this
      // proves the SQL-level whitelist itself rejects it.
      p_scope: "not_a_real_scope",
    });
    expect(error?.message).toContain("invalid_scope");
  });

  it("a random/nonexistent businessId is denied the same way as a real foreign tenant (non-disclosure)", async () => {
    const stranger = await createOwnerAndBusiness("bopt-sec-nonexistent");
    cleanupUserIds.push(stranger.userId);

    const { error } = await stranger.client.rpc("get_business_branch_options", {
      p_business_id: randomUuid(),
      p_scope: "operations",
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("is SECURITY DEFINER with search_path = ''", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
        select prosecdef, proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_business_branch_options'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].proconfig).toContain('search_path=""');
    } finally {
      await sql.end();
    }
  });

  it("is owned by the narrow private_branch_option_reader role, never postgres/authenticated/service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ owner: string }[]>`
        select r.rolname as owner
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public' and p.proname = 'get_business_branch_options'
      `;
      expect(rows[0].owner).toBe("private_branch_option_reader");
    } finally {
      await sql.end();
    }
  });

  it("private_branch_option_reader is NOLOGIN, NOINHERIT, BYPASSRLS", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = 'private_branch_option_reader'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolinherit).toBe(false);
      expect(rows[0].rolbypassrls).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("private_branch_option_reader holds grants on EXACTLY business_branches, business_member_branches, business_members — no other table", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_name: string }[]>`
        select distinct table_name from information_schema.role_table_grants where grantee = 'private_branch_option_reader'
        union
        select distinct table_name from information_schema.role_column_grants where grantee = 'private_branch_option_reader'
      `;
      expect([...new Set(rows.map((r) => r.table_name))].sort()).toEqual([
        "business_branches",
        "business_member_branches",
        "business_members",
      ]);
    } finally {
      await sql.end();
    }
  });

  it("private_branch_option_reader's column grant on business_branches excludes address/phone/created_by/timestamps", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.role_column_grants
        where grantee = 'private_branch_option_reader' and table_name = 'business_branches'
      `;
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        ["business_id", "code", "id", "is_default", "name", "status"].sort()
      );
    } finally {
      await sql.end();
    }
  });

  it("EXECUTE is granted to authenticated only — never anon, PUBLIC, or service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = 'get_business_branch_options' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      expect(grantees).toContain("authenticated");
      expect(grantees).not.toContain("anon");
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("service_role");
    } finally {
      await sql.end();
    }
  });

  it("returns EXACTLY {id, name, code, status, is_default, is_primary} — no address/phone/created_by/timestamps/staff-assignment/permission data", async () => {
    const owner = await createOwnerAndBusiness("bopt-shape");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "bopt-shape", ["sales.create"]);
    cleanupUserIds.push(worker.userId);

    const { data } = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(data!.length).toBeGreaterThan(0);
    expect(Object.keys(data![0]).sort()).toEqual(["code", "id", "is_default", "is_primary", "name", "status"]);
  });
});
