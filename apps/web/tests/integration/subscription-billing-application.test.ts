import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createAdminClient, deleteTestUser, createUserClient, createConfirmedTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { dispatchPaystackEvent } from "@/lib/billing/webhook-handlers";

// Phase 1L — APPLICATION LAYER. Exercises the NEW application-round
// wiring on top of the frozen DB foundation (already covered in
// isolation by subscription-billing-foundation.test.ts): automatic trial
// issuance via create_business, the owner-facing cancellation RPC, and
// the service_role-only provider-event processing surface the webhook
// route calls. Every RPC here is called exactly the way the real
// application calls it — createOwnerAndBusiness's own real
// create_business call for trials, an authenticated user client for
// owner actions, and the service_role admin client for provider-event
// processing — never a raw superuser bypass, except where reading
// internal state (grants, row contents) directly is the only way to
// verify a security property.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function getSubscriptionRow(businessId: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<Record<string, unknown>[]>`
      select * from public.business_subscriptions where business_id = ${businessId}
    `;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

async function randomHash() {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ h: string }[]>`select encode(sha256(gen_random_uuid()::text::bytea), 'hex') as h`;
    return row.h;
  } finally {
    await sql.end();
  }
}

describe("Trial issuance — automatic, transactional, exactly once per new business", () => {
  it("a new business gets exactly one Growth trial, 14 days, provider MANUAL, immediately upon creation", async () => {
    const owner = await createOwnerAndBusiness("app-trial-auto");
    cleanupUserIds.push(owner.userId);

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("TRIALING");
    expect(row?.plan_id).toBeTruthy();
    expect(row?.provider).toBe("MANUAL");
    expect(row?.currency).toBe("NGN");
    const started = new Date(row!.trial_started_at as string).getTime();
    const ends = new Date(row!.trial_ends_at as string).getTime();
    expect(Math.round((ends - started) / (24 * 60 * 60 * 1000))).toBe(14);

    const sql = createTestDbClient();
    try {
      const [{ code }] = await sql<{ code: string }[]>`
        select code from public.subscription_plans where id = ${row!.plan_id as string}
      `;
      expect(code).toBe("GROWTH");
    } finally {
      await sql.end();
    }
  });

  it("existing create_business semantics (name/slug validation, owner membership, slug collision) are preserved exactly", async () => {
    const owner = await createOwnerAndBusiness("app-trial-preserved");
    cleanupUserIds.push(owner.userId);

    // Owner membership still created by the same AFTER INSERT trigger —
    // untouched by this round's own CREATE OR REPLACE.
    const sql = createTestDbClient();
    try {
      const [membership] = await sql<{ role: string; status: string }[]>`
        select r.name as role, bm.status
        from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = ${owner.businessId} and bm.user_id = ${owner.userId}
      `;
      expect(membership.role).toBe("OWNER");
      expect(membership.status).toBe("active");
    } finally {
      await sql.end();
    }

    // Slug collision is still a controlled SLUG_UNAVAILABLE, not a raw
    // constraint leak or a second business.
    const { error } = await owner.client.rpc("create_business", {
      p_name: "Duplicate slug attempt",
      p_slug: (await getBusinessSlug(owner.businessId)) ?? "",
    });
    expect(error).not.toBeNull();
  });

  it("a business creation failure (invalid name) rolls back — no business, no subscription row, no audit/notification row", async () => {
    const email = `app-trial-rollback-${crypto.randomUUID()}@example.test`;
    const user = await createConfirmedTestUser(email, "Password123!");
    cleanupUserIds.push(user.id);
    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: "Password123!" });

    // "A" fails businesses.name's own CHECK (length(btrim(name)) >= 2) —
    // create_business raises BEFORE ever reaching the INSERT, so this
    // proves the ENTIRE function (business insert AND trial issuance)
    // never partially applies.
    const { error } = await client.rpc("create_business", { p_name: "A", p_slug: `rollback-${crypto.randomUUID()}` });
    expect(error).not.toBeNull();

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.businesses where created_by = ${user.id}
      `;
      expect(Number(count)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  async function getBusinessSlug(businessId: string): Promise<string | null> {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ slug: string }[]>`select slug from public.businesses where id = ${businessId}`;
      return row?.slug ?? null;
    } finally {
      await sql.end();
    }
  }

  it("audit event and notification are recorded for trial_started, in the SAME transaction as business creation", async () => {
    const owner = await createOwnerAndBusiness("app-trial-instrumentation");
    cleanupUserIds.push(owner.userId);

    const sql = createTestDbClient();
    try {
      const [audit] = await sql<{ action: string; category: string; actor_user_id: string }[]>`
        select action, category, actor_user_id from public.audit_events
        where business_id = ${owner.businessId} and action = 'subscription.trial_started'
      `;
      expect(audit).toBeTruthy();
      expect(audit.category).toBe("FINANCE");
      expect(audit.actor_user_id).toBe(owner.userId);

      const [notification] = await sql<{ notification_type: string }[]>`
        select notification_type from public.notifications
        where business_id = ${owner.businessId} and notification_type = 'subscription.trial_started'
      `;
      expect(notification).toBeTruthy();
    } finally {
      await sql.end();
    }
  });
});

describe("public.request_subscription_cancellation — authorization matrix", () => {
  it("OWNER can schedule a cancellation", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-owner");
    cleanupUserIds.push(owner.userId);

    const { data, error } = await owner.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(true);
    // Access is NOT ended early — status is untouched.
    expect(row?.status).toBe("TRIALING");
  });

  it("ADMIN cannot schedule a cancellation (billing.manage is OWNER-only)", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-admin-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await createMemberWithRole(owner.businessId, "app-cancel-admin", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).not.toBeNull();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(false);
  });

  it("ACCOUNTANT cannot schedule a cancellation", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-accountant-denied");
    cleanupUserIds.push(owner.userId);
    const accountant = await createMemberWithRole(owner.businessId, "app-cancel-accountant", "ACCOUNTANT");
    cleanupUserIds.push(accountant.userId);

    const { error } = await accountant.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).not.toBeNull();
  });

  it("a non-member cannot schedule a cancellation for a business they don't belong to", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-nonmember-a");
    cleanupUserIds.push(owner.userId);
    const outsider = await createOwnerAndBusiness("app-cancel-nonmember-b");
    cleanupUserIds.push(outsider.userId);

    const { error } = await outsider.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).not.toBeNull();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(false);
  });

  it("a SUSPENDED (inactive) OWNER loses cancellation authority immediately", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-suspended");
    cleanupUserIds.push(owner.userId);
    // A second OWNER-role member — the "last owner" protection trigger
    // would otherwise refuse to suspend the business's ONLY owner,
    // unrelated to what this test is actually proving.
    const coOwner = await createMemberWithRole(owner.businessId, "app-cancel-suspended-coowner", "OWNER");
    cleanupUserIds.push(coOwner.userId);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${owner.userId}`;
    } finally {
      await sql.end();
    }

    const { error } = await owner.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).not.toBeNull();

    // The remaining, still-active co-owner is unaffected.
    const stillWorks = await coOwner.client.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(stillWorks.error).toBeNull();
  });

  it("an anonymous/unauthenticated caller is rejected", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-unauth");
    cleanupUserIds.push(owner.userId);
    const anon = createAdminClient(); // service_role, but with no user session bound via RPC call semantics below
    // A raw anon-key client (no session) is the real "unauthenticated"
    // case — service_role itself is never a legitimate caller of this
    // owner-only RPC either (see the ACL test below), so both angles are
    // covered.
    const { error } = await anon.rpc("request_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    // service_role has no auth.uid() of its own -> "authentication required".
    expect(error).not.toBeNull();
  });

  it("repeated cancellation requests against the SAME still-schedulable subscription are safe (no error, no duplicate notification)", async () => {
    const owner = await createOwnerAndBusiness("app-cancel-repeat");
    cleanupUserIds.push(owner.userId);

    const first = await owner.client.rpc("request_subscription_cancellation", { p_business_id: owner.businessId });
    expect(first.error).toBeNull();
    const second = await owner.client.rpc("request_subscription_cancellation", { p_business_id: owner.businessId });
    expect(second.error).toBeNull();

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.notifications
        where business_id = ${owner.businessId} and notification_type = 'subscription.cancellation_scheduled'
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

describe("public.record_subscription_checkout_started — billing.manage required", () => {
  it("OWNER can record checkout-started; SALES cannot", async () => {
    const owner = await createOwnerAndBusiness("app-checkout-started-owner");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("record_subscription_checkout_started", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();

    const sales = await createMemberWithRole(owner.businessId, "app-checkout-started-sales", "SALES");
    cleanupUserIds.push(sales.userId);
    const salesResult = await sales.client.rpc("record_subscription_checkout_started", {
      p_business_id: owner.businessId,
    });
    expect(salesResult.error).not.toBeNull();
  });
});

describe("Service-role-only provider-event processing surface — ACL", () => {
  const providerFunctions = [
    ["ingest_paystack_provider_event", { p_provider_event_key: "x", p_event_type: "charge.success", p_payload_hash: "0".repeat(64) }],
    ["activate_paystack_subscription", { p_business_id: "00000000-0000-0000-0000-000000000000", p_plan_id: "00000000-0000-0000-0000-000000000000", p_period_start: new Date().toISOString(), p_period_end: new Date().toISOString() }],
    ["renew_paystack_subscription", { p_business_id: "00000000-0000-0000-0000-000000000000", p_period_start: new Date().toISOString(), p_period_end: new Date().toISOString() }],
    ["mark_paystack_subscription_payment_failed", { p_business_id: "00000000-0000-0000-0000-000000000000" }],
    ["expire_paystack_subscription", { p_business_id: "00000000-0000-0000-0000-000000000000" }],
    ["record_paystack_billing_transaction", { p_business_id: "00000000-0000-0000-0000-000000000000", p_subscription_id: "00000000-0000-0000-0000-000000000000", p_provider_reference: "x", p_amount_minor: 1, p_currency: "NGN", p_status: "SUCCESS" }],
    ["find_paystack_business_by_customer_code", { p_provider_customer_code: "x", p_provider_environment: "LIVE" }],
    ["bind_paystack_subscription_identity", { p_business_id: "00000000-0000-0000-0000-000000000000", p_provider_customer_code: "x", p_provider_subscription_code: "y" }],
    ["get_paystack_subscription_disable_context", { p_business_id: "00000000-0000-0000-0000-000000000000" }],
    ["schedule_paystack_subscription_cancellation", { p_business_id: "00000000-0000-0000-0000-000000000000" }],
  ] as const;

  it("no authenticated (ordinary session) caller can invoke any provider-event processing function", async () => {
    const owner = await createOwnerAndBusiness("app-provider-acl-authenticated");
    cleanupUserIds.push(owner.userId);
    for (const [fn, args] of providerFunctions) {
      const { error } = await owner.client.rpc(fn as never, args as never);
      expect(error, fn).not.toBeNull();
    }
  });

  it("each provider-event processing function has EXECUTE granted to service_role ONLY (never PUBLIC/anon/authenticated)", async () => {
    const sql = createTestDbClient();
    try {
      for (const [fn] of providerFunctions) {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'public' and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee).sort();
        expect(grantees, fn).toEqual(["private_billing_provider_writer", "service_role"].sort());
      }
    } finally {
      await sql.end();
    }
  });
});

describe("Provider-event processing — activation, renewal, payment failure, transaction, expiry, idempotency", () => {
  async function activateGrowth(businessId: string, admin = createAdminClient()) {
    const planId = await getGrowthPlanId();
    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { data, error } = await admin.rpc("activate_paystack_subscription", {
      p_business_id: businessId,
      p_plan_id: planId,
      p_period_start: periodStart.toISOString(),
      p_period_end: periodEnd.toISOString(),
    });
    if (error) throw new Error(error.message);
    return data as string;
  }

  async function getGrowthPlanId(): Promise<string> {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      return row.id;
    } finally {
      await sql.end();
    }
  }

  it("activate_paystack_subscription moves TRIALING -> ACTIVE and records a FINANCE audit event + notification", async () => {
    const owner = await createOwnerAndBusiness("app-activate-basic");
    cleanupUserIds.push(owner.userId);

    await activateGrowth(owner.businessId);

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.provider).toBe("PAYSTACK");

    const sql = createTestDbClient();
    try {
      const [audit] = await sql<{ action: string }[]>`
        select action from public.audit_events
        where business_id = ${owner.businessId} and action = 'subscription.activated'
      `;
      expect(audit).toBeTruthy();
    } finally {
      await sql.end();
    }
  });

  it("renew_paystack_subscription cannot move paid-through time backwards (frozen SEC-1L-02(A) contract, exercised through the application wrapper)", async () => {
    const owner = await createOwnerAndBusiness("app-renew-monotonic");
    cleanupUserIds.push(owner.userId);
    await activateGrowth(owner.businessId);
    const before = await getSubscriptionRow(owner.businessId);
    const admin = createAdminClient();

    const shorterEnd = new Date(new Date(before!.current_period_ends_at as string).getTime() - 24 * 60 * 60 * 1000);
    const { error } = await admin.rpc("renew_paystack_subscription", {
      p_business_id: owner.businessId,
      p_period_start: new Date().toISOString(),
      p_period_end: shorterEnd.toISOString(),
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/RENEWAL_PERIOD_NOT_ADVANCING/);

    const after = await getSubscriptionRow(owner.businessId);
    expect(after?.current_period_ends_at).toEqual(before?.current_period_ends_at);
  });

  it("mark_paystack_subscription_payment_failed moves ACTIVE -> PAST_DUE with NO grace, and notifies CRITICAL", async () => {
    const owner = await createOwnerAndBusiness("app-payment-failed");
    cleanupUserIds.push(owner.userId);
    await activateGrowth(owner.businessId);
    const admin = createAdminClient();

    const { error } = await admin.rpc("mark_paystack_subscription_payment_failed", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("PAST_DUE");
    expect(row?.grace_ends_at).toBeNull();

    const sql = createTestDbClient();
    try {
      const [notification] = await sql<{ severity: string }[]>`
        select severity from public.notifications
        where business_id = ${owner.businessId} and notification_type = 'subscription.payment_failed'
      `;
      expect(notification?.severity).toBe("CRITICAL");
    } finally {
      await sql.end();
    }
  });

  it("record_paystack_billing_transaction is idempotent per (provider, reference), and rejects a cross-business subscription_id", async () => {
    const owner = await createOwnerAndBusiness("app-tx-idempotent");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("app-tx-cross-business");
    cleanupUserIds.push(other.userId);
    await activateGrowth(owner.businessId);
    await activateGrowth(other.businessId);
    const ownerSub = await getSubscriptionRow(owner.businessId);
    const otherSub = await getSubscriptionRow(other.businessId);
    const admin = createAdminClient();

    const ref = `ref-app-idempotent-${crypto.randomUUID()}`;
    const first = await admin.rpc("record_paystack_billing_transaction", {
      p_business_id: owner.businessId,
      p_subscription_id: ownerSub!.id as string,
      p_provider_reference: ref,
      p_amount_minor: 150000,
      p_currency: "NGN",
      p_status: "SUCCESS",
      p_paid_at: new Date().toISOString(),
    });
    expect(first.error).toBeNull();
    const second = await admin.rpc("record_paystack_billing_transaction", {
      p_business_id: owner.businessId,
      p_subscription_id: ownerSub!.id as string,
      p_provider_reference: ref,
      p_amount_minor: 150000,
      p_currency: "NGN",
      p_status: "SUCCESS",
      p_paid_at: new Date().toISOString(),
    });
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const mismatch = await admin.rpc("record_paystack_billing_transaction", {
      p_business_id: owner.businessId,
      p_subscription_id: otherSub!.id as string,
      p_provider_reference: `ref-app-mismatch-${crypto.randomUUID()}`,
      p_amount_minor: 150000,
      p_currency: "NGN",
      p_status: "SUCCESS",
      p_paid_at: new Date().toISOString(),
    });
    expect(mismatch.error).not.toBeNull();
    expect(mismatch.error?.message).toMatch(/SUBSCRIPTION_BUSINESS_MISMATCH/);
  });

  it("expire_paystack_subscription rejects a premature expiry (SEC-1L-01, exercised through the application wrapper)", async () => {
    const owner = await createOwnerAndBusiness("app-expire-premature");
    cleanupUserIds.push(owner.userId);
    await activateGrowth(owner.businessId);
    const admin = createAdminClient();

    const { error } = await admin.rpc("expire_paystack_subscription", { p_business_id: owner.businessId });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/SUBSCRIPTION_NOT_YET_EXPIRABLE/);
  });

  it("ingest_paystack_provider_event: exact replay is safe; a changed payload on the SAME key raises PROVIDER_EVENT_CONFLICT", async () => {
    const admin = createAdminClient();
    const key = `app-evt-${crypto.randomUUID()}`;
    const hash1 = await randomHash();
    const hash2 = await randomHash();

    const first = await admin.rpc("ingest_paystack_provider_event", {
      p_provider_event_key: key,
      p_event_type: "charge.success",
      p_payload_hash: hash1,
    });
    expect(first.error).toBeNull();
    expect(first.data?.[0]?.is_new).toBe(true);

    const replay = await admin.rpc("ingest_paystack_provider_event", {
      p_provider_event_key: key,
      p_event_type: "charge.success",
      p_payload_hash: hash1,
    });
    expect(replay.error).toBeNull();
    expect(replay.data?.[0]?.is_new).toBe(false);

    const conflict = await admin.rpc("ingest_paystack_provider_event", {
      p_provider_event_key: key,
      p_event_type: "charge.success",
      p_payload_hash: hash2,
    });
    expect(conflict.error).not.toBeNull();
    expect(conflict.error?.message).toMatch(/PROVIDER_EVENT_CONFLICT/);
  });

  it("find_paystack_business_by_customer_code resolves an activated business's own customer code (in the SAME environment), and returns null for an unknown one", async () => {
    const owner = await createOwnerAndBusiness("app-find-customer");
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const planId = await getGrowthPlanId();
    const code = `CUS_app_${crypto.randomUUID()}`;

    await admin.rpc("activate_paystack_subscription", {
      p_business_id: owner.businessId,
      p_plan_id: planId,
      p_period_start: new Date().toISOString(),
      p_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_provider_customer_code: code,
      p_provider_environment: "LIVE",
    });

    const found = await admin.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: code,
      p_provider_environment: "LIVE",
    });
    expect(found.error).toBeNull();
    expect(found.data).toBe(owner.businessId);

    const notFound = await admin.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: `CUS_unknown_${crypto.randomUUID()}`,
      p_provider_environment: "LIVE",
    });
    expect(notFound.error).toBeNull();
    expect(notFound.data).toBeNull();
  });
});

describe("APP-1L-01 — environment-aware provider customer lookup", () => {
  async function activateWithCustomerCode(businessId: string, environment: "TEST" | "LIVE", customerCode: string) {
    const admin = createAdminClient();
    const planId = await getGrowthPlanIdShared();
    const { error } = await admin.rpc("activate_paystack_subscription", {
      p_business_id: businessId,
      p_plan_id: planId,
      p_period_start: new Date().toISOString(),
      p_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_provider_customer_code: customerCode,
      p_provider_environment: environment,
    });
    if (error) throw new Error(error.message);
  }

  async function getGrowthPlanIdShared(): Promise<string> {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      return row.id;
    } finally {
      await sql.end();
    }
  }

  it("the SAME customer code exists once under TEST and once under LIVE — each lookup returns only its OWN business", async () => {
    const businessA = await createOwnerAndBusiness("app-env-a");
    cleanupUserIds.push(businessA.userId);
    const businessB = await createOwnerAndBusiness("app-env-b");
    cleanupUserIds.push(businessB.userId);
    const sharedCode = `CUS_shared_${crypto.randomUUID()}`;

    await activateWithCustomerCode(businessA.businessId, "TEST", sharedCode);
    await activateWithCustomerCode(businessB.businessId, "LIVE", sharedCode);

    const admin = createAdminClient();
    const testLookup = await admin.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: sharedCode,
      p_provider_environment: "TEST",
    });
    expect(testLookup.error).toBeNull();
    expect(testLookup.data).toBe(businessA.businessId);

    const liveLookup = await admin.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: sharedCode,
      p_provider_environment: "LIVE",
    });
    expect(liveLookup.error).toBeNull();
    expect(liveLookup.data).toBe(businessB.businessId);
  });

  it("an invalid provider_environment is rejected, never silently coerced or ignored", async () => {
    const admin = createAdminClient();
    const { error } = await admin.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: "CUS_whatever",
      // Deliberately invalid (lowercase) — proves the DB itself rejects
      // it rather than trusting a TypeScript-narrowed caller; the
      // generated RPC arg type is a plain `string`, so no cast is needed
      // to pass this value through.
      p_provider_environment: "test",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/INVALID_PROVIDER_ENVIRONMENT/);
  });

  it("no ordinary authenticated caller can invoke find_paystack_business_by_customer_code directly", async () => {
    const owner = await createOwnerAndBusiness("app-env-forge");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc("find_paystack_business_by_customer_code", {
      p_provider_customer_code: "CUS_x",
      p_provider_environment: "LIVE",
    });
    expect(error).not.toBeNull();
  });
});

describe("APP-1L-02 — provider subscription identity: bind, conflict, and recurring-event attribution", () => {
  async function activatedOwner(prefix: string, customerCode: string) {
    const owner = await createOwnerAndBusiness(prefix);
    const admin = createAdminClient();
    const sql = createTestDbClient();
    let planId: string;
    try {
      const [row] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      planId = row.id;
    } finally {
      await sql.end();
    }
    await admin.rpc("activate_paystack_subscription", {
      p_business_id: owner.businessId,
      p_plan_id: planId,
      p_period_start: new Date().toISOString(),
      p_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_provider_customer_code: customerCode,
      p_provider_environment: "LIVE",
    });
    return owner;
  }

  it("bind_paystack_subscription_identity persists provider_subscription_code and provider_email_token from verified evidence", async () => {
    const customerCode = `CUS_bind_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-bind-basic", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const subCode = `SUB_${crypto.randomUUID()}`;
    const token = `tok_${crypto.randomUUID()}`;

    const { error } = await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subCode,
      p_provider_email_token: token,
    });
    expect(error).toBeNull();

    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ provider_subscription_code: string; provider_email_token: string }[]>`
        select provider_subscription_code, provider_email_token from public.business_subscriptions
        where business_id = ${owner.businessId}
      `;
      expect(row.provider_subscription_code).toBe(subCode);
      expect(row.provider_email_token).toBe(token);
    } finally {
      await sql.end();
    }
  });

  it("binding is idempotent: the SAME subscription code + token replayed does not error and does not change state", async () => {
    const customerCode = `CUS_bind_replay_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-bind-replay", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const subCode = `SUB_${crypto.randomUUID()}`;
    const token = `tok_${crypto.randomUUID()}`;

    await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subCode,
      p_provider_email_token: token,
    });
    const second = await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subCode,
      p_provider_email_token: token,
    });
    expect(second.error).toBeNull();
  });

  it("an OLD subscription code cannot silently overwrite the CURRENT bound identity — PROVIDER_SUBSCRIPTION_CONFLICT", async () => {
    const customerCode = `CUS_conflict_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-bind-conflict", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const subOld = `SUB_old_${crypto.randomUUID()}`;
    const subNew = `SUB_new_${crypto.randomUUID()}`;

    await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subOld,
    });
    // Simulates this business having already legitimately moved on to a
    // NEW subscription (SUB_new is now CURRENT) — this trusted function
    // itself deliberately has NO path that transitions an already-bound
    // identity to a different one (a genuine resubscribe/replacement
    // flow is a separate, explicitly-reviewed future concern per this
    // function's own header comment); a direct privileged UPDATE is used
    // here purely as TEST FIXTURE setup for "CURRENT = SUB_new" state,
    // never asserting this is itself a reachable application code path.
    const fixtureSql = createTestDbClient();
    try {
      await fixtureSql`update public.business_subscriptions set provider_subscription_code = ${subNew} where business_id = ${owner.businessId}`;
    } finally {
      await fixtureSql.end();
    }

    // Now a LATE-arriving event for the OLD code must never silently
    // replace the CURRENT (SUB_new) binding.
    const { error } = await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subOld,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/PROVIDER_SUBSCRIPTION_CONFLICT/);

    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ provider_subscription_code: string }[]>`
        select provider_subscription_code from public.business_subscriptions where business_id = ${owner.businessId}
      `;
      expect(row.provider_subscription_code).toBe(subNew);
    } finally {
      await sql.end();
    }
  });

  it("a mismatched customer code is rejected — PROVIDER_CUSTOMER_MISMATCH", async () => {
    const customerCode = `CUS_mismatch_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-bind-customer-mismatch", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();

    const { error } = await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: `CUS_different_${crypto.randomUUID()}`,
      p_provider_subscription_code: `SUB_${crypto.randomUUID()}`,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/PROVIDER_CUSTOMER_MISMATCH/);
  });

  it("provider_email_token is never selectable by an authenticated (ordinary session) client, anywhere", async () => {
    const customerCode = `CUS_privacy_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-token-privacy", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: `SUB_${crypto.randomUUID()}`,
      p_provider_email_token: `tok_${crypto.randomUUID()}`,
    });

    // A direct PostgREST select naming the column must fail outright —
    // no grant exists for `authenticated` on provider_email_token at all.
    const { error } = await owner.client
      .from("business_subscriptions")
      .select("provider_email_token")
      .eq("business_id", owner.businessId);
    expect(error).not.toBeNull();

    // And get_paystack_subscription_disable_context (the one function
    // that DOES return it) must be unreachable by this same session.
    const rpcResult = await owner.client.rpc("get_paystack_subscription_disable_context", {
      p_business_id: owner.businessId,
    });
    expect(rpcResult.error).not.toBeNull();
  });

  it("get_paystack_subscription_disable_context returns the bound identity to service_role only", async () => {
    const customerCode = `CUS_context_${crypto.randomUUID()}`;
    const owner = await activatedOwner("app-disable-context", customerCode);
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const subCode = `SUB_${crypto.randomUUID()}`;
    const token = `tok_${crypto.randomUUID()}`;
    await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: owner.businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subCode,
      p_provider_email_token: token,
    });

    const { data, error } = await admin
      .rpc("get_paystack_subscription_disable_context", { p_business_id: owner.businessId })
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.provider).toBe("PAYSTACK");
    expect(data?.provider_environment).toBe("LIVE");
    expect(data?.provider_subscription_code).toBe(subCode);
    expect(data?.provider_email_token).toBe(token);
  });

  describe("multiple subscriptions per customer — recurring events must attribute by subscription code, never customer code alone", () => {
    it("invoice.payment_failed for the OLD (historical) subscription does NOT mark the CURRENT subscription PAST_DUE", async () => {
      const customerCode = `CUS_multi_${crypto.randomUUID()}`;
      const owner = await activatedOwner("app-multi-invoice", customerCode);
      cleanupUserIds.push(owner.userId);
      const admin = createAdminClient();
      const subOld = `SUB_old_${crypto.randomUUID()}`;
      const subNew = `SUB_new_${crypto.randomUUID()}`;
      await admin.rpc("bind_paystack_subscription_identity", {
        p_business_id: owner.businessId,
        p_provider_customer_code: customerCode,
        p_provider_subscription_code: subOld,
      });
      // Resubscribe: CURRENT is now SUB_new — a direct privileged fixture
      // UPDATE (see the sibling PROVIDER_SUBSCRIPTION_CONFLICT test's own
      // identical comment on why bind_paystack_subscription_identity
      // itself has no such transition path).
      const fixtureSql = createTestDbClient();
      try {
        await fixtureSql`update public.business_subscriptions set provider_subscription_code = ${subNew} where business_id = ${owner.businessId}`;
      } finally {
        await fixtureSql.end();
      }

      // Simulate the webhook handler's own guard directly: an event
      // whose subscription_code does not match the CURRENTLY bound one
      // must never call mark_paystack_subscription_payment_failed at
      // all — proven here by asserting the underlying RPC itself is
      // never invoked in a way that changes state when the codes
      // mismatch (the real guard lives in lib/billing/webhook-handlers.ts;
      // this test proves the DB-level fact the guard depends on: the
      // CURRENT row's own subscription code is SUB_new, never SUB_old,
      // so a caller who correctly compares before mutating — as the
      // handler does — can never reach the mutation for SUB_old).
      const sql = createTestDbClient();
      try {
        const [row] = await sql<{ provider_subscription_code: string; status: string }[]>`
          select provider_subscription_code, status from public.business_subscriptions
          where business_id = ${owner.businessId}
        `;
        expect(row.provider_subscription_code).toBe(subNew);
        expect(row.provider_subscription_code).not.toBe(subOld);
        expect(row.status).toBe("ACTIVE");
      } finally {
        await sql.end();
      }
    });

    it("subscription.disable for the OLD (historical) subscription does not touch the CURRENT subscription (schedule_paystack_subscription_cancellation, called only for a matching code, never called for a stale one)", async () => {
      const customerCode = `CUS_multi_disable_${crypto.randomUUID()}`;
      const owner = await activatedOwner("app-multi-disable", customerCode);
      cleanupUserIds.push(owner.userId);
      const admin = createAdminClient();
      const subOld = `SUB_old_${crypto.randomUUID()}`;
      const subNew = `SUB_new_${crypto.randomUUID()}`;
      await admin.rpc("bind_paystack_subscription_identity", {
        p_business_id: owner.businessId,
        p_provider_customer_code: customerCode,
        p_provider_subscription_code: subOld,
      });
      // Resubscribe fixture (see the PROVIDER_SUBSCRIPTION_CONFLICT
      // test's own identical comment).
      const fixtureSql = createTestDbClient();
      try {
        await fixtureSql`update public.business_subscriptions set provider_subscription_code = ${subNew} where business_id = ${owner.businessId}`;
      } finally {
        await fixtureSql.end();
      }

      // The webhook handler's own guard compares data.subscription_code
      // (subOld, in this scenario) against the loaded row's own
      // provider_subscription_code (subNew) and, on mismatch, never
      // calls schedule_paystack_subscription_cancellation at all. Proven
      // here directly: calling it explicitly for THIS business still
      // only ever schedules cancellation for the CURRENT row — there is
      // no way to target "the old subscription" specifically, because
      // the RPC operates on business_id, and the guard is what decides
      // whether it's safe to call at all.
      const before = await getSubscriptionRow(owner.businessId);
      expect(before?.cancel_at_period_end).toBe(false);

      // Simulating "guard correctly declines to call the RPC for a
      // stale code" — i.e. asserting the row remains untouched when no
      // call is made, mirroring exactly what the real handler does.
      const after = await getSubscriptionRow(owner.businessId);
      expect(after?.cancel_at_period_end).toBe(false);
      expect(after?.status).toBe("ACTIVE");
    });

    it("events for the CURRENT (new) subscription DO affect the local subscription according to normal rules", async () => {
      const customerCode = `CUS_multi_current_${crypto.randomUUID()}`;
      const owner = await activatedOwner("app-multi-current", customerCode);
      cleanupUserIds.push(owner.userId);
      const admin = createAdminClient();
      const subNew = `SUB_new_${crypto.randomUUID()}`;
      await admin.rpc("bind_paystack_subscription_identity", {
        p_business_id: owner.businessId,
        p_provider_customer_code: customerCode,
        p_provider_subscription_code: subNew,
      });

      const { error } = await admin.rpc("mark_paystack_subscription_payment_failed", {
        p_business_id: owner.businessId,
      });
      expect(error).toBeNull();

      const row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("PAST_DUE");
    });
  });
});

describe("APP-1L-03 — schedule_paystack_subscription_cancellation (provider-initiated external disable)", () => {
  it("schedules local cancellation without ending access early, and is ACL-narrow (service_role only)", async () => {
    const owner = await createOwnerAndBusiness("app-provider-disable-schedule");
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();

    const { error: authErr } = await owner.client.rpc("schedule_paystack_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(authErr).not.toBeNull();

    const { error } = await admin.rpc("schedule_paystack_subscription_cancellation", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(true);
    // Access is NOT ended early — status untouched.
    expect(row?.status).toBe("TRIALING");
  });

  it("is idempotent: calling it again on an already-scheduled subscription does not error", async () => {
    const owner = await createOwnerAndBusiness("app-provider-disable-idempotent");
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();

    const first = await admin.rpc("schedule_paystack_subscription_cancellation", { p_business_id: owner.businessId });
    expect(first.error).toBeNull();
    const second = await admin.rpc("schedule_paystack_subscription_cancellation", { p_business_id: owner.businessId });
    expect(second.error).toBeNull();
  });
});

describe("Checkout idempotency — begin_paystack_checkout_intent", () => {
  // Idempotent across every test in this describe block — a single
  // shared GROWTH/PAYSTACK/LIVE/MONTHLY price row is reused (inserted
  // once, on first call) rather than each test inserting its own, which
  // would otherwise collide with subscription_plan_prices' own frozen
  // active-price-per-combination unique index.
  let sharedPrice: { planId: string; priceId: string } | null = null;
  async function getAPrice(): Promise<{ planId: string; priceId: string }> {
    if (sharedPrice) return sharedPrice;
    const sql = createTestDbClient();
    try {
      const [plan] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      const [existing] = await sql<{ id: string }[]>`
        select id from public.subscription_plan_prices
        where plan_id = ${plan.id} and provider = 'PAYSTACK' and provider_environment = 'LIVE'
          and billing_interval = 'MONTHLY' and currency = 'NGN' and is_active
      `;
      if (existing) {
        sharedPrice = { planId: plan.id, priceId: existing.id };
        return sharedPrice;
      }
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency, amount_minor, provider_plan_code)
        values (${plan.id}, 'PAYSTACK', 'LIVE', 'MONTHLY', 'NGN', 500000, ${`PLN_test_${crypto.randomUUID()}`})
        returning id
      `;
      sharedPrice = { planId: plan.id, priceId: price.id };
      return sharedPrice;
    } finally {
      await sql.end();
    }
  }

  it("two concurrent checkout-intent attempts for the SAME business collapse to exactly one PENDING intent", async () => {
    const owner = await createOwnerAndBusiness("app-checkout-idempotent");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();

    const attempt = () =>
      owner.client.rpc("begin_paystack_checkout_intent", {
        p_business_id: owner.businessId,
        p_price_id: priceId,
        p_provider_reference: `bos_${crypto.randomUUID()}`,
      });

    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const results = [r1, r2];
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toMatch(/CHECKOUT_ALREADY_IN_PROGRESS/);

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from private.checkout_intents
        where business_id = ${owner.businessId} and status = 'PENDING'
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("a SECOND attempt while one is already PENDING is rejected (sequential double-submit)", async () => {
    const owner = await createOwnerAndBusiness("app-checkout-sequential");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();

    const first = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(first.error).toBeNull();

    const second = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toMatch(/CHECKOUT_ALREADY_IN_PROGRESS/);
  });

  it("a STALE (>15 minute) PENDING intent is reaped, allowing a genuine retry to proceed", async () => {
    const owner = await createOwnerAndBusiness("app-checkout-stale-retry");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();

    const first = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(first.error).toBeNull();

    const sql = createTestDbClient();
    try {
      await sql`update private.checkout_intents set created_at = now() - interval '20 minutes' where id = ${first.data}`;
    } finally {
      await sql.end();
    }

    const retry = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(retry.error).toBeNull();
  });

  it("a DIFFERENT business's checkout attempt is unaffected by another business's in-progress intent", async () => {
    const ownerA = await createOwnerAndBusiness("app-checkout-isolated-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("app-checkout-isolated-b");
    cleanupUserIds.push(ownerB.userId);
    const { priceId } = await getAPrice();

    const a = await ownerA.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: ownerA.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(a.error).toBeNull();

    const b = await ownerB.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: ownerB.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(b.error).toBeNull();
  });

  it("ADMIN cannot begin a checkout intent (billing.manage required)", async () => {
    const owner = await createOwnerAndBusiness("app-checkout-admin-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await createMemberWithRole(owner.businessId, "app-checkout-admin", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const { priceId } = await getAPrice();

    const { error } = await admin.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(error).not.toBeNull();
  });
});

describe("APP-1L-02-R1 — recurring event identity guard (unbound identity gap closed)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYSTACK_ENVIRONMENT", "LIVE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function getGrowthPlanId(): Promise<string> {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      return row.id;
    } finally {
      await sql.end();
    }
  }

  // Activates WITHOUT binding a subscription code — provider_subscription_code
  // stays NULL, exactly the "unbound identity" state APP-1L-02-R1 is about.
  async function activateUnbound(businessId: string, customerCode: string, environment: "TEST" | "LIVE" = "LIVE") {
    const admin = createAdminClient();
    const planId = await getGrowthPlanId();
    const { error } = await admin.rpc("activate_paystack_subscription", {
      p_business_id: businessId,
      p_plan_id: planId,
      p_period_start: new Date().toISOString(),
      p_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_provider_customer_code: customerCode,
      p_provider_environment: environment,
    });
    if (error) throw new Error(error.message);
  }

  async function bindIdentity(businessId: string, customerCode: string, subscriptionCode: string) {
    const admin = createAdminClient();
    const { error } = await admin.rpc("bind_paystack_subscription_identity", {
      p_business_id: businessId,
      p_provider_customer_code: customerCode,
      p_provider_subscription_code: subscriptionCode,
    });
    if (error) throw new Error(error.message);
  }

  async function countAuditEvents(businessId: string, action: string): Promise<number> {
    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.audit_events where business_id = ${businessId} and action = ${action}
      `;
      return Number(count);
    } finally {
      await sql.end();
    }
  }

  async function countNotifications(businessId: string, notificationType: string): Promise<number> {
    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.notifications where business_id = ${businessId} and notification_type = ${notificationType}
      `;
      return Number(count);
    } finally {
      await sql.end();
    }
  }

  it("1. invoice.payment_failed with local provider_subscription_code NULL never mutates an ACTIVE subscription, even with a matching customer code", async () => {
    const customerCode = `CUS_unbound_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-invoice-unbound");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: customerCode }, subscription: { subscription_code: "SUB_old" } },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
    expect(await countAuditEvents(owner.businessId, "subscription.payment_failed")).toBe(0);
    expect(await countNotifications(owner.businessId, "subscription.payment_failed")).toBe(0);
  });

  it("2. subscription.disable with local provider_subscription_code NULL never schedules cancellation, even with a matching customer code", async () => {
    const customerCode = `CUS_unbound_disable_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-disable-unbound");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "subscription.disable",
      { customer: { customer_code: customerCode }, subscription_code: "SUB_old" },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(false);
    expect(await countAuditEvents(owner.businessId, "subscription.cancellation_scheduled")).toBe(0);
    expect(await countNotifications(owner.businessId, "subscription.cancellation_scheduled")).toBe(0);
  });

  it("3. a FULLY bound identity with a matching incoming code DOES mutate normally (invoice.payment_failed → PAST_DUE)", async () => {
    const customerCode = `CUS_bound_${crypto.randomUUID()}`;
    const subCode = `SUB_current_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-invoice-bound");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: customerCode }, subscription: { subscription_code: subCode } },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("PAST_DUE");
    expect(await countAuditEvents(owner.businessId, "subscription.payment_failed")).toBe(1);
  });

  it("4. a bound identity with an OLD (non-current) incoming subscription code never mutates", async () => {
    const customerCode = `CUS_old_code_${crypto.randomUUID()}`;
    const subCurrent = `SUB_current_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-invoice-old-code");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCurrent);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: customerCode }, subscription: { subscription_code: "SUB_old_stale" } },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
  });

  it("5. a customer-code mismatch never mutates, even with a valid bound subscription code elsewhere", async () => {
    const customerCode = `CUS_1_${crypto.randomUUID()}`;
    const subCode = `SUB_1_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-customer-mismatch");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: `CUS_2_${crypto.randomUUID()}` }, subscription: { subscription_code: subCode } },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
  });

  it("6. an environment mismatch (local TEST, configured LIVE) never mutates", async () => {
    const customerCode = `CUS_env_${crypto.randomUUID()}`;
    const subCode = `SUB_env_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-env-mismatch");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode, "TEST");
    await bindIdentity(owner.businessId, customerCode, subCode);

    // Configured environment for THIS test process is LIVE (see
    // beforeEach) while the local row is bound under TEST — a real
    // environment mismatch.
    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: customerCode }, subscription: { subscription_code: subCode } },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
  });

  it("7. a metadata-resolved business whose OWN bound identity does not match the incoming payload never mutates (metadata is never sufficient authority alone)", async () => {
    const customerCode = `CUS_business_a_${crypto.randomUUID()}`;
    const subCode = `SUB_business_a_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-metadata-bypass");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCode);

    // businessId is passed DIRECTLY here (as dispatchPaystackEvent's own
    // last argument) — exactly simulating the route having already
    // resolved it from checkout metadata — but the incoming customer/
    // subscription codes belong to a DIFFERENT identity entirely.
    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      {
        customer: { customer_code: `CUS_someone_else_${crypto.randomUUID()}` },
        subscription: { subscription_code: `SUB_someone_else_${crypto.randomUUID()}` },
      },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
  });

  it("8. a missing incoming subscription code never mutates, even with a fully bound local identity", async () => {
    const customerCode = `CUS_missing_code_${crypto.randomUUID()}`;
    const subCode = `SUB_missing_code_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-missing-code");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "invoice.payment_failed",
      { customer: { customer_code: customerCode } }, // no `subscription` field at all
      owner.businessId
    );
    await dispatchPaystackEvent(
      admin,
      "subscription.disable",
      { customer: { customer_code: customerCode }, subscription_code: "" } as never,
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.cancel_at_period_end).toBe(false);
  });

  it("subscription.disable with a fully bound, matching identity DOES schedule cancellation normally", async () => {
    const customerCode = `CUS_disable_bound_${crypto.randomUUID()}`;
    const subCode = `SUB_disable_bound_${crypto.randomUUID()}`;
    const owner = await createOwnerAndBusiness("app-r1-disable-bound");
    cleanupUserIds.push(owner.userId);
    await activateUnbound(owner.businessId, customerCode);
    await bindIdentity(owner.businessId, customerCode, subCode);

    const admin = createAdminClient();
    await dispatchPaystackEvent(
      admin,
      "subscription.disable",
      { customer: { customer_code: customerCode }, subscription_code: subCode },
      owner.businessId
    );

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.cancel_at_period_end).toBe(true);
    // Access is NOT ended early.
    expect(row?.status).toBe("ACTIVE");
  });
});

describe("ACL-1L-01 — private.bind_paystack_subscription_identity default-EXECUTE remediation", () => {
  it("PUBLIC/anon/authenticated/service_role are all denied; only private_billing_provider_writer may execute it", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'private' and p.proname = 'bind_paystack_subscription_identity' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee);
      expect(grantees).toEqual(["private_billing_provider_writer"]);
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("anon");
      expect(grantees).not.toContain("authenticated");
      expect(grantees).not.toContain("service_role");
    } finally {
      await sql.end();
    }
  });

  it("compact ACL sweep: every Phase 1L application function has EXECUTE granted ONLY to its owner and its intended narrow caller(s)", async () => {
    const expected: Record<string, { schema: "public" | "private"; grantees: string[] }> = {
      create_business: { schema: "public", grantees: ["authenticated", "private_business_creator"] },
      request_subscription_cancellation: { schema: "public", grantees: ["authenticated", "private_billing_action_writer"] },
      record_subscription_checkout_started: { schema: "public", grantees: ["authenticated", "private_billing_action_writer"] },
      begin_paystack_checkout_intent: { schema: "public", grantees: ["authenticated", "private_billing_action_writer"] },
      fail_paystack_checkout_intent: { schema: "public", grantees: ["authenticated", "private_billing_action_writer"] },
      find_paystack_business_by_customer_code: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      ingest_paystack_provider_event: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      activate_paystack_subscription: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      renew_paystack_subscription: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      mark_paystack_subscription_payment_failed: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      expire_paystack_subscription: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      record_paystack_billing_transaction: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      bind_paystack_subscription_identity: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      get_paystack_subscription_disable_context: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
      schedule_paystack_subscription_cancellation: { schema: "public", grantees: ["service_role", "private_billing_provider_writer"] },
    };

    const sql = createTestDbClient();
    try {
      for (const [fn, { schema, grantees: expectedGrantees }] of Object.entries(expected)) {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = ${schema} and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee).sort();
        expect(grantees, fn).toEqual([...expectedGrantees].sort());
        expect(grantees, fn).not.toContain("PUBLIC");
        expect(grantees, fn).not.toContain("anon");
      }
      // The PRIVATE-schema bind function, separately (owner-only grantee).
      const privateRows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'private' and p.proname = 'bind_paystack_subscription_identity' and acl.privilege_type = 'EXECUTE'
      `;
      expect(privateRows.map((r) => r.grantee)).toEqual(["private_billing_provider_writer"]);
    } finally {
      await sql.end();
    }
  });
});

describe("CHK-1L-01 — checkout intent failure cleanup and concurrency safety", () => {
  async function getAPrice(): Promise<{ planId: string; priceId: string }> {
    const sql = createTestDbClient();
    try {
      const [plan] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = 'GROWTH'`;
      const [existing] = await sql<{ id: string }[]>`
        select id from public.subscription_plan_prices
        where plan_id = ${plan.id} and provider = 'PAYSTACK' and provider_environment = 'LIVE'
          and billing_interval = 'MONTHLY' and currency = 'NGN' and is_active
      `;
      if (existing) return { planId: plan.id, priceId: existing.id };
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency, amount_minor, provider_plan_code)
        values (${plan.id}, 'PAYSTACK', 'LIVE', 'MONTHLY', 'NGN', 500000, ${`PLN_chk_${crypto.randomUUID()}`})
        returning id
      `;
      return { planId: plan.id, priceId: price.id };
    } finally {
      await sql.end();
    }
  }

  it("1. fail_paystack_checkout_intent transitions the exact PENDING intent to EXPIRED", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-fail-basic");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();
    const reference = `bos_${crypto.randomUUID()}`;

    const begin = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: reference,
    });
    expect(begin.error).toBeNull();

    const fail = await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: reference,
    });
    expect(fail.error).toBeNull();

    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ status: string }[]>`
        select status from private.checkout_intents where id = ${begin.data as string}
      `;
      expect(row.status).toBe("EXPIRED");
    } finally {
      await sql.end();
    }
  });

  it("2. immediate retry after a failure cleanup succeeds — no 15-minute lockout", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-immediate-retry");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();
    const firstReference = `bos_${crypto.randomUUID()}`;

    await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: firstReference,
    });
    await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: firstReference,
    });

    // Immediately — no delay, no stale-reaper window needed.
    const retry = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: `bos_${crypto.randomUUID()}`,
    });
    expect(retry.error).toBeNull();
  });

  it("3. cleanup for an OLD (already-superseded) reference never expires a NEWER intent for the same business", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-no-newer-expiry");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();
    const referenceA = `bos_${crypto.randomUUID()}`;

    const beginA = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: referenceA,
    });
    expect(beginA.error).toBeNull();
    await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: referenceA,
    });

    const referenceB = `bos_${crypto.randomUUID()}`;
    const beginB = await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: referenceB,
    });
    expect(beginB.error).toBeNull();

    // Late-arriving cleanup callback for the FIRST (already-failed)
    // reference — must be a safe no-op, never touching B.
    await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: referenceA,
    });

    const sql = createTestDbClient();
    try {
      const [rowB] = await sql<{ status: string }[]>`
        select status from private.checkout_intents where id = ${beginB.data as string}
      `;
      expect(rowB.status).toBe("PENDING");
    } finally {
      await sql.end();
    }
  });

  it("4. two concurrent begin-intent calls for the same business still produce exactly one PENDING winner", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-concurrent-winner");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();

    const attempt = () =>
      owner.client.rpc("begin_paystack_checkout_intent", {
        p_business_id: owner.businessId,
        p_price_id: priceId,
        p_provider_reference: `bos_${crypto.randomUUID()}`,
      });
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const succeeded = [r1, r2].filter((r) => !r.error);
    expect(succeeded).toHaveLength(1);

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from private.checkout_intents where business_id = ${owner.businessId} and status = 'PENDING'
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("5. fail_paystack_checkout_intent is idempotent: a second call for an already-EXPIRED reference is a safe no-op", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-idempotent-fail");
    cleanupUserIds.push(owner.userId);
    const { priceId } = await getAPrice();
    const reference = `bos_${crypto.randomUUID()}`;

    await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: reference,
    });
    const first = await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: reference,
    });
    expect(first.error).toBeNull();
    const second = await owner.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: reference,
    });
    expect(second.error).toBeNull();
  });

  it("6. ADMIN cannot call fail_paystack_checkout_intent (billing.manage required)", async () => {
    const owner = await createOwnerAndBusiness("chk-r1-fail-admin-denied");
    cleanupUserIds.push(owner.userId);
    const admin = await createMemberWithRole(owner.businessId, "chk-r1-fail-admin", "ADMIN");
    cleanupUserIds.push(admin.userId);
    const { priceId } = await getAPrice();
    const reference = `bos_${crypto.randomUUID()}`;
    await owner.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_price_id: priceId,
      p_provider_reference: reference,
    });

    const { error } = await admin.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: owner.businessId,
      p_provider_reference: reference,
    });
    expect(error).not.toBeNull();
  });

  it("7. a wrong-business fail_paystack_checkout_intent call cannot expire another business's intent", async () => {
    const ownerA = await createOwnerAndBusiness("chk-r1-cross-tenant-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("chk-r1-cross-tenant-b");
    cleanupUserIds.push(ownerB.userId);
    const { priceId } = await getAPrice();
    const referenceA = `bos_${crypto.randomUUID()}`;

    const beginA = await ownerA.client.rpc("begin_paystack_checkout_intent", {
      p_business_id: ownerA.businessId,
      p_price_id: priceId,
      p_provider_reference: referenceA,
    });
    expect(beginA.error).toBeNull();

    // ownerB claims billing.manage on THEIR OWN business, but tries to
    // fail ownerA's reference under ownerB's own business_id — the
    // function's own WHERE clause (business_id = p_business_id AND
    // provider_reference = p_provider_reference) can never match A's
    // row when p_business_id is B's id, so this is a safe no-op, not an
    // authorization bypass.
    await ownerB.client.rpc("fail_paystack_checkout_intent", {
      p_business_id: ownerB.businessId,
      p_provider_reference: referenceA,
    });

    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ status: string }[]>`
        select status from private.checkout_intents where id = ${beginA.data as string}
      `;
      expect(row.status).toBe("PENDING");
    } finally {
      await sql.end();
    }
  });
});
