// Phase 1O-B — read-only internal business directory & search.
//
// Proves: platform.businesses.view + AAL2 gate the two new RPCs exactly
// like every other platform RPC (1O-A precedent); a tenant OWNER/ADMIN at
// AAL2 is denied; an AAL1 platform admin is denied; an inactive platform
// admin is denied; search/filter/sort/pagination behave as documented;
// the detail RPC 404s (returns null) for a nonexistent business; and the
// new reader role's grants/ACLs are narrow and explicit.
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

describe("list_platform_businesses / get_platform_business_detail: authorization", () => {
  it("SUPER_ADMIN at AAL2 can list businesses", async () => {
    const { client } = await createAuthorizedAdmin("dir-super");
    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).toBeNull();
  });

  it("SUPPORT at AAL2 can list businesses (seeded in 1O-A's own role matrix)", async () => {
    const { client } = await createAuthorizedAdmin("dir-support", "SUPPORT");
    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).toBeNull();
  });

  it("OPERATIONS at AAL2 can list businesses (seeded in 1O-A's own role matrix)", async () => {
    const { client } = await createAuthorizedAdmin("dir-ops", "OPERATIONS");
    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).toBeNull();
  });

  it("VIEWER at AAL2 is denied — 1O-A's frozen role matrix does not grant platform.businesses.view to VIEWER, and 1O-B does not extend it", async () => {
    const { client } = await createAuthorizedAdmin("dir-viewer", "VIEWER");
    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("BILLING at AAL2 is denied — not seeded platform.businesses.view", async () => {
    const { client } = await createAuthorizedAdmin("dir-billing", "BILLING");
    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
  });

  it("a tenant OWNER at AAL2 with no platform_admins row is denied", async () => {
    const { userId, client } = await createOwnerAndBusiness("dir-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
  });

  it("a tenant ADMIN at AAL2 with no platform_admins row is denied", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("dir-admin-owner");
    cleanupUserIds.push(ownerUserId);
    const { userId, client } = await createSignedInUser("dir-admin");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
  });

  it("an active SUPER_ADMIN at AAL1 (no MFA verified this session) is denied", async () => {
    const { userId, client } = await createSignedInUser("dir-super-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    // Deliberately no elevateToAal2(client).

    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
  });

  it("an inactive platform admin at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("dir-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN", false);
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_businesses", {});
    expect(error).not.toBeNull();
  });

  it("anon cannot call either RPC", async () => {
    const anon = createAnonClient();
    const results = await Promise.all([
      anon.rpc("list_platform_businesses", {}),
      anon.rpc("get_platform_business_detail", { p_business_id: randomUuid() }),
    ]);
    for (const r of results) {
      expect(r.error).not.toBeNull();
    }
  });

  it("get_platform_business_detail is gated identically to the list RPC", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("dir-detail-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("get_platform_business_detail", {
      p_business_id: businessId,
    });
    expect(error).not.toBeNull();
  });
});

describe("list_platform_businesses: search, filter, sort, pagination", () => {
  it("filters by business name search (case-insensitive substring)", async () => {
    const { client } = await createAuthorizedAdmin("dir-search-admin");
    const { userId, businessId } = await createOwnerAndBusiness("dir-search-target");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    const uniqueName = `Zzyzx-${randomUuid()}`;
    try {
      await sql`update public.businesses set name = ${uniqueName} where id = ${businessId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await client.rpc("list_platform_businesses", {
      p_search: uniqueName.toLowerCase(),
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as unknown as { business_id: string }[])[0].business_id).toBe(businessId);
  });

  it("treats % and _ in search as literal characters, not wildcards", async () => {
    const { client } = await createAuthorizedAdmin("dir-escape-admin");
    const { data, error } = await client.rpc("list_platform_businesses", {
      p_search: "100%_impossible_business_name_zzz",
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("rejects a search string over 200 characters", async () => {
    const { client } = await createAuthorizedAdmin("dir-search-bounds");
    const { error } = await client.rpc("list_platform_businesses", {
      p_search: "x".repeat(201),
    });
    expect(error).not.toBeNull();
  });

  it("filters by country_code", async () => {
    const { client } = await createAuthorizedAdmin("dir-country-admin");
    const { userId, businessId } = await createOwnerAndBusiness("dir-country-target");
    cleanupUserIds.push(userId);

    const sql = createTestDbClient();
    try {
      await sql`update public.businesses set country_code = 'GH', currency_code = 'GHS', timezone = 'Africa/Accra' where id = ${businessId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await client.rpc("list_platform_businesses", {
      p_country_code: "GH",
    });
    expect(error).toBeNull();
    const ids = (data as unknown as { business_id: string }[]).map((r) => r.business_id);
    expect(ids).toContain(businessId);
  });

  it("rejects an invalid sort key (strict allowlist, no arbitrary column injection)", async () => {
    const { client } = await createAuthorizedAdmin("dir-sort-bounds");
    const { error } = await client.rpc("list_platform_businesses", {
      p_sort: "created_by; drop table businesses;--",
    });
    expect(error).not.toBeNull();
  });

  it("rejects an invalid sort direction", async () => {
    const { client } = await createAuthorizedAdmin("dir-dir-bounds");
    const { error } = await client.rpc("list_platform_businesses", { p_dir: "sideways" });
    expect(error).not.toBeNull();
  });

  it("rejects page < 1", async () => {
    const { client } = await createAuthorizedAdmin("dir-page-bounds");
    const { error } = await client.rpc("list_platform_businesses", { p_page: 0 });
    expect(error).not.toBeNull();
  });

  it("rejects page_size over 100", async () => {
    const { client } = await createAuthorizedAdmin("dir-pagesize-bounds");
    const { error } = await client.rpc("list_platform_businesses", { p_page_size: 101 });
    expect(error).not.toBeNull();
  });

  it("paginates with a stable deterministic order and reports total_count", async () => {
    const { client } = await createAuthorizedAdmin("dir-paginate-admin");
    for (const prefix of ["dir-page-a", "dir-page-b", "dir-page-c"]) {
      const { userId } = await createOwnerAndBusiness(prefix);
      cleanupUserIds.push(userId);
    }

    const page1 = await client.rpc("list_platform_businesses", { p_page: 1, p_page_size: 1 });
    expect(page1.error).toBeNull();
    expect(page1.data).toHaveLength(1);
    const total = (page1.data as unknown as { total_count: number }[])[0].total_count;
    expect(total).toBeGreaterThanOrEqual(3);

    const page2 = await client.rpc("list_platform_businesses", { p_page: 2, p_page_size: 1 });
    expect(page2.error).toBeNull();
    expect(page2.data).toHaveLength(1);
    expect((page2.data as unknown as { business_id: string }[])[0].business_id).not.toBe(
      (page1.data as unknown as { business_id: string }[])[0].business_id
    );
  });
});

describe("get_platform_business_detail: shape and not-found", () => {
  it("returns null for a nonexistent business id (never a raw error)", async () => {
    const { client } = await createAuthorizedAdmin("dir-notfound-admin");
    const { data, error } = await client.rpc("get_platform_business_detail", {
      p_business_id: randomUuid(),
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("returns the owner's email, branch/member counts, and nested summaries", async () => {
    const { client } = await createAuthorizedAdmin("dir-detail-shape-admin");
    const { userId, businessId } = await createOwnerAndBusiness("dir-detail-shape-target");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("get_platform_business_detail", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    const detail = data as unknown as {
      business_id: string;
      owner_email: string | null;
      branch_count: number;
      member_count: number;
      branches: unknown[];
      members: unknown[];
    };
    expect(detail.business_id).toBe(businessId);
    expect(detail.owner_email).toBeTruthy();
    expect(detail.branch_count).toBeGreaterThanOrEqual(1);
    expect(detail.member_count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(detail.branches)).toBe(true);
    expect(Array.isArray(detail.members)).toBe(true);
  });
});

describe("RPC EXECUTE ACLs and search_path are narrow and explicit", () => {
  it.each(["list_platform_businesses", "get_platform_business_detail"])(
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

  it.each(["list_platform_businesses", "get_platform_business_detail"])(
    "%s has search_path = ''",
    async (fn) => {
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ proconfig: string[] | null }[]>`
          select proconfig from pg_proc
          where proname = ${fn} and pronamespace = 'public'::regnamespace
        `;
        expect(rows).toHaveLength(1);
        const hasEmptySearchPath = (rows[0].proconfig ?? []).some((entry) =>
          entry.startsWith("search_path=")
        );
        expect(hasEmptySearchPath, fn).toBe(true);
      } finally {
        await sql.end();
      }
    }
  );

  it("private_platform_directory_reader is noinherit/nologin/bypassrls, mirroring private_management_reports_reader", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ rolinherit: boolean; rolcanlogin: boolean; rolbypassrls: boolean }[]>`
        select rolinherit, rolcanlogin, rolbypassrls
        from pg_roles where rolname = 'private_platform_directory_reader'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].rolinherit).toBe(false);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolbypassrls).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
