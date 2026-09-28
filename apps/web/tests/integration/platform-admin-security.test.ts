// Phase 1O-A — Platform Admin Security Foundation.
//
// Proves the two authorization domains (tenant vs. platform) are actually
// separate at the database, not merely by application-code convention: a
// tenant OWNER/ADMIN (even across multiple businesses) has zero platform
// authority, an inactive platform_admins row is denied exactly like a
// missing one, an anonymous/unauthenticated caller cannot reach either
// authorization function or the underlying tables, and a caller cannot
// spoof another user's platform permission by any argument.
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

// No app-level platform-admin-provisioning RPC exists in 1O-A by design
// (explicit operator bootstrap only — see the migration's table comment),
// so fixtures are inserted directly via the raw Postgres test client,
// exactly like addMemberWithRole does for tenant membership fixtures.
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

describe("RLS enabled + FORCED on every platform_admins table", () => {
  it.each(["platform_admins", "platform_permissions", "platform_role_permissions"])(
    "%s has both relrowsecurity and relforcerowsecurity set",
    async (table) => {
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
    }
  );
});

describe("direct table access is denied for every non-service role", () => {
  it("authenticated cannot SELECT platform_admins directly (no grant, no policy)", async () => {
    const { userId, client } = await createSignedInUser("plat-direct");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");

    const { data, error } = await client.from("platform_admins").select("*");
    // No SELECT grant to `authenticated` at all: PostgREST must reject the
    // request outright (permission denied), never silently return zero
    // rows as if RLS alone were doing the filtering.
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("anon cannot SELECT or enumerate platform_admins", async () => {
    const anon = createAnonClient();
    const { data, error } = await anon.from("platform_admins").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("authenticated cannot INSERT into platform_admins (no self-provisioning)", async () => {
    const { userId, client } = await createSignedInUser("plat-selfgrant");
    cleanupUserIds.push(userId);

    const { error } = await client
      .from("platform_admins")
      .insert({ user_id: userId, role: "SUPER_ADMIN" } as never);
    expect(error).not.toBeNull();
  });

  it("authenticated cannot UPDATE platform_admins (no self-escalation of an existing row)", async () => {
    const { userId, client } = await createSignedInUser("plat-selfupdate");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");

    const { error } = await client
      .from("platform_admins")
      .update({ role: "SUPER_ADMIN" } as never)
      .eq("user_id", userId);
    expect(error).not.toBeNull();

    // Confirm the row was in fact untouched, not just that PostgREST
    // reported an error while a permissive policy silently let it through.
    const role = await client.rpc("get_my_platform_role");
    expect(role.data).toBe("VIEWER");
  });

  it("authenticated cannot SELECT platform_permissions directly (no grant, no policy)", async () => {
    const { userId, client } = await createSignedInUser("plat-perm-direct");
    cleanupUserIds.push(userId);

    const { data, error } = await client.from("platform_permissions").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("anon cannot SELECT platform_permissions", async () => {
    const anon = createAnonClient();
    const { data, error } = await anon.from("platform_permissions").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("authenticated cannot SELECT platform_role_permissions directly (no grant, no policy)", async () => {
    const { userId, client } = await createSignedInUser("plat-roleperm-direct");
    cleanupUserIds.push(userId);

    const { data, error } = await client.from("platform_role_permissions").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("anon cannot SELECT platform_role_permissions", async () => {
    const anon = createAnonClient();
    const { data, error } = await anon.from("platform_role_permissions").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("authenticated cannot INSERT into platform_role_permissions (no self-granted permission mapping)", async () => {
    const { userId, client } = await createSignedInUser("plat-roleperm-selfgrant");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");

    const { error } = await client
      .from("platform_role_permissions")
      .insert({ role: "VIEWER", permission_key: "platform.subscriptions.view" } as never);
    expect(error).not.toBeNull();
  });

  it("anon cannot call has_platform_permission or get_my_platform_role", async () => {
    const anon = createAnonClient();
    const results = await Promise.all([
      anon.rpc("has_platform_permission", { p_permission_key: "platform.dashboard.view" }),
      anon.rpc("get_my_platform_role"),
    ]);
    for (const r of results) {
      expect(r.error).not.toBeNull();
    }
  });
});

describe("tenant authorization never implies platform authorization", () => {
  it("a tenant OWNER (no platform_admins row) is denied every platform permission", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("plat-owner");
    cleanupUserIds.push(userId);
    expect(businessId).toBeTruthy();

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);

    const role = await client.rpc("get_my_platform_role");
    expect(role.error).toBeNull();
    expect(role.data).toBeNull();
  });

  it("a tenant ADMIN (no platform_admins row) is denied every platform permission", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("plat-admin-owner");
    cleanupUserIds.push(ownerUserId);

    const { userId, client } = await createSignedInUser("plat-admin");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("ownership of multiple businesses still grants zero platform authority", async () => {
    const { userId, client } = await createSignedInUser("plat-multi-owner");
    cleanupUserIds.push(userId);

    for (const prefix of ["biz-a", "biz-b"]) {
      const { error } = await client.rpc("create_business", {
        p_name: prefix,
        p_slug: `${prefix}-${randomUuid()}`,
      });
      expect(error).toBeNull();
    }

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

describe("platform role/permission resolution (AAL2 required)", () => {
  it("an active platform VIEWER at AAL2 can resolve platform.dashboard.view", async () => {
    const { userId, client } = await createSignedInUser("plat-viewer");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);

    const role = await client.rpc("get_my_platform_role");
    expect(role.data).toBe("VIEWER");
  });

  it("VIEWER at AAL2 does not hold a permission reserved for other roles", async () => {
    const { userId, client } = await createSignedInUser("plat-viewer-scope");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.subscriptions.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("SUPER_ADMIN at AAL2 resolves every seeded platform permission", async () => {
    const { userId, client } = await createSignedInUser("plat-super");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const keys = [
      "platform.dashboard.view",
      "platform.businesses.view",
      "platform.users.view",
      "platform.subscriptions.view",
      "platform.audit.view",
    ];
    for (const key of keys) {
      const { data, error } = await client.rpc("has_platform_permission", { p_permission_key: key });
      expect(error, key).toBeNull();
      expect(data, key).toBe(true);
    }
  });

  it("an inactive platform admin at AAL2 is still denied despite holding a role", async () => {
    const { userId, client } = await createSignedInUser("plat-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN", false);
    await elevateToAal2(client);

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);

    // get_my_platform_role() is AAL-unaware by design (see the migration),
    // but an inactive row still resolves to null regardless.
    const role = await client.rpc("get_my_platform_role");
    expect(role.data).toBeNull();
  });

  it("a tenant OWNER at AAL2 with no platform_admins row is still denied — MFA is not platform authority", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("plat-owner-aal2");
    cleanupUserIds.push(userId);
    expect(businessId).toBeTruthy();
    await elevateToAal2(client);

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("a real tenant ADMIN genuinely elevated to AAL2 (real MFA, not just enrolled) is still denied every platform permission", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("plat-admin-owner-aal2");
    cleanupUserIds.push(ownerUserId);

    const { userId, client } = await createSignedInUser("plat-admin-aal2");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");

    // Prove the fixture actually holds tenant ADMIN authority for this
    // business before relying on the negative result below — otherwise a
    // broken fixture (e.g. the insert silently no-op'ing) would make this
    // test pass for the wrong reason.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ role: string }[]>`
        select roles.name as role
        from public.business_members bm
        join public.roles on roles.id = bm.role_id
        where bm.business_id = ${businessId} and bm.user_id = ${userId} and bm.status = 'active'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("ADMIN");
    } finally {
      await sql.end();
    }

    // Elevate via the real Supabase MFA flow (enroll + verify a genuinely
    // computed TOTP code) — not merely enrolling a factor without verifying
    // it, which would leave the session at AAL1.
    await elevateToAal2(client);

    // Confirm the session itself reached aal2, not just that a factor
    // exists unverified.
    const { data: aal, error: aalError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(aalError).toBeNull();
    expect(aal?.currentLevel).toBe("aal2");

    // With tenant ADMIN authority confirmed and the session genuinely at
    // AAL2, the real platform permission boundary must still say no:
    // tenant authority + valid MFA never implies platform authority.
    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);

    const role = await client.rpc("get_my_platform_role");
    expect(role.error).toBeNull();
    expect(role.data).toBeNull();
  });
});

describe("AAL2 enforcement", () => {
  it("an active SUPER_ADMIN at AAL1 (no MFA verified this session) is denied every platform permission", async () => {
    const { userId, client } = await createSignedInUser("plat-super-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    // Deliberately no elevateToAal2(client) — this session is AAL1.

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("an active VIEWER at AAL1 is denied", async () => {
    const { userId, client } = await createSignedInUser("plat-viewer-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");

    const { data, error } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("get_my_platform_role() still resolves at AAL1 — role resolution is deliberately AAL-unaware, so the app guard can route an AAL1 admin to the MFA challenge instead of a flat 404", async () => {
    const { userId, client } = await createSignedInUser("plat-role-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");

    const { data, error } = await client.rpc("get_my_platform_role");
    expect(error).toBeNull();
    expect(data).toBe("SUPER_ADMIN");
  });

  it("becoming AAL2 does not itself change platform role or grant any permission not already seeded", async () => {
    const { userId, client } = await createSignedInUser("plat-aal2-no-escalation");
    cleanupUserIds.push(userId);
    // No platform_admins row at all.
    await elevateToAal2(client);

    const role = await client.rpc("get_my_platform_role");
    expect(role.data).toBeNull();

    const { data } = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(data).toBe(false);
  });
});

describe("cross-user spoofing", () => {
  it("has_platform_permission takes no user-id argument to spoof", async () => {
    const { userId, client } = await createSignedInUser("plat-spoofer");
    cleanupUserIds.push(userId);

    const { userId: victimId } = await createSignedInUser("plat-victim");
    cleanupUserIds.push(victimId);
    await insertPlatformAdmin(victimId, "SUPER_ADMIN");

    // The spoofer is not a platform admin at all; passing the victim's id
    // as any extra argument is rejected by PostgREST itself (the function
    // has exactly one parameter), and the function's own result is scoped
    // to the caller's own session regardless.
    const attempt = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
      p_user_id: victimId,
    } as unknown as { p_permission_key: string });
    expect(attempt.error).not.toBeNull();

    const legitimate = await client.rpc("has_platform_permission", {
      p_permission_key: "platform.dashboard.view",
    });
    expect(legitimate.data).toBe(false);
  });
});

describe("RPC EXECUTE ACLs are narrow and explicit", () => {
  it.each(["has_platform_permission", "get_my_platform_role"])(
    "%s: EXECUTE is granted to authenticated, never to anon or PUBLIC",
    async (fn) => {
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
    }
  );

  it("private.has_platform_permission and private.get_my_platform_role have search_path = ''", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proname: string; proconfig: string[] | null }[]>`
        select proname, proconfig
        from pg_proc
        where proname in ('has_platform_permission', 'get_my_platform_role')
          and pronamespace = 'private'::regnamespace
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const hasEmptySearchPath = (row.proconfig ?? []).some((entry) =>
          entry.startsWith("search_path=")
        );
        expect(hasEmptySearchPath, `${row.proname}: ${JSON.stringify(row.proconfig)}`).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });
});
