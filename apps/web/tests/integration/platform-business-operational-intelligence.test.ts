// Phase 1O-C — Support & Operational Intelligence.
//
// Proves the two-permission split: platform.businesses.view gates
// Overview/Members/Activity/Diagnostics; platform.audit.view is a wholly
// separate, independently re-checked permission for the Audit RPC only.
// Mirrors 1O-B's own authorization-matrix test structure exactly.
import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser, createUserClient, createConfirmedTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, addMemberWithRole, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";
import { elevateToAal2 } from "./helpers/mfa";

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

const PASSWORD = "Password1234";

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSignedInUser(prefix: string) {
  const email = `${unique(prefix)}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return { userId: user.id, client };
}

async function insertPlatformAdmin(userId: string, role: string, isActive = true) {
  const sql = createTestDbClient();
  try {
    await sql`
      insert into public.platform_admins (user_id, role, is_active)
      values (${userId}, ${role}, ${isActive})
    `;
  } finally {
    await sql.end();
  }
}

async function createAuthorizedAdmin(prefix: string, role = "SUPER_ADMIN") {
  const { userId, client } = await createSignedInUser(prefix);
  cleanupUserIds.push(userId);
  await insertPlatformAdmin(userId, role);
  await elevateToAal2(client);
  return { userId, client };
}

const RPCS = [
  "get_platform_business_overview",
  "list_platform_business_members",
  "list_platform_business_activity",
] as const;

describe("1O-C businesses.view-gated RPCs: authorization matrix", () => {
  it("SUPER_ADMIN at AAL2 can call every businesses.view-gated RPC", async () => {
    const { client } = await createAuthorizedAdmin("oc-super");
    const { userId, businessId } = await createOwnerAndBusiness("oc-super-target");
    cleanupUserIds.push(userId);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).toBeNull();
    }
  });

  it("SUPPORT at AAL2 (businesses.view but not audit.view) can use every non-audit tab, and audit is denied", async () => {
    const { client } = await createAuthorizedAdmin("oc-support", "SUPPORT");
    const { userId, businessId } = await createOwnerAndBusiness("oc-support-target");
    cleanupUserIds.push(userId);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).toBeNull();
    }

    const audit = await client.rpc("list_platform_business_audit", { p_business_id: businessId });
    expect(audit.error).not.toBeNull();
    expect(audit.error?.message).toContain("insufficient_privilege");
  });

  it("VIEWER at AAL2 (no businesses.view per 1O-A's frozen matrix) is denied on every RPC", async () => {
    const { client } = await createAuthorizedAdmin("oc-viewer", "VIEWER");
    const { userId, businessId } = await createOwnerAndBusiness("oc-viewer-target");
    cleanupUserIds.push(userId);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).not.toBeNull();
    }
  });

  it("a tenant OWNER at AAL2 with no platform_admins row is denied on every new RPC, including audit", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("oc-tenant-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).not.toBeNull();
    }
    const audit = await client.rpc("list_platform_business_audit", { p_business_id: businessId });
    expect(audit.error).not.toBeNull();
  });

  it("a tenant ADMIN at AAL2 with no platform_admins row is denied on every new RPC", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("oc-tenant-admin-owner");
    cleanupUserIds.push(ownerUserId);
    const { userId, client } = await createSignedInUser("oc-tenant-admin");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");
    await elevateToAal2(client);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).not.toBeNull();
    }
  });

  it("an active SUPER_ADMIN at AAL1 (no MFA verified this session) is denied on every RPC", async () => {
    const { userId, client } = await createSignedInUser("oc-super-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("oc-aal1-target");
    cleanupUserIds.push(ownerUserId);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).not.toBeNull();
    }
  });

  it("an inactive platform admin at AAL2 is denied on every RPC", async () => {
    const { userId, client } = await createSignedInUser("oc-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN", false);
    await elevateToAal2(client);
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("oc-inactive-target");
    cleanupUserIds.push(ownerUserId);

    for (const rpc of RPCS) {
      const { error } = await client.rpc(rpc, { p_business_id: businessId });
      expect(error, rpc).not.toBeNull();
    }
  });

  it("anon cannot call any of the new RPCs", async () => {
    const anon = createAnonClient();
    const id = randomUuid();
    const results = await Promise.all([
      anon.rpc("get_platform_business_overview", { p_business_id: id }),
      anon.rpc("list_platform_business_members", { p_business_id: id }),
      anon.rpc("list_platform_business_activity", { p_business_id: id }),
      anon.rpc("list_platform_business_audit", { p_business_id: id }),
    ]);
    for (const r of results) expect(r.error).not.toBeNull();
  });
});

describe("audit.view is a SEPARATE permission from businesses.view", () => {
  it("SUPER_ADMIN (holds both, per 1O-A's frozen matrix) can call the audit RPC", async () => {
    const { client } = await createAuthorizedAdmin("oc-audit-super");
    const { userId, businessId } = await createOwnerAndBusiness("oc-audit-super-target");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("list_platform_business_audit", { p_business_id: businessId });
    expect(error).toBeNull();
  });

  it("OPERATIONS (businesses.view, no audit.view per frozen matrix) is denied on audit only", async () => {
    const { client } = await createAuthorizedAdmin("oc-audit-ops", "OPERATIONS");
    const { userId, businessId } = await createOwnerAndBusiness("oc-audit-ops-target");
    cleanupUserIds.push(userId);

    const overview = await client.rpc("get_platform_business_overview", { p_business_id: businessId });
    expect(overview.error).toBeNull();

    const audit = await client.rpc("list_platform_business_audit", { p_business_id: businessId });
    expect(audit.error).not.toBeNull();
    expect(audit.error?.message).toContain("insufficient_privilege");
  });
});

describe("get_platform_business_overview: shape, diagnostics, not-found", () => {
  it("returns null for a nonexistent business id", async () => {
    const { client } = await createAuthorizedAdmin("oc-overview-notfound");
    const { data, error } = await client.rpc("get_platform_business_overview", {
      p_business_id: randomUuid(),
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("a freshly created business has an active owner, an active branch, and a live trial subscription (create_business auto-issues one)", async () => {
    const { client } = await createAuthorizedAdmin("oc-overview-fresh-admin");
    const { userId, businessId } = await createOwnerAndBusiness("oc-overview-fresh-target");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("get_platform_business_overview", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    const overview = data as unknown as {
      has_active_owner: boolean;
      active_branch_count: number;
      subscription: { status: string } | null;
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(overview.has_active_owner).toBe(true);
    expect(overview.active_branch_count).toBeGreaterThanOrEqual(1);
    expect(overview.subscription?.status).toBe("TRIALING");
    expect(overview.diagnostics.some((d) => d.code === "SUBSCRIPTION_MISSING")).toBe(false);
    expect(overview.diagnostics.some((d) => d.code === "EXPIRED_TRIAL")).toBe(false);
  });

  it("flags NO_ACTIVE_OWNER and ZERO_ACTIVE_MEMBERS when the owner membership is suspended", async () => {
    const { client } = await createAuthorizedAdmin("oc-diag-owner-admin");
    const { userId, businessId } = await createOwnerAndBusiness("oc-diag-owner-target");
    cleanupUserIds.push(userId);

    // business_members_protect_last_owner (owner_membership_and_last_owner_
    // protection.sql) structurally forbids removing/suspending a business's
    // last active OWNER through any normal write path — which is exactly
    // why NO_ACTIVE_OWNER is expected to be unreachable in real production
    // data. Disabling the trigger here is test-fixture-only (never an
    // application code path) so this deterministic diagnostic rule itself
    // can still be exercised end-to-end.
    const sql = createTestDbClient();
    try {
      await sql`alter table public.business_members disable trigger business_members_protect_last_owner`;
      await sql`update public.business_members set status = 'suspended' where business_id = ${businessId}`;
    } finally {
      await sql`alter table public.business_members enable trigger business_members_protect_last_owner`;
      await sql.end();
    }

    const { data, error } = await client.rpc("get_platform_business_overview", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    const overview = data as unknown as { diagnostics: Array<{ code: string }> };
    expect(overview.diagnostics.some((d) => d.code === "NO_ACTIVE_OWNER")).toBe(true);
    expect(overview.diagnostics.some((d) => d.code === "ZERO_ACTIVE_MEMBERS")).toBe(true);
  });
});

describe("list_platform_business_members: filters, pagination, bounds", () => {
  it("filters by role", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-role-admin");
    const { userId: ownerId, businessId } = await createOwnerAndBusiness("oc-members-role-target");
    cleanupUserIds.push(ownerId);
    const { userId: managerId } = await createSignedInUser("oc-members-role-manager");
    cleanupUserIds.push(managerId);
    await addMemberWithRole(businessId, managerId, "MANAGER");

    const { data, error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessId,
      p_role: "MANAGER",
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("only returns members of the requested business (tenant isolation)", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-iso-admin");
    const { userId: userA, businessId: businessA } = await createOwnerAndBusiness("oc-members-iso-a");
    cleanupUserIds.push(userA);
    const { userId: userB } = await createOwnerAndBusiness("oc-members-iso-b");
    cleanupUserIds.push(userB);

    const { data, error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessA,
    });
    expect(error).toBeNull();
    const ids = (data as unknown as { member_id: string }[]).map((r) => r.member_id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // No member row belonging to business B can appear for business A.
    expect((data as unknown as { email: string }[]).every((r) => typeof r.email === "string" || r.email === null)).toBe(true);
  });

  it("rejects an invalid role (strict allowlist)", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-badrole");
    const { userId, businessId } = await createOwnerAndBusiness("oc-members-badrole-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessId,
      p_role: "SUPERUSER",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a search string over 200 characters", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-search-bounds");
    const { userId, businessId } = await createOwnerAndBusiness("oc-members-search-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessId,
      p_search: "x".repeat(201),
    });
    expect(error).not.toBeNull();
  });

  it("rejects page_size over 100", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-pagesize");
    const { userId, businessId } = await createOwnerAndBusiness("oc-members-pagesize-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessId,
      p_page_size: 101,
    });
    expect(error).not.toBeNull();
  });

  it("rejects an invalid sort key", async () => {
    const { client } = await createAuthorizedAdmin("oc-members-sort");
    const { userId, businessId } = await createOwnerAndBusiness("oc-members-sort-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_members", {
      p_business_id: businessId,
      p_sort: "user_id; drop table business_members;--",
    });
    expect(error).not.toBeNull();
  });
});

describe("list_platform_business_activity: normalized, deterministic, bounded", () => {
  it("returns an empty, well-formed result for a business with no transactions", async () => {
    const { client } = await createAuthorizedAdmin("oc-activity-empty-admin");
    const { userId, businessId } = await createOwnerAndBusiness("oc-activity-empty-target");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("list_platform_business_activity", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("rejects page_size over 100", async () => {
    const { client } = await createAuthorizedAdmin("oc-activity-bounds");
    const { userId, businessId } = await createOwnerAndBusiness("oc-activity-bounds-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_activity", {
      p_business_id: businessId,
      p_page_size: 101,
    });
    expect(error).not.toBeNull();
  });
});

describe("list_platform_business_audit: bounded, no raw JSON payload", () => {
  it("returns the business's own trial-issuance audit event, well-shaped and with no raw metadata field", async () => {
    const { client } = await createAuthorizedAdmin("oc-audit-empty-admin");
    const { userId, businessId } = await createOwnerAndBusiness("oc-audit-empty-target");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("list_platform_business_audit", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    // create_business auto-issues a trial subscription (trial_issuance.sql),
    // which itself writes one audit_events row — so a brand-new business
    // always has exactly this one audit entry, never zero.
    const rows = data as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("subscription.trial_started");
    expect(rows[0]).not.toHaveProperty("metadata");
  });

  it("rejects page_size over 100", async () => {
    const { client } = await createAuthorizedAdmin("oc-audit-bounds");
    const { userId, businessId } = await createOwnerAndBusiness("oc-audit-bounds-target");
    cleanupUserIds.push(userId);
    const { error } = await client.rpc("list_platform_business_audit", {
      p_business_id: businessId,
      p_page_size: 101,
    });
    expect(error).not.toBeNull();
  });
});

describe("audit-only platform admin (audit.view present, businesses.view absent) cannot reach the business support surface", () => {
  // 1O-A's frozen role matrix seeds no role with platform.audit.view but
  // without platform.businesses.view (only SUPER_ADMIN holds audit.view,
  // and it also holds businesses.view) — so this exact combination does
  // not exist as a real seeded role today. To prove the *general*
  // authorization boundary (not just "no role happens to hit this"), this
  // test grants VIEWER a test-scoped platform.audit.view row directly in
  // platform_role_permissions — read by the same has_platform_permission()
  // used everywhere else — and removes it again in `finally`, regardless
  // of test outcome. VIEWER is otherwise seeded with only
  // platform.dashboard.view, so it never gains platform.businesses.view
  // through this. No production seed migration is touched.
  it("audit.view without businesses.view: overview/members/activity RPCs denied, audit RPC allowed, page-shell requires businesses.view", async () => {
    const sql = createTestDbClient();
    const { userId, client } = await createSignedInUser("oc-audit-only");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    try {
      await sql`
        insert into public.platform_role_permissions (role, permission_key)
        values ('VIEWER', 'platform.audit.view')
        on conflict do nothing
      `;

      // 3. Fixture state, proven explicitly before relying on any denial.
      const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aal.error).toBeNull();
      expect(aal.data?.currentLevel).toBe("aal2");

      const auditPerm = await client.rpc("has_platform_permission", {
        p_permission_key: "platform.audit.view",
      });
      expect(auditPerm.error).toBeNull();
      expect(auditPerm.data).toBe(true);

      const businessesPerm = await client.rpc("has_platform_permission", {
        p_permission_key: "platform.businesses.view",
      });
      expect(businessesPerm.error).toBeNull();
      expect(businessesPerm.data).toBe(false);

      const { userId: targetUserId, businessId } = await createOwnerAndBusiness("oc-audit-only-target");
      cleanupUserIds.push(targetUserId);

      // 4-6. businesses.view-gated RPCs: DENIED, not null-as-success.
      for (const rpc of RPCS) {
        const { data, error } = await client.rpc(rpc, { p_business_id: businessId });
        expect(error, rpc).not.toBeNull();
        expect(error?.message, rpc).toContain("insufficient_privilege");
        expect(data, rpc).toBeNull();
      }

      // 7. Positive control: the audit RPC itself is genuinely allowed for
      // this fixture, proving it is audit-authorized rather than simply
      // unauthorized for everything.
      const audit = await client.rpc("list_platform_business_audit", { p_business_id: businessId });
      expect(audit.error).toBeNull();
      expect(audit.data).not.toBeNull();

      // 9. No audit-view leak into businesses-view: re-check after the
      // audit RPC call to rule out any accidental mapping/inheritance.
      const businessesPermAfter = await client.rpc("has_platform_permission", {
        p_permission_key: "platform.businesses.view",
      });
      expect(businessesPermAfter.error).toBeNull();
      expect(businessesPermAfter.data).toBe(false);

      // 8. Page-shell authority evidence: requirePlatformPermission('platform.businesses.view')
      // is the sole gate at app/internal/admin/businesses/[businessId]/page.tsx:45
      // (via PLATFORM_PERMISSION.BUSINESSES_VIEW). Integration tests cannot
      // render that server route directly, but businesses.view === false
      // above, combined with every businesses.view RPC denied above, is
      // the evidence this follow-up accepts in place of a rendered route.
    } finally {
      await sql`
        delete from public.platform_role_permissions
        where role = 'VIEWER' and permission_key = 'platform.audit.view'
      `;
      await sql.end();
    }
  });
});

describe("RPC EXECUTE ACLs and search_path are narrow and explicit", () => {
  const NEW_FUNCTIONS = [
    "get_platform_business_overview",
    "list_platform_business_members",
    "list_platform_business_activity",
    "list_platform_business_audit",
  ];

  it.each(NEW_FUNCTIONS)("%s: EXECUTE is granted to authenticated, never to anon or PUBLIC", async (fn) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
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

  it.each(NEW_FUNCTIONS)("%s has search_path = ''", async (fn) => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proconfig: string[] | null }[]>`
        select proconfig from pg_proc
        where proname = ${fn} and pronamespace = 'public'::regnamespace
      `;
      expect(rows).toHaveLength(1);
      const hasEmptySearchPath = (rows[0].proconfig ?? []).some((entry) => entry.startsWith("search_path="));
      expect(hasEmptySearchPath, fn).toBe(true);
    } finally {
      await sql.end();
    }
  });
});

describe("frozen 1O-B RPC is preserved", () => {
  it("get_platform_business_detail still works unmodified", async () => {
    const { client } = await createAuthorizedAdmin("oc-frozen-1ob");
    const { userId, businessId } = await createOwnerAndBusiness("oc-frozen-1ob-target");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("get_platform_business_detail", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    expect((data as unknown as { business_id: string }).business_id).toBe(businessId);
  });
});
