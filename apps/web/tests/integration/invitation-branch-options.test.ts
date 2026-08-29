import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { createBranch } from "./helpers/staff";

// Codex adversarial review, application-layer round 2, Medium 1: the ONE
// additive migration this remediation is permitted to add
// (20260828080800_invitation_branch_options_rpc.sql). These tests exercise
// public.get_invitation_branch_options directly, independent of the
// application layer, exactly like phase1f-security.test.ts does for the
// original eight Phase 1F migrations.

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

describe("get_invitation_branch_options — authorization", () => {
  it("staff.invite=true, branches.view=false: receives the ACTIVE branch options", async () => {
    const owner = await createOwnerAndBusiness("invopt-invite-only");
    cleanupUserIds.push(owner.userId);
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-invite-only", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);

    const { data, error } = await inviteOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(error).toBeNull();
    expect(data!.some((b) => b.name === "Main Branch")).toBe(true);
  });

  it("staff.invite=false, branches.view=true: cannot call this RPC merely due to branches.view", async () => {
    const owner = await createOwnerAndBusiness("invopt-view-only");
    cleanupUserIds.push(owner.userId);
    const viewOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-view-only", ["branches.view"]);
    cleanupUserIds.push(viewOnly.userId);

    const { error } = await viewOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a suspended member (even one who WAS granted staff.invite) is denied", async () => {
    const owner = await createOwnerAndBusiness("invopt-suspended");
    cleanupUserIds.push(owner.userId);
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-suspended", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);
    const { data: member } = await owner.client.from("business_members").select("id").eq("business_id", owner.businessId).eq("user_id", inviteOnly.userId).single();
    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where id = ${member!.id}`;
    } finally {
      await sql.end();
    }

    const { error } = await inviteOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a foreign-tenant caller (no membership at all) is denied", async () => {
    const owner = await createOwnerAndBusiness("invopt-foreign-a");
    const stranger = await createOwnerAndBusiness("invopt-foreign-b");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("anon is denied", async () => {
    const owner = await createOwnerAndBusiness("invopt-anon");
    cleanupUserIds.push(owner.userId);
    const anon = createAnonClient();

    const { data, error } = await anon.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("a random/nonexistent businessId is denied the same way as a real foreign tenant (non-disclosure)", async () => {
    const stranger = await createOwnerAndBusiness("invopt-nonexistent");
    cleanupUserIds.push(stranger.userId);

    const { error } = await stranger.client.rpc("get_invitation_branch_options", { p_business_id: randomUuid() });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

describe("get_invitation_branch_options — data shape and scope", () => {
  it("returns only ACTIVE branches — an inactive branch is omitted", async () => {
    const owner = await createOwnerAndBusiness("invopt-inactive");
    cleanupUserIds.push(owner.userId);
    const branchId = await createBranch(owner.client, owner.businessId, { name: "Will Deactivate For Options" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchId });
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-inactive", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);

    const { data } = await inviteOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(data!.some((b) => b.id === branchId)).toBe(false);
  });

  it("is tenant-scoped — a branch from a different business never appears", async () => {
    const owner = await createOwnerAndBusiness("invopt-tenant-a");
    const other = await createOwnerAndBusiness("invopt-tenant-b");
    cleanupUserIds.push(owner.userId, other.userId);
    await createBranch(other.client, other.businessId, { name: "Other Tenant Branch" });
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-tenant-a", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);

    const { data } = await inviteOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(data!.some((b) => b.name === "Other Tenant Branch")).toBe(false);
  });

  it("returns EXACTLY {id, name, code} — no address/phone/created_by/timestamps/is_default", async () => {
    const owner = await createOwnerAndBusiness("invopt-shape");
    cleanupUserIds.push(owner.userId);
    const inviteOnly = await createMemberWithCustomPermissions(owner.businessId, "invopt-shape", ["staff.invite"]);
    cleanupUserIds.push(inviteOnly.userId);

    const { data } = await inviteOnly.client.rpc("get_invitation_branch_options", { p_business_id: owner.businessId });
    expect(data!.length).toBeGreaterThan(0);
    expect(Object.keys(data![0]).sort()).toEqual(["code", "id", "name"]);
  });
});

describe("get_invitation_branch_options — security catalog", () => {
  it("is SECURITY DEFINER with search_path = ''", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
        select prosecdef, proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_invitation_branch_options'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].proconfig).toContain('search_path=""');
    } finally {
      await sql.end();
    }
  });

  it("is owned by the narrow private_invitation_branch_reader role, never postgres/authenticated/service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ owner: string }[]>`
        select r.rolname as owner
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public' and p.proname = 'get_invitation_branch_options'
      `;
      expect(rows[0].owner).toBe("private_invitation_branch_reader");
    } finally {
      await sql.end();
    }
  });

  it("private_invitation_branch_reader is NOLOGIN, NOINHERIT, BYPASSRLS", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname = 'private_invitation_branch_reader'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolinherit).toBe(false);
      expect(rows[0].rolbypassrls).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("private_invitation_branch_reader holds grants on EXACTLY business_branches — no other table", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_name: string }[]>`
        select distinct table_name from information_schema.role_table_grants where grantee = 'private_invitation_branch_reader'
        union
        select distinct table_name from information_schema.role_column_grants where grantee = 'private_invitation_branch_reader'
      `;
      expect([...new Set(rows.map((r) => r.table_name))]).toEqual(["business_branches"]);
    } finally {
      await sql.end();
    }
  });

  it("private_invitation_branch_reader's column grant on business_branches is EXACTLY {id, business_id, name, code, status} SELECT — no address/phone/created_by/timestamps/is_default", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string; privilege_type: string }[]>`
        select column_name, privilege_type from information_schema.role_column_grants
        where grantee = 'private_invitation_branch_reader' and table_name = 'business_branches'
      `;
      expect(rows.every((r) => r.privilege_type === "SELECT")).toBe(true);
      expect(rows.map((r) => r.column_name).sort()).toEqual(["business_id", "code", "id", "name", "status"]);
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review round-3 Finding 8C's own fix, reused here:
  // an INNER JOIN from aclexplode() to pg_roles silently drops a PUBLIC
  // grant (grantee OID 0, no matching pg_roles row) — this LEFT JOIN +
  // explicit case is what actually lets "not.toContain('PUBLIC')" fail if
  // it should.
  it("EXECUTE is granted to authenticated only — never anon, PUBLIC, or service_role", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = 'get_invitation_branch_options' and acl.privilege_type = 'EXECUTE'
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
});
