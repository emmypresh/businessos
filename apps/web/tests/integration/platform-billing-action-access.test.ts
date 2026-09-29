// Phase 1O-D remediation — Billing action entry-point.
//
// QA found that BILLING holds platform.subscriptions.extend_trial but not
// platform.businesses.view, and the only pre-existing Platform Actions
// surface (the "?tab=actions" tab on
// /internal/admin/businesses/[businessId]) sits behind a page shell gated
// on the latter. This file proves the fix at the database layer:
//
//   - get_platform_business_action_context and
//     list_platform_action_eligible_businesses (20261002080000) are gated
//     on "at least one of the three controlled-action permissions", NEVER
//     on platform.businesses.view — the same permission matrix as the
//     mutation RPCs themselves (SUPER_ADMIN/OPERATIONS/BILLING allowed per
//     their own controlled-action grants; SUPPORT/VIEWER/tenant
//     OWNER/ADMIN/AAL1/inactive-admin denied).
//   - BILLING can call these two new read RPCs successfully.
//   - BILLING is STILL denied get_platform_business_overview (the RPC
//     backing the normal support-console page) — proving
//     platform.businesses.view was never granted to BILLING as a shortcut.
//   - The new RPCs return only minimal fields (business id/name/status/
//     subscription status/trial_ends_at) — never member/branch/activity/
//     audit data.
import { describe, expect, it, afterEach } from "vitest";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, addMemberWithRole, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { elevateToAal2 } from "./helpers/mfa";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSignedInUser(prefix: string) {
  const email = `${unique(prefix)}@example.test`;
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  const { error } = await client.auth.signInWithPassword({ email, password: "Password1234" });
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

describe("get_platform_business_action_context — permission matrix (never gated on platform.businesses.view)", () => {
  it("SUPER_ADMIN at AAL2 can read minimal action context", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-super");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-super-target");
    const { data, error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ business_id: businessId, status: "active" });
  });

  it("OPERATIONS at AAL2 can read minimal action context", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-ops");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "OPERATIONS");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-ops-target");
    const { data, error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ business_id: businessId });
  });

  it("BILLING at AAL2 can read minimal action context despite holding no platform.businesses.view", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-billing");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-billing-target");

    const context = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(context.error, JSON.stringify(context.error)).toBeNull();
    expect(context.data).toMatchObject({ business_id: businessId });

    // Regression: the normal support-console RPC still denies BILLING —
    // platform.businesses.view was never granted as a shortcut.
    const overview = await client.rpc("get_platform_business_overview", {
      p_business_id: businessId,
    });
    expect(overview.error?.message).toContain("insufficient_privilege");
  });

  it("returns only minimal fields — never members/branches/activity/audit", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-shape");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-shape-target");
    const { data } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    const keys = Object.keys(data as Record<string, unknown>).sort();
    expect(keys).toEqual(["business_id", "business_name", "status", "subscription"].sort());
  });

  it("SUPPORT at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-support");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPPORT");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-support-target");
    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("VIEWER at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-viewer");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-viewer-target");
    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a tenant OWNER at AAL2 has zero authority, even for their own business", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("1od-ctx-tenant-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a tenant ADMIN at AAL2 has zero authority", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("1od-ctx-tenant-admin-owner");
    cleanupUserIds.push(ownerUserId);
    const { userId, client } = await createSignedInUser("1od-ctx-tenant-admin");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an active BILLING admin at AAL1 (no MFA this session) is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING");
    // Deliberately no elevateToAal2(client).

    const { businessId } = await createOwnerAndBusiness("1od-ctx-aal1-target");
    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an inactive BILLING admin at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING", false);
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ctx-inactive-target");
    const { error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: businessId,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a nonexistent business resolves to null for an authorized caller — never a raw error", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-missing");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { data, error } = await client.rpc("get_platform_business_action_context", {
      p_business_id: randomUuid(),
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("multi-business isolation: context for business A is independent of business B", async () => {
    const { userId, client } = await createSignedInUser("1od-ctx-multi");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { userId: ownerAUserId, businessId: businessA } = await createOwnerAndBusiness("1od-ctx-multi-a");
    cleanupUserIds.push(ownerAUserId);
    const { userId: ownerBUserId, businessId: businessB } = await createOwnerAndBusiness("1od-ctx-multi-b");
    cleanupUserIds.push(ownerBUserId);

    await client.rpc("platform_suspend_business", {
      p_business_id: businessA,
      p_reason: "Suspending business A only, for isolation proof.",
      p_idempotency_key: randomUuid(),
    });

    const [ctxA, ctxB] = await Promise.all([
      client.rpc("get_platform_business_action_context", { p_business_id: businessA }),
      client.rpc("get_platform_business_action_context", { p_business_id: businessB }),
    ]);
    expect((ctxA.data as { status: string }).status).toBe("suspended");
    expect((ctxB.data as { status: string }).status).toBe("active");
  });
});

describe("list_platform_action_eligible_businesses — permission matrix (never gated on platform.businesses.view)", () => {
  it("BILLING at AAL2 can search by name and finds a matching business", async () => {
    const { userId, client } = await createSignedInUser("1od-list-billing");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING");
    await elevateToAal2(client);

    const businessName = unique("1odlb");
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness(businessName);
    cleanupUserIds.push(ownerUserId);

    const { data, error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: businessName,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error, JSON.stringify(error)).toBeNull();
    const rows = data as Array<{ business_id: string }>;
    expect(rows.some((row) => row.business_id === businessId)).toBe(true);
  });

  it("returns only minimal fields — never members/branches/activity/audit", async () => {
    const { userId, client } = await createSignedInUser("1od-list-shape");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const businessName = unique("1odls");
    const { userId: ownerUserId } = await createOwnerAndBusiness(businessName);
    cleanupUserIds.push(ownerUserId);

    const { data } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: businessName,
      p_page: 1,
      p_page_size: 25,
    });
    const rows = data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const keys = Object.keys(rows[0]).sort();
    expect(keys).toEqual(
      ["business_id", "business_name", "business_status", "subscription_status", "trial_ends_at", "total_count"].sort()
    );
  });

  it("SUPPORT at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-list-support");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPPORT");
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("VIEWER at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-list-viewer");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a tenant OWNER at AAL2 has zero authority", async () => {
    const { userId, client } = await createOwnerAndBusiness("1od-list-tenant-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an active OPERATIONS admin at AAL1 (no MFA this session) is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-list-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "OPERATIONS");

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an inactive OPERATIONS admin at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-list-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "OPERATIONS", false);
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

// Phase 1O-D remediation — data-minimization hardening
// (20261002090000_harden_platform_billing_action_lookup.sql). The suite
// above proves the PERMISSION matrix; this suite proves the lookup can no
// longer be used as a global business directory substitute.
describe("list_platform_action_eligible_businesses — data-minimization hardening", () => {
  it("blank/missing search returns zero rows, never a global business list", async () => {
    const { userId, client } = await createSignedInUser("1od-list-blank");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    // At least one actionable business exists in the DB at this point
    // (every test in this file creates one) — proving a blank search still
    // returns nothing is the actual regression test.
    const { userId: ownerUserId } = await createOwnerAndBusiness(unique("1odlb-exists"));
    cleanupUserIds.push(ownerUserId);

    for (const search of [undefined, "", "   "]) {
      const { data, error } = await client.rpc("list_platform_action_eligible_businesses", {
        p_search: search,
        p_page: 1,
        p_page_size: 25,
      });
      expect(error, JSON.stringify(error)).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("blank search on page 2 still returns zero rows — no enumeration via pagination", async () => {
    const { userId, client } = await createSignedInUser("1od-list-blank-p2");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { data, error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: undefined,
      p_page: 2,
      p_page_size: 25,
    });
    expect(error, JSON.stringify(error)).toBeNull();
    expect(data).toEqual([]);
  });

  it("a search below the 3-character minimum is rejected, never treated as a broad match", async () => {
    const { userId, client } = await createSignedInUser("1od-list-tooshort");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: "ab",
      p_page: 1,
      p_page_size: 25,
    });
    expect(error?.message).toContain("INVALID_SEARCH");
  });

  it("percent and underscore in a search term are treated literally, never as ILIKE wildcards", async () => {
    const { userId, client } = await createSignedInUser("1od-list-wildcard");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const stem = unique("1odlw");
    // Literal target: name contains a literal "_100%" substring.
    const literalName = `${stem}_100%`;
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness(literalName);
    cleanupUserIds.push(ownerUserId);
    // Decoy: would match if `_` and `%` were live wildcards against
    // literalName's own pattern (`_` -> any one char, `%` -> any string),
    // but must NOT match once they are escaped.
    const decoyName = `${stem}Xz100abcdefgh`;
    const { userId: decoyOwnerId, businessId: decoyBusinessId } = await createOwnerAndBusiness(decoyName);
    cleanupUserIds.push(decoyOwnerId);

    // Literal match: exact special characters present in the name.
    const literalSearch = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: literalName,
      p_page: 1,
      p_page_size: 25,
    });
    expect(literalSearch.error, JSON.stringify(literalSearch.error)).toBeNull();
    const literalRows = literalSearch.data as Array<{ business_id: string }>;
    expect(literalRows.some((row) => row.business_id === businessId)).toBe(true);
    expect(literalRows.some((row) => row.business_id === decoyBusinessId)).toBe(false);

    // Searching with the literal pattern must not wildcard-expand and pull
    // in the decoy, which only shares the `stem` prefix.
    const attempt = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: `${stem}_100%`,
      p_page: 1,
      p_page_size: 25,
    });
    expect(attempt.error, JSON.stringify(attempt.error)).toBeNull();
    const attemptRows = (attempt.data as Array<{ business_id: string }>) ?? [];
    expect(attemptRows.some((row) => row.business_id === decoyBusinessId)).toBe(false);
  });

  it("BILLING sees only TRIALING businesses among name matches — ineligible matches are excluded", async () => {
    const { userId, client } = await createSignedInUser("1od-list-billing-eligible");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING");
    await elevateToAal2(client);

    const sharedTerm = unique("1odbeligible");

    // A: eligible — freshly created business is TRIALING by default.
    const { userId: ownerAId, businessId: businessA } = await createOwnerAndBusiness(`${sharedTerm}-a`);
    cleanupUserIds.push(ownerAId);

    // C: matches the search but is NOT eligible for extend_trial (its
    // subscription has been moved out of TRIALING).
    const { userId: ownerCId, businessId: businessC } = await createOwnerAndBusiness(`${sharedTerm}-c`);
    cleanupUserIds.push(ownerCId);
    const sql = createTestDbClient();
    try {
      await sql`update public.business_subscriptions set status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days' where business_id = ${businessC}`;
    } finally {
      await sql.end();
    }

    // B: eligible (TRIALING) but does not match the search term at all.
    const { userId: ownerBId } = await createOwnerAndBusiness(unique("1odbnomatch"));
    cleanupUserIds.push(ownerBId);

    const { data, error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: sharedTerm,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error, JSON.stringify(error)).toBeNull();
    const ids = (data as Array<{ business_id: string }>).map((row) => row.business_id);
    expect(ids).toContain(businessA);
    expect(ids).not.toContain(businessC);
  });

  it("OPERATIONS sees non-archived name matches regardless of subscription state (suspend/reactivate has no subscription gate)", async () => {
    const { userId, client } = await createSignedInUser("1od-list-ops-eligible");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "OPERATIONS");
    await elevateToAal2(client);

    const sharedTerm = unique("1odopseligible");
    const { userId: ownerId, businessId } = await createOwnerAndBusiness(`${sharedTerm}-target`);
    cleanupUserIds.push(ownerId);
    const sql = createTestDbClient();
    try {
      await sql`update public.business_subscriptions set status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days' where business_id = ${businessId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: sharedTerm,
      p_page: 1,
      p_page_size: 25,
    });
    expect(error, JSON.stringify(error)).toBeNull();
    const ids = (data as Array<{ business_id: string }>).map((row) => row.business_id);
    expect(ids).toContain(businessId);
  });

  it("a page size above 50 is rejected — narrower than the shared 100-row support-console bound", async () => {
    const { userId, client } = await createSignedInUser("1od-list-pagesize");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("list_platform_action_eligible_businesses", {
      p_search: unique("1odps"),
      p_page: 1,
      p_page_size: 100,
    });
    expect(error?.message).toContain("INVALID_PAGE_SIZE");
  });
});
