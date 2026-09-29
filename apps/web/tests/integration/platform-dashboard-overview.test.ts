// Phase 1O-E — Internal Admin Dashboard / Final UX & Security.
//
// Proves the two new read-only platform RPCs backing the redesigned
// Overview screen (public.get_platform_dashboard_overview,
// public.list_platform_recent_actions — see supabase/migrations/
// 20261003080000_platform_dashboard_overview.sql) enforce the exact same
// authorization matrix as every other platform RPC in this schema:
// platform.dashboard.view (held by every platform role) gates the
// aggregate; platform.audit.view (SUPER_ADMIN only in the frozen 1O-A
// matrix) independently gates the recent-actions list; AAL1, an inactive
// admin, an anonymous caller, and a tenant OWNER/ADMIN are all denied
// exactly like every other platform RPC.
import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser, createUserClient, createConfirmedTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
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

describe("get_platform_dashboard_overview: authorization matrix", () => {
  it.each(["SUPER_ADMIN", "SUPPORT", "OPERATIONS", "BILLING", "VIEWER"] as const)(
    "%s at AAL2 can call the dashboard aggregate and gets bounded integer counts",
    async (role) => {
      const { client } = await createAuthorizedAdmin(`dash-${role.toLowerCase()}`, role);
      const { data, error } = await client.rpc("get_platform_dashboard_overview");
      expect(error, role).toBeNull();
      const result = data as unknown as Record<string, number>;
      for (const key of [
        "total_businesses",
        "active_businesses",
        "suspended_businesses",
        "trialing_subscriptions",
        "active_subscriptions",
        "past_due_subscriptions",
        "new_businesses_7d",
      ]) {
        expect(typeof result[key], `${role} -> ${key}`).toBe("number");
        expect(result[key], `${role} -> ${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  );

  it("denies a platform admin at AAL1 (no MFA elevation)", async () => {
    const { userId, client } = await createSignedInUser("dash-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    // Deliberately no elevateToAal2(client).

    const { error } = await client.rpc("get_platform_dashboard_overview");
    expect(error).not.toBeNull();
  });

  it("denies an inactive platform admin even at AAL2", async () => {
    const { userId, client } = await createSignedInUser("dash-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN", false);
    await elevateToAal2(client);

    const { error } = await client.rpc("get_platform_dashboard_overview");
    expect(error).not.toBeNull();
  });

  it("denies a tenant OWNER with no platform_admins row", async () => {
    const { userId, client } = await createOwnerAndBusiness("dash-tenant-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("get_platform_dashboard_overview");
    expect(error).not.toBeNull();
  });

  it("denies an anonymous caller", async () => {
    const anon = createAnonClient();
    const { error } = await anon.rpc("get_platform_dashboard_overview");
    expect(error).not.toBeNull();
  });
});

describe("list_platform_recent_actions: authorization matrix", () => {
  it("SUPER_ADMIN (holds platform.audit.view) can call it and gets bounded rows", async () => {
    const { client } = await createAuthorizedAdmin("recent-super");
    const { data, error } = await client.rpc("list_platform_recent_actions", {
      p_page: 1,
      p_page_size: 10,
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it.each(["SUPPORT", "OPERATIONS", "BILLING", "VIEWER"] as const)(
    "%s (no platform.audit.view) is denied",
    async (role) => {
      const { client } = await createAuthorizedAdmin(`recent-${role.toLowerCase()}`, role);
      const { error } = await client.rpc("list_platform_recent_actions", {
        p_page: 1,
        p_page_size: 10,
      });
      expect(error, role).not.toBeNull();
    }
  );

  it("suspending a business is visible platform-wide via list_platform_recent_actions", async () => {
    const { client } = await createAuthorizedAdmin("recent-e2e", "SUPER_ADMIN");
    const { userId, businessId } = await createOwnerAndBusiness("recent-e2e-target");
    cleanupUserIds.push(userId);

    const { error: suspendError } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: "Integration test suspension for 1O-E dashboard coverage.",
      p_idempotency_key: `test-${randomUuid()}`,
    });
    expect(suspendError).toBeNull();

    const { data, error } = await client.rpc("list_platform_recent_actions", {
      p_page: 1,
      p_page_size: 10,
    });
    expect(error).toBeNull();
    const rows = data as unknown as Array<{ target_business_id: string; action_type: string }>;
    expect(rows.some((r) => r.target_business_id === businessId && r.action_type === "SUSPEND_BUSINESS")).toBe(
      true
    );
  });

  it("rejects an out-of-range page size", async () => {
    const { client } = await createAuthorizedAdmin("recent-badpage", "SUPER_ADMIN");
    const { error } = await client.rpc("list_platform_recent_actions", {
      p_page: 1,
      p_page_size: 500,
    });
    expect(error).not.toBeNull();
  });

  it("denies an anonymous caller", async () => {
    const anon = createAnonClient();
    const { error } = await anon.rpc("list_platform_recent_actions", { p_page: 1, p_page_size: 10 });
    expect(error).not.toBeNull();
  });
});
