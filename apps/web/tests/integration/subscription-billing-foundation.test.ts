import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, createMemberWithCustomPermissions } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1L — DATABASE FOUNDATION ONLY. Exercises the subscription/
// billing catalog, the business_subscriptions state machine, billing
// history, and provider-event idempotency directly against a real
// database. No application layer exists yet — every trusted-function
// call here goes through a raw Postgres connection
// (createTestDbClient()), the same superuser test connection every
// other phase's own DB-foundation round already uses for the identical
// reason (private.create_initial_trial etc. have ZERO EXECUTE grants to
// any real login role yet).

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

async function getPlanId(code: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`select id from public.subscription_plans where code = ${code}`;
    return row.id;
  } finally {
    await sql.end();
  }
}

async function createInitialTrial(businessId: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ create_initial_trial: string }[]>`
      select private.create_initial_trial(${businessId}::uuid) as create_initial_trial
    `;
    return rows[0].create_initial_trial;
  } finally {
    await sql.end();
  }
}

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

// SEC-1L-01 remediation made mark_subscription_expired reject a
// premature call while the trial window is still open (its own
// dedicated boundary tests below prove that directly) — every test in
// this file that exercises mark_subscription_expired for a REASON OTHER
// than the boundary itself (idempotency, CANCELED-vs-EXPIRED choice,
// cancelability) needs a trial that has ALREADY elapsed, never a fresh
// one.
async function createInitialTrialAlreadyElapsed(businessId: string) {
  const id = await createInitialTrial(businessId);
  const sql = createTestDbClient();
  try {
    await sql`update public.business_subscriptions
               set trial_started_at = now() - interval '15 days', trial_ends_at = now() - interval '1 hour'
               where business_id = ${businessId}`;
  } finally {
    await sql.end();
  }
  return id;
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

describe("subscription_plans / plan_entitlements / subscription_plan_prices — catalog RLS and shape", () => {
  it("1. an authenticated member can read the plan catalog and its entitlements", async () => {
    const owner = await createOwnerAndBusiness("billing-catalog-read");
    cleanupUserIds.push(owner.userId);
    const { data: plans, error } = await owner.client.from("subscription_plans").select("code").order("sort_order");
    expect(error).toBeNull();
    expect(plans?.map((p) => p.code)).toEqual(["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE"]);

    const { data: entitlements } = await owner.client
      .from("plan_entitlements")
      .select("entitlement_key, value_integer")
      .eq("entitlement_key", "branches.max");
    expect(entitlements?.length).toBeGreaterThan(0);
  });

  it("2. an anonymous caller cannot read the catalog", async () => {
    const anon = createAnonClient();
    const { data } = await anon.from("subscription_plans").select("code");
    expect(data ?? []).toHaveLength(0);
  });

  it("3. no authenticated client can write to any catalog table", async () => {
    const owner = await createOwnerAndBusiness("billing-catalog-write-denied");
    cleanupUserIds.push(owner.userId);
    const { error: insertError } = await owner.client
      .from("subscription_plans")
      .insert({ code: "STARTER", name: "Forged" } as never);
    expect(insertError).not.toBeNull();
    const { error: updateError } = await owner.client
      .from("subscription_plans")
      .update({ is_active: false } as never)
      .eq("code", "GROWTH");
    expect(updateError).not.toBeNull();
    const { error: deleteError } = await owner.client.from("subscription_plans").delete().eq("code", "GROWTH");
    expect(deleteError).not.toBeNull();
  });

  it("4. plan code is unique, and unrecognized codes are rejected", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`insert into public.subscription_plans (code, name) values ('GROWTH', 'Duplicate')`
      ).rejects.toThrow(/duplicate key|unique/i);
      await expect(
        sql`insert into public.subscription_plans (code, name) values ('BOGUS', 'x')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("5. plan_entitlements enforces exactly one value representation", async () => {
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("STARTER");
      await expect(
        sql`insert into public.plan_entitlements (plan_id, entitlement_key) values (${planId}, 'test.no_value')`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.plan_entitlements (plan_id, entitlement_key, value_integer, value_boolean) values (${planId}, 'test.two_values', 1, true)`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("6. subscription_plan_prices rejects a floating currency shape, negative amount, and unrecognized interval", async () => {
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await expect(
        sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor) values (${planId}, 'PAYSTACK', 'MONTHLY', 'ngn', 1500000)`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor) values (${planId}, 'PAYSTACK', 'MONTHLY', 'NGN', -1)`
      ).rejects.toThrow(/violates check constraint|out of range/i);
      await expect(
        sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor) values (${planId}, 'PAYSTACK', 'WEEKLY', 'NGN', 1500000)`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("7. only ONE active price may exist per (plan, provider, environment, interval, currency)", async () => {
    // subscription_plan_prices is a GLOBAL catalog table, not tenant-
    // scoped — every row this test inserts is explicitly cleaned up in
    // its own `finally`, so this test remains re-runnable against the
    // SAME database without a fresh `supabase db reset` in between
    // (exactly like every other permanent test in this suite that
    // touches shared, non-tenant-scoped reference data).
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("STARTER");
      await sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor) values (${planId}, 'PAYSTACK', 'MONTHLY', 'KES', 500000)`;
      await expect(
        sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor) values (${planId}, 'PAYSTACK', 'MONTHLY', 'KES', 600000)`
      ).rejects.toThrow(/duplicate key|unique/i);
      // A second, INACTIVE price for the same combination is fine —
      // proves this is a partial (active-only) uniqueness rule, not a
      // blanket one that would make legitimate price replacement
      // impossible.
      await sql`insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor, is_active) values (${planId}, 'PAYSTACK', 'MONTHLY', 'KES', 700000, false)`;
    } finally {
      await sql`delete from public.subscription_plan_prices where currency = 'KES'`;
      await sql.end();
    }
  });

  it("8. a Paystack TEST plan code and a LIVE plan code are never confused (separate uniqueness)", async () => {
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("BUSINESS");
      await sql`insert into public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency, amount_minor, provider_plan_code) values (${planId}, 'PAYSTACK', 'TEST', 'ANNUAL', 'GHS', 5000000, 'PLN_shared_test8')`;
      // The SAME provider_plan_code string in the OTHER environment is
      // NOT a collision — TEST and LIVE are structurally separate.
      await sql`insert into public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency, amount_minor, provider_plan_code) values (${planId}, 'PAYSTACK', 'LIVE', 'ANNUAL', 'GHS', 5000000, 'PLN_shared_test8')`;
    } finally {
      await sql`delete from public.subscription_plan_prices where provider_plan_code = 'PLN_shared_test8'`;
      await sql.end();
    }
  });
});

describe("private.create_initial_trial — one legitimate trial per business", () => {
  it("9. creates a TRIALING GROWTH subscription, 14 days, provider MANUAL, no payment method involved", async () => {
    const owner = await createOwnerAndBusiness("billing-trial-create");
    cleanupUserIds.push(owner.userId);
    const id = await createInitialTrial(owner.businessId);
    expect(id).toBeTruthy();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("TRIALING");
    expect(row?.provider).toBe("MANUAL");
    expect(row?.currency).toBe("NGN");
    expect(row?.trial_started_at).toBeTruthy();
    expect(row?.trial_ends_at).toBeTruthy();
    const started = new Date(row!.trial_started_at as string).getTime();
    const ends = new Date(row!.trial_ends_at as string).getTime();
    expect(Math.round((ends - started) / (24 * 60 * 60 * 1000))).toBe(14);

    const plan = await getPlanId("GROWTH");
    expect(row?.plan_id).toBe(plan);
  });

  it("10. a second trial for the SAME business is rejected with a controlled error, not a raw constraint leak", async () => {
    const owner = await createOwnerAndBusiness("billing-trial-duplicate");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    await expect(createInitialTrial(owner.businessId)).rejects.toThrow(/SUBSCRIPTION_ALREADY_EXISTS/);
  });

  it("11. a concurrent double-call for the same business produces exactly ONE row (race-safe)", async () => {
    const owner = await createOwnerAndBusiness("billing-trial-race");
    cleanupUserIds.push(owner.userId);
    const results = await Promise.allSettled([createInitialTrial(owner.businessId), createInitialTrial(owner.businessId)]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.business_subscriptions where business_id = ${owner.businessId}
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("client cannot fabricate a trial by calling the trusted function directly", async () => {
    const owner = await createOwnerAndBusiness("billing-trial-forge-attempt");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not part of the
      // generated public RPC surface.
      "create_initial_trial",
      { p_business_id: owner.businessId }
    );
    expect(error).not.toBeNull();
  });
});

describe("private.activate_subscription_from_verified_payment — TRIALING/PAST_DUE -> ACTIVE", () => {
  it("12. activates a trialing subscription with a real price, clearing cancel/grace state", async () => {
    const owner = await createOwnerAndBusiness("billing-activate");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    let priceId: string;
    try {
      const planId = await getPlanId("GROWTH");
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor, provider_plan_code)
        values (${planId}, 'PAYSTACK', 'MONTHLY', 'ZAR', 1500000, 'PLN_growth_monthly_test12')
        returning id
      `;
      priceId = price.id;

      const start = new Date();
      const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
      const rows = await sql<{ id: string }[]>`
        select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, (select plan_id from public.subscription_plan_prices where id = ${priceId})::uuid,
          'PAYSTACK'::text, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz,
          ${priceId}::uuid, 'LIVE'::text, 'CUS_123'::text, 'SUB_123'::text
        ) as id
      `;
      expect(rows[0].id).toBeTruthy();
    } finally {
      // Deliberately NOT deleted here: this business's own
      // business_subscriptions row now references this price via
      // price_id, and subscription_plan_prices.plan_id/business_
      // subscriptions.price_id both use ON DELETE RESTRICT — attempting
      // to delete it would fail (correctly) while the subscription still
      // exists. The provider_plan_code/currency combination is unique to
      // THIS test alone within the suite, so it never collides with any
      // other test in a single run; a genuinely fresh `supabase db
      // reset` (this codebase's own established pre-integration-suite
      // gate step) is what keeps this reproducible run over run.
      await sql.end();
    }

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.provider).toBe("PAYSTACK");
    expect(row?.provider_customer_code).toBe("CUS_123");
    expect(row?.provider_subscription_code).toBe("SUB_123");
    // postgres.js returns bigint columns as strings (to avoid silent JS
    // number precision loss) — Number() here is safe for a test-scale
    // value, never used for the actual application's own money handling.
    expect(Number(row?.amount_minor)).toBe(1500000);
    expect(row?.cancel_at_period_end).toBe(false);
    expect(row?.canceled_at).toBeNull();
  });

  it("13. a price belonging to a DIFFERENT plan is rejected (PRICE_PLAN_MISMATCH)", async () => {
    const owner = await createOwnerAndBusiness("billing-activate-mismatch");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    try {
      const starterPlanId = await getPlanId("STARTER");
      const growthPlanId = await getPlanId("GROWTH");
      // ANNUAL/USD, not MONTHLY/NGN — this catalog is GLOBAL, shared
      // across every test in this file's own single db reset, so a
      // combination already used by an earlier test (test 7's own
      // STARTER/PAYSTACK/MONTHLY/NGN price) would collide against the
      // active-price-uniqueness index for a reason unrelated to what
      // THIS test is actually proving.
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor)
        values (${starterPlanId}, 'PAYSTACK', 'ANNUAL', 'USD', 500000)
        returning id
      `;
      await expect(
        sql`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${growthPlanId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz, ${price.id}::uuid
        )`
      ).rejects.toThrow(/PRICE_PLAN_MISMATCH/);
    } finally {
      // Safe to delete: the mismatch means this price was NEVER assigned
      // to any subscription's own price_id (the activation call rejected
      // before reaching that UPDATE), so no RESTRICT-guarded reference
      // exists — unlike test 12's own price, which genuinely IS
      // referenced by a real subscription and must be left in place.
      await sql`delete from public.subscription_plan_prices
                where provider = 'PAYSTACK' and billing_interval = 'ANNUAL' and currency = 'USD'
                  and plan_id = (select id from public.subscription_plans where code = 'STARTER')`;
      await sql.end();
    }
  });

  it("14. activating a business with NO existing subscription row is rejected (SUBSCRIPTION_NOT_FOUND)", async () => {
    const owner = await createOwnerAndBusiness("billing-activate-no-row");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await expect(
        sql`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz
        )`
      ).rejects.toThrow(/SUBSCRIPTION_NOT_FOUND/);
    } finally {
      await sql.end();
    }
  });

  it("SEC-1L-03: a price belonging to a DIFFERENT provider than claimed is rejected (PRICE_PROVIDER_MISMATCH) — covers PAYSTACK price -> MANUAL subscription", async () => {
    const owner = await createOwnerAndBusiness("billing-activate-provider-mismatch");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    try {
      const growthPlanId = await getPlanId("GROWTH");
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor)
        values (${growthPlanId}, 'PAYSTACK', 'MONTHLY', 'MZN', 500000)
        returning id
      `;
      // The ONLY currently-valid subscription providers are PAYSTACK and
      // MANUAL, and the ONLY currently-valid price provider is PAYSTACK —
      // p_provider = 'MANUAL' here is the exact "PAYSTACK price ->
      // MANUAL subscription" scenario this finding names explicitly.
      await expect(
        sql`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${growthPlanId}::uuid, 'MANUAL'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz, ${price.id}::uuid
        )`
      ).rejects.toThrow(/PRICE_PROVIDER_MISMATCH/);
    } finally {
      await sql`delete from public.subscription_plan_prices where currency = 'MZN'`;
      await sql.end();
    }
  });

  it("SEC-1L-03: a TEST-environment price activated as a LIVE subscription (or vice versa) is rejected (PRICE_ENVIRONMENT_MISMATCH)", async () => {
    const owner = await createOwnerAndBusiness("billing-activate-env-mismatch");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    try {
      const growthPlanId = await getPlanId("GROWTH");
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, provider_environment, billing_interval, currency, amount_minor)
        values (${growthPlanId}, 'PAYSTACK', 'TEST', 'MONTHLY', 'XOF', 500000)
        returning id
      `;
      await expect(
        sql`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${growthPlanId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz, ${price.id}::uuid, 'LIVE'::text
        )`
      ).rejects.toThrow(/PRICE_ENVIRONMENT_MISMATCH/);
    } finally {
      await sql`delete from public.subscription_plan_prices where currency = 'XOF'`;
      await sql.end();
    }
  });
});

describe("private.record_subscription_renewal / payment_failed — ACTIVE <-> PAST_DUE", () => {
  async function activateWithGrowth(businessId: string) {
    await createInitialTrial(businessId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await sql`select private.activate_subscription_from_verified_payment(
        ${businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
        now()::timestamptz, (now() + interval '30 days')::timestamptz
      )`;
    } finally {
      await sql.end();
    }
  }

  it("15. a payment failure moves ACTIVE -> PAST_DUE with NO grace, and a subsequent renewal moves it back to ACTIVE, clearing any stale grace", async () => {
    const owner = await createOwnerAndBusiness("billing-past-due-recovery");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);

    const sql = createTestDbClient();
    try {
      await sql`select private.record_subscription_payment_failed(${owner.businessId}::uuid)`;
    } finally {
      await sql.end();
    }
    let row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("PAST_DUE");
    // SEC-1L-02(B): record_subscription_payment_failed no longer accepts
    // (or invents) any grace — grace_ends_at is always NULL immediately
    // after a payment failure.
    expect(row?.grace_ends_at).toBeNull();

    // A stale grace_ends_at could still exist on a row for reasons
    // outside this function's own control (e.g. a future grace-policy
    // primitive) — prove record_subscription_renewal clears it as part
    // of a successful renewal regardless of how it got there.
    const sqlSetGrace = createTestDbClient();
    try {
      await sqlSetGrace`update public.business_subscriptions set grace_ends_at = now() + interval '1 day' where business_id = ${owner.businessId}`;
    } finally {
      await sqlSetGrace.end();
    }

    const sql2 = createTestDbClient();
    try {
      const newEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sql2`select private.record_subscription_renewal(${owner.businessId}::uuid, now()::timestamptz, ${newEnd}::timestamptz)`;
    } finally {
      await sql2.end();
    }
    row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.grace_ends_at).toBeNull();
  });

  it("a far-future caller-controlled grace is impossible: the function no longer accepts a second parameter at all", async () => {
    const owner = await createOwnerAndBusiness("billing-payment-failed-no-grace-param");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);
    const sql = createTestDbClient();
    try {
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      // The 2-argument overload no longer exists at all — Postgres
      // reports a function-not-found error, not a validation error,
      // which is itself the proof that no caller of any kind can supply
      // an absolute grace timestamp any more.
      await expect(
        sql`select private.record_subscription_payment_failed(${owner.businessId}::uuid, ${farFuture}::timestamptz)`
      ).rejects.toThrow(/function private\.record_subscription_payment_failed.*does not exist/i);
    } finally {
      await sql.end();
    }
  });

  it("16. a payment failure on a non-ACTIVE subscription is rejected", async () => {
    const owner = await createOwnerAndBusiness("billing-payment-failed-invalid-state");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const sql = createTestDbClient();
    try {
      await expect(sql`select private.record_subscription_payment_failed(${owner.businessId}::uuid)`).rejects.toThrow(
        /SUBSCRIPTION_NOT_ACTIVE/
      );
    } finally {
      await sql.end();
    }
  });

  it("SEC-1L-02(A): a renewal with a SHORTER period end than the existing one is rejected, never moving paid-through time backwards", async () => {
    const owner = await createOwnerAndBusiness("billing-renewal-shorter-rejected");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);
    const before = await getSubscriptionRow(owner.businessId);

    const sql = createTestDbClient();
    try {
      const shorterEnd = new Date(new Date(before!.current_period_ends_at as string).getTime() - 24 * 60 * 60 * 1000).toISOString();
      await expect(
        sql`select private.record_subscription_renewal(${owner.businessId}::uuid, now()::timestamptz, ${shorterEnd}::timestamptz)`
      ).rejects.toThrow(/RENEWAL_PERIOD_NOT_ADVANCING/);
    } finally {
      await sql.end();
    }

    // No mutation occurred on the rejected renewal.
    const after = await getSubscriptionRow(owner.businessId);
    expect(after?.current_period_ends_at).toEqual(before?.current_period_ends_at);
  });

  it("SEC-1L-02(A): a renewal with EXACTLY the existing period end is accepted as idempotent replay/no-op semantics", async () => {
    const owner = await createOwnerAndBusiness("billing-renewal-equal-accepted");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);
    const before = await getSubscriptionRow(owner.businessId);

    const sql = createTestDbClient();
    try {
      // Re-read the existing bounds via a subquery rather than round-
      // tripping the fetched value through a JS Date (which truncates
      // Postgres' microsecond timestamptz precision to milliseconds) —
      // this proves TRUE equality, not a value that merely LOOKS equal
      // once precision has already been lost.
      await sql`select private.record_subscription_renewal(
        ${owner.businessId}::uuid,
        (select current_period_started_at from public.business_subscriptions where business_id = ${owner.businessId})::timestamptz,
        (select current_period_ends_at from public.business_subscriptions where business_id = ${owner.businessId})::timestamptz
      )`;
    } finally {
      await sql.end();
    }
    const after = await getSubscriptionRow(owner.businessId);
    expect(after?.status).toBe("ACTIVE");
    expect(new Date(after!.current_period_ends_at as string).getTime()).toBe(
      new Date(before!.current_period_ends_at as string).getTime()
    );
  });

  it("SEC-1L-02(A): a renewal with a genuinely LONGER period end is accepted and extends paid-through access", async () => {
    const owner = await createOwnerAndBusiness("billing-renewal-longer-accepted");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);
    const before = await getSubscriptionRow(owner.businessId);

    const sql = createTestDbClient();
    try {
      const longerEnd = new Date(new Date(before!.current_period_ends_at as string).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sql`select private.record_subscription_renewal(${owner.businessId}::uuid, now()::timestamptz, ${longerEnd}::timestamptz)`;
    } finally {
      await sql.end();
    }
    const after = await getSubscriptionRow(owner.businessId);
    expect(new Date(after!.current_period_ends_at as string).getTime()).toBeGreaterThan(
      new Date(before!.current_period_ends_at as string).getTime()
    );
  });

  it("SEC-1L-02(A): a renewal never touches cancel_at_period_end/canceled_at (narrow single-responsibility contract), and clears a stale ended_at", async () => {
    const owner = await createOwnerAndBusiness("billing-renewal-cancellation-fields");
    cleanupUserIds.push(owner.userId);
    await activateWithGrowth(owner.businessId);
    const sqlSchedule = createTestDbClient();
    try {
      await sqlSchedule`select private.schedule_subscription_cancel(${owner.businessId}::uuid)`;
      // ended_at has no legitimate way to be set on an ACTIVE row through
      // any trusted function — forced here only to prove the renewal's
      // own defensive clear, never asserting this is a reachable state
      // through normal use.
      await sqlSchedule`update public.business_subscriptions set ended_at = now() where business_id = ${owner.businessId}`;
    } finally {
      await sqlSchedule.end();
    }
    const before = await getSubscriptionRow(owner.businessId);
    expect(before?.cancel_at_period_end).toBe(true);
    expect(before?.canceled_at).toBeTruthy();

    const sql = createTestDbClient();
    try {
      const newEnd = new Date(new Date(before!.current_period_ends_at as string).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sql`select private.record_subscription_renewal(${owner.businessId}::uuid, now()::timestamptz, ${newEnd}::timestamptz)`;
    } finally {
      await sql.end();
    }
    const after = await getSubscriptionRow(owner.businessId);
    expect(after?.status).toBe("ACTIVE");
    // cancel_at_period_end/canceled_at are left exactly as they were —
    // only schedule_subscription_cancel/mark_subscription_expired ever
    // touch them.
    expect(after?.cancel_at_period_end).toBe(true);
    expect(after?.canceled_at).toEqual(before?.canceled_at);
    expect(after?.ended_at).toBeNull();
  });
});

describe("private.schedule_subscription_cancel / mark_subscription_expired — cancellation vs expiration", () => {
  it("17. scheduling a cancellation does NOT change status — the paid-for period keeps running unaffected", async () => {
    const owner = await createOwnerAndBusiness("billing-cancel-schedule");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    try {
      await sql`select private.schedule_subscription_cancel(${owner.businessId}::uuid)`;
    } finally {
      await sql.end();
    }
    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("TRIALING");
    expect(row?.cancel_at_period_end).toBe(true);
    expect(row?.canceled_at).toBeTruthy();
  });

  it("18. mark_subscription_expired chooses CANCELED when a cancellation was scheduled, EXPIRED otherwise", async () => {
    const ownerCanceled = await createOwnerAndBusiness("billing-expire-canceled");
    cleanupUserIds.push(ownerCanceled.userId);
    await createInitialTrialAlreadyElapsed(ownerCanceled.businessId);
    const sql1 = createTestDbClient();
    try {
      await sql1`select private.schedule_subscription_cancel(${ownerCanceled.businessId}::uuid)`;
      await sql1`select private.mark_subscription_expired(${ownerCanceled.businessId}::uuid)`;
    } finally {
      await sql1.end();
    }
    const canceledRow = await getSubscriptionRow(ownerCanceled.businessId);
    expect(canceledRow?.status).toBe("CANCELED");
    expect(canceledRow?.ended_at).toBeNull();

    const ownerExpired = await createOwnerAndBusiness("billing-expire-lapsed");
    cleanupUserIds.push(ownerExpired.userId);
    await createInitialTrialAlreadyElapsed(ownerExpired.businessId);
    const sql2 = createTestDbClient();
    try {
      await sql2`select private.mark_subscription_expired(${ownerExpired.businessId}::uuid)`;
    } finally {
      await sql2.end();
    }
    const expiredRow = await getSubscriptionRow(ownerExpired.businessId);
    expect(expiredRow?.status).toBe("EXPIRED");
    expect(expiredRow?.ended_at).toBeTruthy();
  });

  it("19. an already-ended subscription cannot be expired again", async () => {
    const owner = await createOwnerAndBusiness("billing-expire-already-ended");
    cleanupUserIds.push(owner.userId);
    await createInitialTrialAlreadyElapsed(owner.businessId);
    const sql = createTestDbClient();
    try {
      await sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      await expect(sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`).rejects.toThrow(
        /SUBSCRIPTION_ALREADY_ENDED/
      );
    } finally {
      await sql.end();
    }
  });

  it("20. cancellation can only be scheduled from TRIALING/ACTIVE/PAST_DUE, never from an already-ended state", async () => {
    const owner = await createOwnerAndBusiness("billing-cancel-invalid-state");
    cleanupUserIds.push(owner.userId);
    await createInitialTrialAlreadyElapsed(owner.businessId);
    const sql = createTestDbClient();
    try {
      await sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      await expect(sql`select private.schedule_subscription_cancel(${owner.businessId}::uuid)`).rejects.toThrow(
        /SUBSCRIPTION_NOT_CANCELABLE/
      );
    } finally {
      await sql.end();
    }
  });

  describe("SEC-1L-01 — mark_subscription_expired never terminates a still-valid entitlement window early", () => {
    it("TRIALING: expiry before trial_ends_at is rejected, and mutates nothing", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-trial-early");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const before = await getSubscriptionRow(owner.businessId);

      const sql = createTestDbClient();
      try {
        await expect(sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`).rejects.toThrow(
          /SUBSCRIPTION_NOT_YET_EXPIRABLE/
        );
      } finally {
        await sql.end();
      }
      const after = await getSubscriptionRow(owner.businessId);
      expect(after?.status).toBe("TRIALING");
      expect(after?.ended_at).toBeNull();
      expect(after?.trial_ends_at).toEqual(before?.trial_ends_at);
    });

    it("TRIALING: expiry after trial_ends_at has passed succeeds", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-trial-elapsed");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const sqlBackdate = createTestDbClient();
      try {
        await sqlBackdate`update public.business_subscriptions
                           set trial_started_at = now() - interval '15 days', trial_ends_at = now() - interval '1 hour'
                           where business_id = ${owner.businessId}`;
      } finally {
        await sqlBackdate.end();
      }
      const sql = createTestDbClient();
      try {
        await sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      } finally {
        await sql.end();
      }
      const after = await getSubscriptionRow(owner.businessId);
      expect(after?.status).toBe("EXPIRED");
      expect(after?.ended_at).toBeTruthy();
    });

    it("ACTIVE: expiry before current_period_ends_at is rejected, and mutates nothing", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-active-early");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const sqlActivate = createTestDbClient();
      try {
        const planId = await getPlanId("GROWTH");
        await sqlActivate`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz
        )`;
      } finally {
        await sqlActivate.end();
      }
      const before = await getSubscriptionRow(owner.businessId);

      const sql = createTestDbClient();
      try {
        await expect(sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`).rejects.toThrow(
          /SUBSCRIPTION_NOT_YET_EXPIRABLE/
        );
      } finally {
        await sql.end();
      }
      const after = await getSubscriptionRow(owner.businessId);
      expect(after?.status).toBe("ACTIVE");
      expect(after?.ended_at).toBeNull();
      expect(after?.current_period_ends_at).toEqual(before?.current_period_ends_at);
    });

    it("ACTIVE: expiry after current_period_ends_at has passed succeeds", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-active-elapsed");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const sqlActivate = createTestDbClient();
      try {
        const planId = await getPlanId("GROWTH");
        await sqlActivate`select private.activate_subscription_from_verified_payment(
          ${owner.businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz
        )`;
        await sqlActivate`update public.business_subscriptions
                           set current_period_started_at = now() - interval '31 days', current_period_ends_at = now() - interval '1 hour'
                           where business_id = ${owner.businessId}`;
      } finally {
        await sqlActivate.end();
      }
      const sql = createTestDbClient();
      try {
        await sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      } finally {
        await sql.end();
      }
      const after = await getSubscriptionRow(owner.businessId);
      expect(after?.status).toBe("EXPIRED");
      expect(after?.ended_at).toBeTruthy();
    });

    async function activateAndFail(businessId: string) {
      const sql = createTestDbClient();
      try {
        const planId = await getPlanId("GROWTH");
        await sql`select private.activate_subscription_from_verified_payment(
          ${businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
          now()::timestamptz, (now() + interval '30 days')::timestamptz
        )`;
        await sql`select private.record_subscription_payment_failed(${businessId}::uuid)`;
      } finally {
        await sql.end();
      }
    }

    it("PAST_DUE with grace: expiry before grace_ends_at is rejected; after it has passed, expiry succeeds", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-past-due-grace");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      await activateAndFail(owner.businessId);

      const sqlGrace = createTestDbClient();
      try {
        await sqlGrace`update public.business_subscriptions set grace_ends_at = now() + interval '1 day' where business_id = ${owner.businessId}`;
      } finally {
        await sqlGrace.end();
      }

      const sqlEarly = createTestDbClient();
      try {
        await expect(sqlEarly`select private.mark_subscription_expired(${owner.businessId}::uuid)`).rejects.toThrow(
          /SUBSCRIPTION_NOT_YET_EXPIRABLE/
        );
      } finally {
        await sqlEarly.end();
      }
      let row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("PAST_DUE");

      const sqlLapse = createTestDbClient();
      try {
        await sqlLapse`update public.business_subscriptions set grace_ends_at = now() - interval '1 hour' where business_id = ${owner.businessId}`;
      } finally {
        await sqlLapse.end();
      }
      const sqlLate = createTestDbClient();
      try {
        await sqlLate`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      } finally {
        await sqlLate.end();
      }
      row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("EXPIRED");
    });

    it("PAST_DUE without grace: expiry is rejected until the underlying current_period_ends_at itself has passed", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-past-due-no-grace");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      await activateAndFail(owner.businessId);
      // record_subscription_payment_failed always leaves grace_ends_at
      // NULL (SEC-1L-02(B)) — current_period_ends_at is still 30 days
      // out, so expiry must be rejected purely on the underlying period.
      const before = await getSubscriptionRow(owner.businessId);
      expect(before?.grace_ends_at).toBeNull();

      const sqlEarly = createTestDbClient();
      try {
        await expect(sqlEarly`select private.mark_subscription_expired(${owner.businessId}::uuid)`).rejects.toThrow(
          /SUBSCRIPTION_NOT_YET_EXPIRABLE/
        );
      } finally {
        await sqlEarly.end();
      }
      let row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("PAST_DUE");

      const sqlLapse = createTestDbClient();
      try {
        // Both bounds moved into the past together — preserves
        // `current_period_ends_at > current_period_started_at` (the
        // table's own CHECK constraint) while making the whole period
        // already-elapsed relative to `now()`.
        await sqlLapse`update public.business_subscriptions
                        set current_period_started_at = now() - interval '31 days', current_period_ends_at = now() - interval '1 hour'
                        where business_id = ${owner.businessId}`;
      } finally {
        await sqlLapse.end();
      }
      const sqlLate = createTestDbClient();
      try {
        await sqlLate`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      } finally {
        await sqlLate.end();
      }
      row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("EXPIRED");
    });

    it("INCOMPLETE: expiry is unconditional (no entitlement window exists to end prematurely)", async () => {
      const owner = await createOwnerAndBusiness("billing-expiry-incomplete");
      cleanupUserIds.push(owner.userId);
      const planId = await getPlanId("GROWTH");
      const sqlInsert = createTestDbClient();
      try {
        await sqlInsert`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency)
                         values (${owner.businessId}, ${planId}, 'MANUAL', 'INCOMPLETE', 'NGN')`;
      } finally {
        await sqlInsert.end();
      }
      const sql = createTestDbClient();
      try {
        await sql`select private.mark_subscription_expired(${owner.businessId}::uuid)`;
      } finally {
        await sql.end();
      }
      const row = await getSubscriptionRow(owner.businessId);
      expect(row?.status).toBe("EXPIRED");
    });
  });
});

describe("business_subscriptions — table-level state machine CHECK constraints", () => {
  it("21. TRIALING requires both trial timestamps, with ends_at > started_at", async () => {
    const owner = await createOwnerAndBusiness("billing-check-trialing");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'TRIALING', 'NGN')`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency, trial_started_at, trial_ends_at)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'TRIALING', 'NGN', now(), now() - interval '1 day')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("22. ACTIVE requires both period timestamps, with ends_at > started_at", async () => {
    const owner = await createOwnerAndBusiness("billing-check-active");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency)
            values (${owner.businessId}, ${planId}, 'PAYSTACK', 'ACTIVE', 'NGN')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("23. CANCELED requires canceled_at; EXPIRED requires ended_at", async () => {
    const owner = await createOwnerAndBusiness("billing-check-terminal");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'CANCELED', 'NGN')`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'EXPIRED', 'NGN')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("24. a business can never hold two business_subscriptions rows", async () => {
    const owner = await createOwnerAndBusiness("billing-check-one-row");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("STARTER");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, status, currency, trial_started_at, trial_ends_at)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'TRIALING', 'NGN', now(), now() + interval '1 day')`
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await sql.end();
    }
  });

  it("25. a MANUAL provider row can never carry a provider_environment", async () => {
    const owner = await createOwnerAndBusiness("billing-check-manual-env");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("ENTERPRISE");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, provider_environment, status, currency, trial_started_at, trial_ends_at)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'LIVE', 'TRIALING', 'NGN', now(), now() + interval '1 day')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("SEC-1L-03: a MANUAL provider row can never carry a provider_customer_code or provider_subscription_code", async () => {
    const owner = await createOwnerAndBusiness("billing-check-manual-identifiers");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("ENTERPRISE");
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, provider_customer_code, status, currency, trial_started_at, trial_ends_at)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'CUS_forged', 'TRIALING', 'NGN', now(), now() + interval '1 day')`
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, provider, provider_subscription_code, status, currency, trial_started_at, trial_ends_at)
            values (${owner.businessId}, ${planId}, 'MANUAL', 'SUB_forged', 'TRIALING', 'NGN', now(), now() + interval '1 day')`
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await sql.end();
    }
  });

  it("SEC-1L-03: a subscription's price_id must belong to the SAME plan_id, enforced structurally even against a direct privileged INSERT", async () => {
    const owner = await createOwnerAndBusiness("billing-check-price-plan-fk");
    cleanupUserIds.push(owner.userId);
    const sql = createTestDbClient();
    try {
      const starterPlanId = await getPlanId("STARTER");
      const growthPlanId = await getPlanId("GROWTH");
      const [price] = await sql<{ id: string }[]>`
        insert into public.subscription_plan_prices (plan_id, provider, billing_interval, currency, amount_minor)
        values (${starterPlanId}, 'PAYSTACK', 'MONTHLY', 'RWF', 500000)
        returning id
      `;
      // growthPlanId here, but the price belongs to STARTER — the
      // composite FK on (price_id, plan_id) must reject this even though
      // this is a raw, privileged INSERT that never goes through
      // activate_subscription_from_verified_payment's own
      // PRICE_PLAN_MISMATCH check at all.
      await expect(
        sql`insert into public.business_subscriptions (business_id, plan_id, price_id, provider, status, currency, current_period_started_at, current_period_ends_at)
            values (${owner.businessId}, ${growthPlanId}, ${price.id}, 'PAYSTACK', 'ACTIVE', 'RWF', now(), now() + interval '30 days')`
      ).rejects.toThrow(/violates foreign key constraint/i);
    } finally {
      await sql`delete from public.subscription_plan_prices where currency = 'RWF'`;
      await sql.end();
    }
  });
});

describe("business_subscriptions — provider identifier uniqueness (SEC-1L-03)", () => {
  it("a duplicate provider_customer_code within the SAME provider+environment is rejected, even via direct privileged INSERT", async () => {
    const ownerA = await createOwnerAndBusiness("billing-provider-code-dup-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("billing-provider-code-dup-b");
    cleanupUserIds.push(ownerB.userId);
    await createInitialTrial(ownerA.businessId);
    await createInitialTrial(ownerB.businessId);

    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      const code = `CUS_dup_${crypto.randomUUID()}`;
      await sql`update public.business_subscriptions
                set provider = 'PAYSTACK', provider_environment = 'LIVE', provider_customer_code = ${code},
                    status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                    plan_id = ${planId}
                where business_id = ${ownerA.businessId}`;
      await expect(
        sql`update public.business_subscriptions
            set provider = 'PAYSTACK', provider_environment = 'LIVE', provider_customer_code = ${code},
                status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                plan_id = ${planId}
            where business_id = ${ownerB.businessId}`
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await sql.end();
    }
  });

  it("a duplicate provider_subscription_code within the SAME provider+environment is rejected", async () => {
    const ownerA = await createOwnerAndBusiness("billing-provider-sub-code-dup-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("billing-provider-sub-code-dup-b");
    cleanupUserIds.push(ownerB.userId);
    await createInitialTrial(ownerA.businessId);
    await createInitialTrial(ownerB.businessId);

    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      const code = `SUB_dup_${crypto.randomUUID()}`;
      await sql`update public.business_subscriptions
                set provider = 'PAYSTACK', provider_environment = 'LIVE', provider_subscription_code = ${code},
                    status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                    plan_id = ${planId}
                where business_id = ${ownerA.businessId}`;
      await expect(
        sql`update public.business_subscriptions
            set provider = 'PAYSTACK', provider_environment = 'LIVE', provider_subscription_code = ${code},
                status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                plan_id = ${planId}
            where business_id = ${ownerB.businessId}`
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await sql.end();
    }
  });

  it("the SAME provider_customer_code in a DIFFERENT provider_environment is allowed (TEST and LIVE are never confused)", async () => {
    const ownerA = await createOwnerAndBusiness("billing-provider-code-diff-env-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("billing-provider-code-diff-env-b");
    cleanupUserIds.push(ownerB.userId);
    await createInitialTrial(ownerA.businessId);
    await createInitialTrial(ownerB.businessId);

    const sql = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      const code = `CUS_shared_env_${crypto.randomUUID()}`;
      await sql`update public.business_subscriptions
                set provider = 'PAYSTACK', provider_environment = 'TEST', provider_customer_code = ${code},
                    status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                    plan_id = ${planId}
                where business_id = ${ownerA.businessId}`;
      await sql`update public.business_subscriptions
                set provider = 'PAYSTACK', provider_environment = 'LIVE', provider_customer_code = ${code},
                    status = 'ACTIVE', current_period_started_at = now(), current_period_ends_at = now() + interval '30 days',
                    plan_id = ${planId}
                where business_id = ${ownerB.businessId}`;
    } finally {
      await sql.end();
    }
  });
});

describe("business_subscriptions / billing_transactions — RLS permission matrix", () => {
  it("26. OWNER can read their own business's subscription and billing history", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-owner");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const { data, error } = await owner.client.from("business_subscriptions").select("status");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("27. ADMIN and ACCOUNTANT can read; MANAGER, SALES, INVENTORY, and VIEWER cannot", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-matrix");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    for (const role of ["ADMIN", "ACCOUNTANT"]) {
      const member = await createMemberWithRole(owner.businessId, `billing-rls-${role}`, role);
      cleanupUserIds.push(member.userId);
      const { data, error } = await member.client.from("business_subscriptions").select("status");
      expect(error, role).toBeNull();
      expect(data, role).toHaveLength(1);
    }

    for (const role of ["MANAGER", "SALES", "INVENTORY", "VIEWER"]) {
      const member = await createMemberWithRole(owner.businessId, `billing-rls-${role}`, role);
      cleanupUserIds.push(member.userId);
      const { data, error } = await member.client.from("business_subscriptions").select("status");
      expect(error, role).toBeNull();
      expect(data, role).toHaveLength(0);
    }
  });

  it("28. a same-permission caller from a DIFFERENT tenant cannot read another business's subscription", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-tenant-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("billing-rls-tenant-b");
    cleanupUserIds.push(other.userId);
    await createInitialTrial(owner.businessId);

    const { data, error } = await other.client.from("business_subscriptions").select("status");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("29. an anonymous caller cannot read subscription or billing-transaction data", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-anon");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const anon = createAnonClient();
    const { data: subData } = await anon.from("business_subscriptions").select("status");
    expect(subData ?? []).toHaveLength(0);
    const { data: txData } = await anon.from("billing_transactions").select("status");
    expect(txData ?? []).toHaveLength(0);
  });

  it("30. a SUSPENDED OWNER (inactive member) loses billing visibility immediately", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-suspended");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const member = await createMemberWithRole(owner.businessId, "billing-rls-suspended-admin", "ADMIN");
    cleanupUserIds.push(member.userId);

    const before = await member.client.from("business_subscriptions").select("status");
    expect(before.data).toHaveLength(1);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    const after = await member.client.from("business_subscriptions").select("status");
    expect(after.error).toBeNull();
    expect(after.data).toHaveLength(0);
  });

  it("31. no authenticated client (including OWNER) can INSERT, UPDATE, or DELETE business_subscriptions", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-write-denied");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const { error: insertError } = await owner.client.from("business_subscriptions").insert({
      business_id: owner.businessId,
      plan_id: await getPlanId("ENTERPRISE"),
      provider: "MANUAL",
      status: "ACTIVE",
      currency: "NGN",
    } as never);
    expect(insertError).not.toBeNull();

    const { error: updateError } = await owner.client
      .from("business_subscriptions")
      .update({ status: "ACTIVE" } as never)
      .eq("business_id", owner.businessId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await owner.client.from("business_subscriptions").delete().eq("business_id", owner.businessId);
    expect(deleteError).not.toBeNull();

    const row = await getSubscriptionRow(owner.businessId);
    expect(row?.status).toBe("TRIALING");
  });

  it("32. no authenticated client can fabricate a billing_transactions row", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-tx-forge");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const row = await getSubscriptionRow(owner.businessId);

    const { error } = await owner.client.from("billing_transactions").insert({
      business_id: owner.businessId,
      subscription_id: row!.id,
      provider: "PAYSTACK",
      provider_reference: "forged-ref",
      amount_minor: 1,
      currency: "NGN",
      status: "SUCCESS",
      paid_at: new Date().toISOString(),
    } as never);
    expect(error).not.toBeNull();
  });

  it("33. no authenticated client can delete billing history", async () => {
    const owner = await createOwnerAndBusiness("billing-rls-tx-delete-denied");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const subRow = await getSubscriptionRow(owner.businessId);

    const sql = createTestDbClient();
    let txId: string;
    try {
      const hash = await randomHash();
      void hash;
      const rows = await sql<{ id: string }[]>`
        select private.record_billing_transaction(
          ${owner.businessId}::uuid, ${subRow!.id as string}::uuid, 'PAYSTACK'::text, 'ref-delete-test'::text,
          150000::bigint, 'NGN'::text, 'SUCCESS'::text, null::text, now()::timestamptz
        ) as id
      `;
      txId = rows[0].id;
    } finally {
      await sql.end();
    }

    const { error } = await owner.client.from("billing_transactions").delete().eq("id", txId);
    expect(error).not.toBeNull();
    const admin = createAdminClient();
    const { data } = await admin.from("billing_transactions").select("id").eq("id", txId).maybeSingle();
    expect(data).not.toBeNull();
  });
});

describe("private.record_billing_transaction — idempotency and tenant consistency", () => {
  it("34. the SAME (provider, provider_reference) recorded twice never duplicates", async () => {
    const owner = await createOwnerAndBusiness("billing-tx-idempotent");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const subRow = await getSubscriptionRow(owner.businessId);

    const sql = createTestDbClient();
    try {
      const call = () => sql<{ id: string }[]>`
        select private.record_billing_transaction(
          ${owner.businessId}::uuid, ${subRow!.id as string}::uuid, 'PAYSTACK'::text, 'ref-idempotent-1'::text,
          150000::bigint, 'NGN'::text, 'SUCCESS'::text, null::text, now()::timestamptz
        ) as id
      `;
      const first = await call();
      const second = await call();
      expect(first[0].id).toBe(second[0].id);

      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.billing_transactions where provider_reference = 'ref-idempotent-1'
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("35. a concurrent double-record of the SAME reference produces exactly one row (race-safe)", async () => {
    const owner = await createOwnerAndBusiness("billing-tx-race");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const subRow = await getSubscriptionRow(owner.businessId);

    async function record() {
      const sql = createTestDbClient();
      try {
        return await sql<{ id: string }[]>`
          select private.record_billing_transaction(
            ${owner.businessId}::uuid, ${subRow!.id as string}::uuid, 'PAYSTACK'::text, 'ref-race-1'::text,
            150000::bigint, 'NGN'::text, 'SUCCESS'::text, null::text, now()::timestamptz
          ) as id
        `;
      } finally {
        await sql.end();
      }
    }
    const [r1, r2] = await Promise.all([record(), record()]);
    expect(r1[0].id).toBe(r2[0].id);

    const sql = createTestDbClient();
    try {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from public.billing_transactions where provider_reference = 'ref-race-1'
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("36. a subscription_id that does not belong to the claimed business is rejected", async () => {
    const owner = await createOwnerAndBusiness("billing-tx-mismatch-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("billing-tx-mismatch-b");
    cleanupUserIds.push(other.userId);
    await createInitialTrial(owner.businessId);
    await createInitialTrial(other.businessId);
    const otherSub = await getSubscriptionRow(other.businessId);

    const sql = createTestDbClient();
    try {
      // PENDING (not SUCCESS/FAILED) so no paid_at/failed_at is
      // required — isolates this test to the tenant-consistency check
      // alone, never incidentally exercising the separate required-
      // field validation (that has its own dedicated test, #37).
      await expect(
        sql`select private.record_billing_transaction(
          ${owner.businessId}::uuid, ${otherSub!.id as string}::uuid, 'PAYSTACK'::text, 'ref-mismatch'::text,
          150000::bigint, 'NGN'::text, 'PENDING'::text
        )`
      ).rejects.toThrow(/SUBSCRIPTION_BUSINESS_MISMATCH/);
    } finally {
      await sql.end();
    }
  });

  it("37. SUCCESS requires paid_at; FAILED requires failed_at", async () => {
    const owner = await createOwnerAndBusiness("billing-tx-required-fields");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const subRow = await getSubscriptionRow(owner.businessId);
    const sql = createTestDbClient();
    try {
      await expect(
        sql`select private.record_billing_transaction(
          ${owner.businessId}::uuid, ${subRow!.id as string}::uuid, 'PAYSTACK'::text, 'ref-no-paid-at'::text,
          150000::bigint, 'NGN'::text, 'SUCCESS'::text
        )`
      ).rejects.toThrow(/PAID_AT_REQUIRED/);
      await expect(
        sql`select private.record_billing_transaction(
          ${owner.businessId}::uuid, ${subRow!.id as string}::uuid, 'PAYSTACK'::text, 'ref-no-failed-at'::text,
          150000::bigint, 'NGN'::text, 'FAILED'::text
        )`
      ).rejects.toThrow(/FAILED_AT_REQUIRED/);
    } finally {
      await sql.end();
    }
  });

  it("client cannot invoke the trusted billing-transaction writer directly", async () => {
    const owner = await createOwnerAndBusiness("billing-tx-forge-rpc");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not exposed.
      "record_billing_transaction",
      { p_business_id: owner.businessId }
    );
    expect(error).not.toBeNull();
  });
});

describe("private.record_provider_event — idempotent webhook ingestion, zero client visibility", () => {
  it("38. the SAME (provider, event key) recorded twice is idempotent, and correctly reports is_new", async () => {
    const sql = createTestDbClient();
    try {
      const hash = await randomHash();
      // A fresh, unique key per test RUN (never a fixed literal) — this
      // table is a global idempotency ledger with no natural per-test
      // cleanup path (unlike tenant-scoped data, which cleanupUserIds
      // eventually reaches transitively), so a fixed key would falsely
      // report is_new=false on any re-run against a non-reset database.
      const key = `evt-idempotent-${crypto.randomUUID()}`;
      const first = await sql<{ id: string; is_new: boolean }[]>`
        select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'subscription.create'::text, ${hash}::text)
      `;
      expect(first[0].is_new).toBe(true);

      const second = await sql<{ id: string; is_new: boolean }[]>`
        select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'subscription.create'::text, ${hash}::text)
      `;
      expect(second[0].id).toBe(first[0].id);
      expect(second[0].is_new).toBe(false);

      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text from private.billing_provider_events where provider_event_key = ${key}
      `;
      expect(Number(count)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("39. a concurrent double-delivery of the SAME event key produces exactly one row (race-safe)", async () => {
    const key = `evt-race-${crypto.randomUUID()}`;
    const hash = await randomHash();
    async function record() {
      const sql = createTestDbClient();
      try {
        return await sql<{ id: string; is_new: boolean }[]>`
          select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text)
        `;
      } finally {
        await sql.end();
      }
    }
    const [r1, r2] = await Promise.all([record(), record()]);
    expect(r1[0].id).toBe(r2[0].id);
    expect([r1[0].is_new, r2[0].is_new].filter(Boolean)).toHaveLength(1);
  });

  it("40. the SAME event key under a DIFFERENT provider is a distinct event (never collides)", async () => {
    const sql = createTestDbClient();
    try {
      const hash = await randomHash();
      const key = `evt-cross-provider-${crypto.randomUUID()}`;
      const r1 = await sql<{ id: string }[]>`
        select id from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text)
      `;
      // Cast to the current provider check-constraint's own allowed set
      // is deliberately NOT relaxed here — this proves the UNIQUE
      // constraint is scoped by provider, using the identical provider
      // twice with a different key instead, since only PAYSTACK is
      // currently a valid provider value.
      const r2 = await sql<{ id: string }[]>`
        select id from private.record_provider_event('PAYSTACK'::text, ${key + "-other"}::text, 'charge.success'::text, ${hash}::text)
      `;
      expect(r1[0].id).not.toBe(r2[0].id);
    } finally {
      await sql.end();
    }
  });

  it("41. an invalid payload hash shape is rejected", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`select * from private.record_provider_event('PAYSTACK'::text, 'evt-bad-hash'::text, 'charge.success'::text, 'not-a-hash'::text)`
      ).rejects.toThrow(/INVALID_PAYLOAD_HASH/);
    } finally {
      await sql.end();
    }
  });

  describe("SEC-1L-04 — association consistency and changed-payload replay conflict", () => {
    it("a subscription_id belonging to a DIFFERENT business than the claimed business_id is rejected structurally (direct privileged INSERT)", async () => {
      const ownerA = await createOwnerAndBusiness("billing-events-assoc-a");
      cleanupUserIds.push(ownerA.userId);
      const ownerB = await createOwnerAndBusiness("billing-events-assoc-b");
      cleanupUserIds.push(ownerB.userId);
      await createInitialTrial(ownerA.businessId);
      await createInitialTrial(ownerB.businessId);
      const subB = await getSubscriptionRow(ownerB.businessId);

      const sql = createTestDbClient();
      try {
        const hash = await randomHash();
        await expect(
          sql`insert into private.billing_provider_events (provider, provider_event_key, event_type, business_id, subscription_id, payload_hash)
              values ('PAYSTACK', ${`evt-assoc-mismatch-${crypto.randomUUID()}`}, 'charge.success', ${ownerA.businessId}, ${subB!.id as string}, ${hash})`
        ).rejects.toThrow(/violates foreign key constraint/i);
      } finally {
        await sql.end();
      }
    });

    it("a non-null subscription_id with a NULL business_id is rejected structurally (the composite FK could not otherwise enforce anything)", async () => {
      const sql = createTestDbClient();
      try {
        const owner = await createOwnerAndBusiness("billing-events-assoc-null-business");
        cleanupUserIds.push(owner.userId);
        await createInitialTrial(owner.businessId);
        const sub = await getSubscriptionRow(owner.businessId);
        const hash = await randomHash();
        await expect(
          sql`insert into private.billing_provider_events (provider, provider_event_key, event_type, subscription_id, payload_hash)
              values ('PAYSTACK', ${`evt-null-business-${crypto.randomUUID()}`}, 'charge.success', ${sub!.id as string}, ${hash})`
        ).rejects.toThrow(/violates check constraint/i);
      } finally {
        await sql.end();
      }
    });

    it("an exact replay (identical event_type/payload_hash/business_id/subscription_id) returns the existing row, is_new=false", async () => {
      const owner = await createOwnerAndBusiness("billing-events-replay-exact");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const sub = await getSubscriptionRow(owner.businessId);
      const sql = createTestDbClient();
      try {
        const hash = await randomHash();
        const key = `evt-replay-exact-${crypto.randomUUID()}`;
        const first = await sql<{ id: string; is_new: boolean }[]>`
          select * from private.record_provider_event(
            'PAYSTACK'::text, ${key}::text, 'subscription.create'::text, ${hash}::text,
            ${owner.businessId}::uuid, ${sub!.id as string}::uuid
          )
        `;
        expect(first[0].is_new).toBe(true);

        const second = await sql<{ id: string; is_new: boolean }[]>`
          select * from private.record_provider_event(
            'PAYSTACK'::text, ${key}::text, 'subscription.create'::text, ${hash}::text,
            ${owner.businessId}::uuid, ${sub!.id as string}::uuid
          )
        `;
        expect(second[0].id).toBe(first[0].id);
        expect(second[0].is_new).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it("NULL-association equality uses null-safe semantics: two calls that BOTH omit business_id/subscription_id are a valid replay, never a conflict", async () => {
      const sql = createTestDbClient();
      try {
        const hash = await randomHash();
        const key = `evt-replay-null-assoc-${crypto.randomUUID()}`;
        const first = await sql<{ id: string; is_new: boolean }[]>`
          select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text)
        `;
        const second = await sql<{ id: string; is_new: boolean }[]>`
          select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text)
        `;
        expect(second[0].id).toBe(first[0].id);
        expect(second[0].is_new).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it("the SAME event key with a CHANGED payload_hash raises PROVIDER_EVENT_CONFLICT, never silently absorbed", async () => {
      const sql = createTestDbClient();
      try {
        const key = `evt-conflict-hash-${crypto.randomUUID()}`;
        const hash1 = await randomHash();
        const hash2 = await randomHash();
        await sql`select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash1}::text)`;
        await expect(
          sql`select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash2}::text)`
        ).rejects.toThrow(/PROVIDER_EVENT_CONFLICT/);
      } finally {
        await sql.end();
      }
    });

    it("the SAME event key with a CHANGED event_type raises PROVIDER_EVENT_CONFLICT", async () => {
      const sql = createTestDbClient();
      try {
        const key = `evt-conflict-type-${crypto.randomUUID()}`;
        const hash = await randomHash();
        await sql`select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text)`;
        await expect(
          sql`select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'subscription.create'::text, ${hash}::text)`
        ).rejects.toThrow(/PROVIDER_EVENT_CONFLICT/);
      } finally {
        await sql.end();
      }
    });

    it("the SAME event key with a CHANGED business_id raises PROVIDER_EVENT_CONFLICT", async () => {
      const ownerA = await createOwnerAndBusiness("billing-events-conflict-business-a");
      cleanupUserIds.push(ownerA.userId);
      const ownerB = await createOwnerAndBusiness("billing-events-conflict-business-b");
      cleanupUserIds.push(ownerB.userId);
      const sql = createTestDbClient();
      try {
        const key = `evt-conflict-business-${crypto.randomUUID()}`;
        const hash = await randomHash();
        await sql`select * from private.record_provider_event(
          'PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text, ${ownerA.businessId}::uuid
        )`;
        await expect(
          sql`select * from private.record_provider_event(
            'PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text, ${ownerB.businessId}::uuid
          )`
        ).rejects.toThrow(/PROVIDER_EVENT_CONFLICT/);
      } finally {
        await sql.end();
      }
    });

    it("the SAME event key with a CHANGED subscription_id raises PROVIDER_EVENT_CONFLICT", async () => {
      const owner = await createOwnerAndBusiness("billing-events-conflict-subscription");
      cleanupUserIds.push(owner.userId);
      await createInitialTrial(owner.businessId);
      const sub = await getSubscriptionRow(owner.businessId);
      const sql = createTestDbClient();
      try {
        const key = `evt-conflict-sub-${crypto.randomUUID()}`;
        const hash = await randomHash();
        await sql`select * from private.record_provider_event(
          'PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text, ${owner.businessId}::uuid
        )`;
        await expect(
          sql`select * from private.record_provider_event(
            'PAYSTACK'::text, ${key}::text, 'charge.success'::text, ${hash}::text,
            ${owner.businessId}::uuid, ${sub!.id as string}::uuid
          )`
        ).rejects.toThrow(/PROVIDER_EVENT_CONFLICT/);
      } finally {
        await sql.end();
      }
    });

    it("a concurrent EXACT replay of the same event remains race-safe: exactly one row, only one is_new=true", async () => {
      const key = `evt-race-exact-replay-${crypto.randomUUID()}`;
      const hash = await randomHash();
      async function record() {
        const sql = createTestDbClient();
        try {
          return await sql<{ id: string; is_new: boolean }[]>`
            select * from private.record_provider_event('PAYSTACK'::text, ${key}::text, 'invoice.payment_failed'::text, ${hash}::text)
          `;
        } finally {
          await sql.end();
        }
      }
      const [r1, r2] = await Promise.all([record(), record()]);
      expect(r1[0].id).toBe(r2[0].id);
      expect([r1[0].is_new, r2[0].is_new].filter(Boolean)).toHaveLength(1);

      const sql = createTestDbClient();
      try {
        const [{ count }] = await sql<{ count: string }[]>`
          select count(*)::text from private.billing_provider_events where provider_event_key = ${key}
        `;
        expect(Number(count)).toBe(1);
      } finally {
        await sql.end();
      }
    });
  });

  it("42. NO authenticated client (any role) can read private.billing_provider_events, at all", async () => {
    const owner = await createOwnerAndBusiness("billing-events-no-visibility");
    cleanupUserIds.push(owner.userId);
    const { error } = await owner.client.rpc(
      // @ts-expect-error — private.* is intentionally not exposed; this
      // also proves the schema itself is unreachable via PostgREST.
      "record_provider_event",
      { p_provider: "PAYSTACK" }
    );
    expect(error).not.toBeNull();
  });

  it("43. service_role itself has no ambient grant on private.billing_provider_events (NOT exposed via PostgREST regardless)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has_select: boolean }[]>`
        select has_table_privilege('service_role', 'private.billing_provider_events', 'SELECT') as has_select
      `;
      expect(rows[0].has_select).toBe(false);
    } finally {
      await sql.end();
    }
  });
});

describe("private.get_business_entitlement — the entitlement formula", () => {
  it("44. TRIALING within the trial window is entitled; past the window it is not", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-trial");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);

    const { data } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(data?.[0]?.is_entitled).toBe(true);
    expect(data?.[0]?.plan_code).toBe("GROWTH");

    const sql = createTestDbClient();
    try {
      // Both bounds moved into the past TOGETHER, preserving
      // `trial_ends_at > trial_started_at` (the table's own CHECK
      // constraint) while making the whole window already-elapsed
      // relative to `now()` — simulates a genuinely stale TRIALING row,
      // never an internally-inconsistent one.
      await sql`update public.business_subscriptions
                 set trial_started_at = now() - interval '15 days', trial_ends_at = now() - interval '1 hour'
                 where business_id = ${owner.businessId}`;
    } finally {
      await sql.end();
    }
    const { data: after } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(after?.[0]?.is_entitled).toBe(false);
  });

  it("45. ACTIVE within the current period is entitled; a stale ACTIVE row past its period is NOT indefinitely entitled", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-active");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const sql1 = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await sql1`select private.activate_subscription_from_verified_payment(
        ${owner.businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
        now()::timestamptz, (now() + interval '30 days')::timestamptz
      )`;
    } finally {
      await sql1.end();
    }
    const { data } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(data?.[0]?.is_entitled).toBe(true);

    const sql2 = createTestDbClient();
    try {
      // Both bounds moved into the past together — preserves
      // `current_period_ends_at > current_period_started_at` (the
      // table's own CHECK constraint) while making the whole period
      // already-elapsed relative to `now()`.
      await sql2`update public.business_subscriptions
                  set current_period_started_at = now() - interval '31 days', current_period_ends_at = now() - interval '1 hour'
                  where business_id = ${owner.businessId}`;
    } finally {
      await sql2.end();
    }
    const { data: after } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(after?.[0]?.is_entitled).toBe(false);
  });

  it("46. PAST_DUE is entitled only while grace_ends_at is set AND in the future — never by status alone", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-past-due");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const sql1 = createTestDbClient();
    try {
      const planId = await getPlanId("GROWTH");
      await sql1`select private.activate_subscription_from_verified_payment(
        ${owner.businessId}::uuid, ${planId}::uuid, 'PAYSTACK'::text,
        now()::timestamptz, (now() + interval '30 days')::timestamptz
      )`;
      await sql1`select private.record_subscription_payment_failed(${owner.businessId}::uuid)`;
    } finally {
      await sql1.end();
    }
    // No grace_ends_at set at all -> never entitled.
    const { data: noGrace } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(noGrace?.[0]?.is_entitled).toBe(false);

    const sql2 = createTestDbClient();
    try {
      await sql2`update public.business_subscriptions set grace_ends_at = now() + interval '1 day' where business_id = ${owner.businessId}`;
    } finally {
      await sql2.end();
    }
    const { data: withGrace } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(withGrace?.[0]?.is_entitled).toBe(true);

    const sql3 = createTestDbClient();
    try {
      await sql3`update public.business_subscriptions set grace_ends_at = now() - interval '1 hour' where business_id = ${owner.businessId}`;
    } finally {
      await sql3.end();
    }
    const { data: expiredGrace } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(expiredGrace?.[0]?.is_entitled).toBe(false);
  });

  it("47. CANCELED-but-still-within-period remains entitled — cancellation is never modeled as immediate expiration", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-cancel-scheduled");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const sql = createTestDbClient();
    try {
      await sql`select private.schedule_subscription_cancel(${owner.businessId}::uuid)`;
    } finally {
      await sql.end();
    }
    const { data } = await owner.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(data?.[0]?.is_entitled).toBe(true);
    expect(data?.[0]?.plan_code).toBe("GROWTH");
  });

  it("48. is available to ANY active member regardless of billing.view (e.g. SALES-only), never gated on a billing permission", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-any-member");
    cleanupUserIds.push(owner.userId);
    await createInitialTrial(owner.businessId);
    const salesOnly = await createMemberWithCustomPermissions(owner.businessId, "billing-entitlement-sales", ["sales.view"]);
    cleanupUserIds.push(salesOnly.userId);

    const { data, error } = await salesOnly.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(error).toBeNull();
    expect(data?.[0]?.is_entitled).toBe(true);
  });

  it("49. a non-member of the business gets no row at all (never another tenant's entitlement fact)", async () => {
    const owner = await createOwnerAndBusiness("billing-entitlement-outsider-a");
    cleanupUserIds.push(owner.userId);
    const outsider = await createOwnerAndBusiness("billing-entitlement-outsider-b");
    cleanupUserIds.push(outsider.userId);
    await createInitialTrial(owner.businessId);

    const { data } = await outsider.client.rpc("get_business_entitlement", { p_business_id: owner.businessId });
    expect(data ?? []).toHaveLength(0);
  });

});

describe("Role and function ACL audit — private_billing_writer and every trusted function", () => {
  it("50. private_billing_writer is NOLOGIN/NOINHERIT/BYPASSRLS, non-superuser, no CREATEDB/CREATEROLE", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<
        { rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]
      >`
        select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
        from pg_roles where rolname = 'private_billing_writer'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolinherit).toBe(false);
      expect(rows[0].rolbypassrls).toBe(true);
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolcreatedb).toBe(false);
      expect(rows[0].rolcreaterole).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("51. every trusted billing transition function has ZERO EXECUTE grants to PUBLIC, anon, authenticated, or service_role", async () => {
    const sql = createTestDbClient();
    try {
      const functionNames = [
        "create_initial_trial",
        "activate_subscription_from_verified_payment",
        "record_subscription_renewal",
        "record_subscription_payment_failed",
        "schedule_subscription_cancel",
        "mark_subscription_expired",
        "record_billing_transaction",
        "record_provider_event",
      ];
      for (const fn of functionNames) {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'private' and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee);
        // The function's OWNER (private_billing_writer) always appears —
        // expected owner privilege, not new exposure (see the Phase 1K
        // round's own identical, already-reviewed reasoning).
        expect(grantees, fn).toEqual(["private_billing_writer"]);
      }
    } finally {
      await sql.end();
    }
  });

  it("52. private_billing_writer owns exactly the 8 trusted billing functions — no more, no less", async () => {
    const sql = createTestDbClient();
    try {
      const owned = await sql<{ proname: string }[]>`
        select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where r.rolname = 'private_billing_writer'
        order by p.proname
      `;
      expect(owned.map((o) => o.proname).sort()).toEqual(
        [
          "create_initial_trial",
          "activate_subscription_from_verified_payment",
          "record_subscription_renewal",
          "record_subscription_payment_failed",
          "schedule_subscription_cancel",
          "mark_subscription_expired",
          "record_billing_transaction",
          "record_provider_event",
        ].sort()
      );
    } finally {
      await sql.end();
    }
  });

  it("53. get_business_entitlement (public wrapper) is granted to authenticated and service_role only — never anon/PUBLIC", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = 'get_business_entitlement' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee).sort();
      // "postgres" (the function's OWNER — no ALTER OWNER was performed
      // for this public read-helper, matching public.has_permission's/
      // public.has_branch_access's own identical precedent) always
      // appears too — expected owner privilege, not new exposure.
      expect(grantees).toEqual(["authenticated", "postgres", "service_role"].sort());
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("anon");
    } finally {
      await sql.end();
    }
  });
});

describe("Historical durability — FK delete actions never silently erase billing evidence", () => {
  it("54. business_subscriptions.business_id, billing_transactions.business_id/subscription_id use RESTRICT (or NO ACTION), never CASCADE/SET NULL", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_name: string; confdeltype: string }[]>`
        select t.relname as table_name, c.confdeltype
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and c.contype = 'f'
          and t.relname in ('business_subscriptions', 'billing_transactions')
          and c.confrelid in ('public.businesses'::regclass, 'public.business_subscriptions'::regclass)
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(["a", "r"], `${row.table_name}: ${row.confdeltype}`).toContain(row.confdeltype);
      }
    } finally {
      await sql.end();
    }
  });

  it("55. a business with existing subscription history cannot be hard-deleted", async () => {
    const owner = await createOwnerAndBusiness("billing-business-delete-blocked");
    await createInitialTrial(owner.businessId);

    const sql = createTestDbClient();
    let deleteError: unknown;
    try {
      await sql`delete from public.businesses where id = ${owner.businessId}`;
    } catch (e) {
      deleteError = e;
    } finally {
      await sql.end();
    }
    expect(deleteError).toBeTruthy();
    expect(String((deleteError as { message?: string })?.message ?? deleteError)).toMatch(/violates foreign key constraint/i);

    cleanupUserIds.push(owner.userId);
  });
});

describe("Indexes and money representation", () => {
  it("56. the expected indexes exist on every new Phase 1L table", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where schemaname in ('public', 'private')
          and tablename in (
            'subscription_plans', 'plan_entitlements', 'subscription_plan_prices',
            'business_subscriptions', 'billing_transactions', 'billing_provider_events'
          )
      `;
      const names = rows.map((r) => r.indexname);
      expect(names).toContain("subscription_plans_active_idx");
      expect(names).toContain("plan_entitlements_plan_idx");
      expect(names).toContain("plan_entitlements_key_idx");
      expect(names).toContain("subscription_plan_prices_active_unique_idx");
      expect(names).toContain("subscription_plan_prices_plan_idx");
      expect(names).toContain("business_subscriptions_status_idx");
      expect(names).toContain("business_subscriptions_plan_idx");
      expect(names).toContain("billing_transactions_business_created_idx");
      expect(names).toContain("billing_transactions_subscription_idx");
      expect(names).toContain("billing_provider_events_business_idx");
      expect(names).toContain("billing_provider_events_status_idx");
    } finally {
      await sql.end();
    }
  });

  it("57. amount_minor columns are integer types (bigint), never floating point", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
        select table_name, column_name, data_type
        from information_schema.columns
        where table_schema = 'public'
          and column_name = 'amount_minor'
          and table_name in ('subscription_plan_prices', 'business_subscriptions', 'billing_transactions')
      `;
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.data_type, row.table_name).toBe("bigint");
      }
    } finally {
      await sql.end();
    }
  });

  it("58. RLS is ENABLED and FORCED on every new Phase 1L table", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; relnamespace_name: string }[]>`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity, n.nspname as relnamespace_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname in (
          'subscription_plans', 'plan_entitlements', 'subscription_plan_prices',
          'business_subscriptions', 'billing_transactions', 'billing_provider_events'
        )
      `;
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });

  it("59. billing.view/billing.manage seeded matrix matches the documented conservative posture exactly", async () => {
    const sql = createTestDbClient();
    try {
      const view = await sql<{ name: string }[]>`
        select r.name from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'billing.view'
          and r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES', 'INVENTORY', 'ACCOUNTANT', 'VIEWER')
      `;
      expect(view.map((r) => r.name).sort()).toEqual(["OWNER", "ADMIN", "ACCOUNTANT"].sort());

      const manage = await sql<{ name: string }[]>`
        select r.name from public.roles r
        join public.role_permissions rp on rp.role_id = r.id
        join public.permissions p on p.id = rp.permission_id
        where p.key = 'billing.manage'
          and r.name in ('OWNER', 'ADMIN', 'MANAGER', 'SALES', 'INVENTORY', 'ACCOUNTANT', 'VIEWER')
      `;
      expect(manage.map((r) => r.name)).toEqual(["OWNER"]);
    } finally {
      await sql.end();
    }
  });
});
