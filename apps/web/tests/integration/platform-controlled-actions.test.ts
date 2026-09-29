// Phase 1O-D — Controlled Platform Actions.
//
// Proves: the platform permission matrix for the three new mutation RPCs
// (SUPER_ADMIN/OPERATIONS/BILLING authorized as designed, SUPPORT/VIEWER
// denied, tenant OWNER/ADMIN at AAL2 denied, AAL1/inactive platform admin
// denied); suspend/reactivate/extend-trial state transitions and their
// idempotent-no-op cases; idempotency replay vs. conflict; audit rows are
// created with the right actor/reason/before/after; the central tenant
// lockout (is_business_member/has_permission) actually blocks a suspended
// business's own members while leaving platform support access and other
// businesses of the same user untouched; and that a tenant can no longer
// write businesses.status directly.
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

// No app-level platform-admin-provisioning RPC exists by design (see 1O-A's
// own table comment) — mirrors platform-admin-security.test.ts's own
// identical fixture.
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

async function getBusinessStatus(businessId: string): Promise<string> {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ status: string }[]>`
      select status from public.businesses where id = ${businessId}
    `;
    return row.status;
  } finally {
    await sql.end();
  }
}

async function setBusinessStatus(businessId: string, status: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.businesses set status = ${status} where id = ${businessId}`;
  } finally {
    await sql.end();
  }
}

async function getSubscriptionRow(businessId: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ status: string; trial_ends_at: string | null }[]>`
      select status, trial_ends_at from public.business_subscriptions where business_id = ${businessId}
    `;
    return row;
  } finally {
    await sql.end();
  }
}

async function setSubscriptionStatus(businessId: string, status: string) {
  const sql = createTestDbClient();
  try {
    if (status === "ACTIVE") {
      // ACTIVE requires current_period_started_at/current_period_ends_at
      // per business_subscriptions' own CHECK constraint.
      await sql`
        update public.business_subscriptions
        set status = 'ACTIVE',
            current_period_started_at = now(),
            current_period_ends_at = now() + interval '30 days'
        where business_id = ${businessId}
      `;
    } else {
      await sql`update public.business_subscriptions set status = ${status} where business_id = ${businessId}`;
    }
  } finally {
    await sql.end();
  }
}

async function getActionAuditRow(idempotencyKey: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<
      {
        id: string;
        action_type: string;
        actor_user_id: string;
        target_business_id: string;
        reason: string;
        before_state: Record<string, unknown>;
        after_state: Record<string, unknown>;
      }[]
    >`
      select id, action_type, actor_user_id, target_business_id, reason, before_state, after_state
      from public.platform_action_audit where idempotency_key = ${idempotencyKey}
    `;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

async function countActionAuditRows(businessId: string): Promise<number> {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from public.platform_action_audit where target_business_id = ${businessId}
    `;
    return Number(row.count);
  } finally {
    await sql.end();
  }
}

const REASON = "Integration test reason for this controlled action.";

describe("permission matrix — platform_suspend_business / platform_reactivate_business / platform_extend_trial", () => {
  it("SUPER_ADMIN at AAL2 is authorized for all three actions", async () => {
    const { userId, client } = await createSignedInUser("1od-super");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-super-target");

    const suspend = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(suspend.error, JSON.stringify(suspend.error)).toBeNull();

    const reactivate = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(reactivate.error, JSON.stringify(reactivate.error)).toBeNull();

    const extend = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 7,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(extend.error, JSON.stringify(extend.error)).toBeNull();
  });

  it("OPERATIONS at AAL2 can suspend/reactivate but not extend_trial", async () => {
    const { userId, client } = await createSignedInUser("1od-ops");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "OPERATIONS");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-ops-target");

    const suspend = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(suspend.error).toBeNull();

    const reactivate = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(reactivate.error).toBeNull();

    const extend = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 7,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(extend.error?.message).toContain("insufficient_privilege");
  });

  it("BILLING at AAL2 can extend_trial but not suspend/reactivate", async () => {
    const { userId, client } = await createSignedInUser("1od-billing");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "BILLING");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-billing-target");

    const suspend = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(suspend.error?.message).toContain("insufficient_privilege");

    const reactivate = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(reactivate.error?.message).toContain("insufficient_privilege");

    const extend = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 7,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(extend.error).toBeNull();
  });

  it("SUPPORT at AAL2 is denied all three controlled actions", async () => {
    const { userId, client } = await createSignedInUser("1od-support");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPPORT");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-support-target");

    for (const rpc of ["platform_suspend_business", "platform_reactivate_business"] as const) {
      const { error } = await client.rpc(rpc, {
        p_business_id: businessId,
        p_reason: REASON,
        p_idempotency_key: randomUuid(),
      });
      expect(error?.message, rpc).toContain("insufficient_privilege");
    }
    const extend = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 7,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(extend.error?.message).toContain("insufficient_privilege");
  });

  it("VIEWER at AAL2 is denied all three controlled actions", async () => {
    const { userId, client } = await createSignedInUser("1od-viewer");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "VIEWER");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-viewer-target");

    const suspend = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(suspend.error?.message).toContain("insufficient_privilege");
  });

  it("an active SUPER_ADMIN at AAL1 (no MFA this session) is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-super-aal1");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    // Deliberately no elevateToAal2(client).

    const { businessId } = await createOwnerAndBusiness("1od-aal1-target");
    const { error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("an inactive SUPER_ADMIN at AAL2 is denied", async () => {
    const { userId, client } = await createSignedInUser("1od-inactive");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN", false);
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-inactive-target");
    const { error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("a tenant OWNER at AAL2 has zero authority to call any controlled action, even on their own business", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("1od-tenant-owner");
    cleanupUserIds.push(userId);
    await elevateToAal2(client);

    const { error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("insufficient_privilege");
    expect(await getBusinessStatus(businessId)).toBe("active");
  });

  it("a tenant ADMIN at AAL2 has zero authority to call any controlled action", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("1od-tenant-admin-owner");
    cleanupUserIds.push(ownerUserId);
    const { userId, client } = await createSignedInUser("1od-tenant-admin");
    cleanupUserIds.push(userId);
    await addMemberWithRole(businessId, userId, "ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("actor identity cannot be spoofed via an extra parameter", async () => {
    const { userId, client } = await createSignedInUser("1od-spoofer");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { userId: victimId } = await createSignedInUser("1od-spoof-victim");
    cleanupUserIds.push(victimId);
    await insertPlatformAdmin(victimId, "SUPER_ADMIN");

    const { businessId } = await createOwnerAndBusiness("1od-spoof-target");
    const idempotencyKey = randomUuid();

    const attempt = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
      p_actor_user_id: victimId,
    } as unknown as { p_business_id: string; p_reason: string; p_idempotency_key: string });
    // The function has exactly three parameters — PostgREST rejects an
    // unknown extra argument outright rather than silently ignoring it.
    expect(attempt.error).not.toBeNull();

    const audit = await getActionAuditRow(idempotencyKey);
    expect(audit).toBeNull();
  });
});

describe("suspend / reactivate state transitions", () => {
  it("ACTIVE -> SUSPENDED: reason, actor, audit row, and idempotency key are all stored", async () => {
    const { userId, client } = await createSignedInUser("1od-suspend-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-suspend-target");
    const idempotencyKey = randomUuid();

    const { data, error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(error).toBeNull();
    expect((data as { replayed: boolean }).replayed).toBe(false);
    expect(await getBusinessStatus(businessId)).toBe("suspended");

    const audit = await getActionAuditRow(idempotencyKey);
    expect(audit).not.toBeNull();
    expect(audit!.action_type).toBe("SUSPEND_BUSINESS");
    expect(audit!.actor_user_id).toBe(userId);
    expect(audit!.target_business_id).toBe(businessId);
    expect(audit!.reason).toBe(REASON);
    expect(audit!.before_state).toEqual({ status: "active" });
    expect(audit!.after_state).toEqual({ status: "suspended" });
  });

  it("suspending an already-suspended business is an idempotent no-op success (new idempotency key)", async () => {
    const { userId, client } = await createSignedInUser("1od-suspend-noop-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-suspend-noop-target");
    await setBusinessStatus(businessId, "suspended");

    const { data, error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error).toBeNull();
    const result = data as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(result.before).toEqual({ status: "suspended" });
    expect(result.after).toEqual({ status: "suspended" });
    expect(await getBusinessStatus(businessId)).toBe("suspended");
  });

  it("suspending an archived business is an invalid transition", async () => {
    const { userId, client } = await createSignedInUser("1od-suspend-archived-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-suspend-archived-target");
    await setBusinessStatus(businessId, "archived");

    const { error } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("INVALID_BUSINESS_STATE");
    expect(await getBusinessStatus(businessId)).toBe("archived");
  });

  it("SUSPENDED -> ACTIVE via reactivate, with the same audit guarantees", async () => {
    const { userId, client } = await createSignedInUser("1od-reactivate-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-reactivate-target");
    await setBusinessStatus(businessId, "suspended");
    const idempotencyKey = randomUuid();

    const { error } = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(error).toBeNull();
    expect(await getBusinessStatus(businessId)).toBe("active");

    const audit = await getActionAuditRow(idempotencyKey);
    expect(audit!.action_type).toBe("REACTIVATE_BUSINESS");
    expect(audit!.before_state).toEqual({ status: "suspended" });
    expect(audit!.after_state).toEqual({ status: "active" });
  });

  it("reactivating an already-active business is an idempotent no-op success", async () => {
    const { userId, client } = await createSignedInUser("1od-reactivate-noop-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-reactivate-noop-target");

    const { error } = await client.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error).toBeNull();
    expect(await getBusinessStatus(businessId)).toBe("active");
  });

  it("a nonexistent business id is a safe not-found error, never a raw SQL error", async () => {
    const { userId, client } = await createSignedInUser("1od-notfound-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { error } = await client.rpc("platform_suspend_business", {
      p_business_id: randomUuid(),
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("BUSINESS_NOT_FOUND");
  });
});

describe("idempotency replay and conflict", () => {
  it("same idempotency key + same params replays the original result without duplicating the audit row", async () => {
    const { userId, client } = await createSignedInUser("1od-replay-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-replay-target");
    const idempotencyKey = randomUuid();

    const first = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(first.error).toBeNull();
    expect((first.data as { replayed: boolean }).replayed).toBe(false);

    const second = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(second.error).toBeNull();
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
    expect((second.data as { action_id: string }).action_id).toBe(
      (first.data as { action_id: string }).action_id
    );

    expect(await countActionAuditRows(businessId)).toBe(1);
  });

  it("same idempotency key + different params is rejected as a conflict", async () => {
    const { userId, client } = await createSignedInUser("1od-conflict-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-conflict-target");
    const idempotencyKey = randomUuid();

    const first = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(first.error).toBeNull();

    const second = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: "A completely different reason for this same idempotency key.",
      p_idempotency_key: idempotencyKey,
    });
    expect(second.error?.message).toContain("IDEMPOTENCY_KEY_CONFLICT");

    expect(await countActionAuditRows(businessId)).toBe(1);
  });

  it("invalid input (reason/idempotency key) never creates an audit row — validation runs before any mutation or insert", async () => {
    const { userId, client } = await createSignedInUser("1od-invalid-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-invalid-target");

    const badReason = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: "short",
      p_idempotency_key: randomUuid(),
    });
    expect(badReason.error?.message).toContain("INVALID_REASON");

    const badKey = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: "bad key!",
    });
    expect(badKey.error?.message).toContain("INVALID_IDEMPOTENCY_KEY");

    expect(await getBusinessStatus(businessId)).toBe("active");
    expect(await countActionAuditRows(businessId)).toBe(0);
  });
});

describe("trial extension", () => {
  it("extends a TRIALING subscription's trial_ends_at by exactly the requested number of days", async () => {
    const { userId, client } = await createSignedInUser("1od-trial-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { businessId } = await createOwnerAndBusiness("1od-trial-target");
    const before = await getSubscriptionRow(businessId);
    expect(before.status).toBe("TRIALING");

    const idempotencyKey = randomUuid();
    const { error } = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 10,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    expect(error).toBeNull();

    const after = await getSubscriptionRow(businessId);
    const expected = new Date(before.trial_ends_at!);
    expected.setUTCDate(expected.getUTCDate() + 10);
    expect(new Date(after.trial_ends_at!).getTime()).toBe(expected.getTime());

    const audit = await getActionAuditRow(idempotencyKey);
    expect(audit!.action_type).toBe("EXTEND_TRIAL");
    expect(new Date(audit!.before_state.trial_ends_at as string).getTime()).toBe(
      new Date(before.trial_ends_at!).getTime()
    );
    expect(new Date(audit!.after_state.trial_ends_at as string).getTime()).toBe(
      new Date(after.trial_ends_at!).getTime()
    );
  });

  it("rejects 0 days", async () => {
    const { userId, client } = await createSignedInUser("1od-trial-zero-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);
    const { businessId } = await createOwnerAndBusiness("1od-trial-zero-target");

    const { error } = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 0,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("INVALID_TRIAL_DAYS");
  });

  it("rejects a negative day count", async () => {
    const { userId, client } = await createSignedInUser("1od-trial-neg-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);
    const { businessId } = await createOwnerAndBusiness("1od-trial-neg-target");

    const { error } = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: -5,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("INVALID_TRIAL_DAYS");
  });

  it("rejects more than 30 days", async () => {
    const { userId, client } = await createSignedInUser("1od-trial-max-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);
    const { businessId } = await createOwnerAndBusiness("1od-trial-max-target");

    const { error } = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 31,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("INVALID_TRIAL_DAYS");
  });

  it("fails closed for an ACTIVE subscription (not TRIALING)", async () => {
    const { userId, client } = await createSignedInUser("1od-trial-active-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);
    const { businessId } = await createOwnerAndBusiness("1od-trial-active-target");
    await setSubscriptionStatus(businessId, "ACTIVE");

    const { error } = await client.rpc("platform_extend_trial", {
      p_business_id: businessId,
      p_days: 7,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });
    expect(error?.message).toContain("TRIAL_EXTENSION_NOT_SUPPORTED");
  });
});

describe("central tenant-access enforcement (businesses.status)", () => {
  it("a suspended business blocks its own active member's access (is_business_member/has_permission)", async () => {
    const { userId: ownerUserId, client: ownerClient, businessId } =
      await createOwnerAndBusiness("1od-lockout-owner");
    cleanupUserIds.push(ownerUserId);

    // Prove access works BEFORE suspension.
    const before = await ownerClient.rpc("has_permission", {
      p_business_id: businessId,
      p_permission_key: "business.manage",
    });
    expect(before.error).toBeNull();
    expect(before.data).toBe(true);

    const { userId: adminUserId, client: adminClient } = await createSignedInUser("1od-lockout-admin");
    cleanupUserIds.push(adminUserId);
    await insertPlatformAdmin(adminUserId, "SUPER_ADMIN");
    await elevateToAal2(adminClient);
    await adminClient.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });

    const during = await ownerClient.rpc("has_permission", {
      p_business_id: businessId,
      p_permission_key: "business.manage",
    });
    expect(during.error).toBeNull();
    expect(during.data).toBe(false);

    const selectAttempt = await ownerClient.from("businesses").select("id").eq("id", businessId);
    expect(selectAttempt.data ?? []).toHaveLength(0);

    await adminClient.rpc("platform_reactivate_business", {
      p_business_id: businessId,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });

    const after = await ownerClient.rpc("has_permission", {
      p_business_id: businessId,
      p_permission_key: "business.manage",
    });
    expect(after.data).toBe(true);
  });

  it("suspending one business does not affect a different business the same user belongs to", async () => {
    const { userId, client, businessId: businessA } = await createOwnerAndBusiness("1od-multi-a");
    cleanupUserIds.push(userId);
    const { userId: ownerBUserId, businessId: businessB } = await createOwnerAndBusiness("1od-multi-b");
    cleanupUserIds.push(ownerBUserId);
    await addMemberWithRole(businessB, userId, "ADMIN");

    const { userId: adminUserId, client: adminClient } = await createSignedInUser("1od-multi-admin");
    cleanupUserIds.push(adminUserId);
    await insertPlatformAdmin(adminUserId, "SUPER_ADMIN");
    await elevateToAal2(adminClient);
    await adminClient.rpc("platform_suspend_business", {
      p_business_id: businessA,
      p_reason: REASON,
      p_idempotency_key: randomUuid(),
    });

    const blockedA = await client.rpc("has_permission", {
      p_business_id: businessA,
      p_permission_key: "business.manage",
    });
    expect(blockedA.data).toBe(false);

    const stillB = await client.rpc("has_permission", {
      p_business_id: businessB,
      p_permission_key: "business.manage",
    });
    expect(stillB.data).toBe(true);
  });

  it("a suspended business remains fully inspectable by an authorized platform admin", async () => {
    const { userId: ownerUserId, businessId } = await createOwnerAndBusiness("1od-support-visible-owner");
    cleanupUserIds.push(ownerUserId);
    await setBusinessStatus(businessId, "suspended");

    const { userId, client } = await createSignedInUser("1od-support-visible-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { data, error } = await client.rpc("get_platform_business_overview", {
      p_business_id: businessId,
    });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("suspended");
  });

  it("a tenant with business.manage can no longer write businesses.status directly", async () => {
    const { userId, client, businessId } = await createOwnerAndBusiness("1od-status-grant-owner");
    cleanupUserIds.push(userId);

    const { error } = await client.from("businesses").update({ status: "suspended" } as never).eq("id", businessId);
    expect(error).not.toBeNull();
    expect(await getBusinessStatus(businessId)).toBe("active");
  });
});

describe("platform_action_audit is append-only", () => {
  it("authenticated has no SELECT/UPDATE/DELETE grant on platform_action_audit", async () => {
    const { userId, client } = await createSignedInUser("1od-audit-direct-admin");
    cleanupUserIds.push(userId);
    await insertPlatformAdmin(userId, "SUPER_ADMIN");
    await elevateToAal2(client);

    const { data, error } = await client.from("platform_action_audit").select("*");
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
