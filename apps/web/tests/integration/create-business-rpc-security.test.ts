// Phase 1Q-0B-0B remediation. These tests exist specifically because the
// prior integration suite only ever exercised create_business through the
// Server Action's own already-validated inputs — it never proved the RPC
// itself rejects a direct authenticated caller who skips the Server
// Action's country/currency/timezone/activation checks entirely. That gap
// IS the vulnerability the Codex review found: the RPC is a SECURITY
// DEFINER function granted directly to `authenticated`, reachable by any
// signed-in client via supabase.rpc("create_business", ...) regardless of
// what the browser-facing form does.
import { describe, expect, it, afterEach } from "vitest";
import { createConfirmedTestUser, createUserClient, deleteTestUser } from "./helpers/admin-client";
import { createTestDbClient } from "./helpers/db-client";

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function signedInClient(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: "Password1234" });
  return { client, userId: user.id as string };
}

async function assertNoSideEffects(slugPrefix: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql`
      select id from public.businesses where slug like ${slugPrefix + "%"}
    `;
    expect(rows.length).toBe(0);
  } finally {
    await sql.end();
  }
}

describe("create_business RPC — non-NGN activation gate cannot be bypassed by a direct authenticated call", () => {
  const cases: Array<{ label: string; country: string; currency: string; timezone: string }> = [
    { label: "Ghana", country: "GH", currency: "GHS", timezone: "Africa/Accra" },
    { label: "Kenya", country: "KE", currency: "KES", timezone: "Africa/Nairobi" },
    { label: "South Africa", country: "ZA", currency: "ZAR", timezone: "Africa/Johannesburg" },
    { label: "United Kingdom", country: "GB", currency: "GBP", timezone: "Europe/London" },
    { label: "United States", country: "US", currency: "USD", timezone: "America/New_York" },
  ];

  for (const { label, country, currency, timezone } of cases) {
    it(`rejects a fully well-formed, correctly-paired ${label} business (COUNTRY_NOT_YET_OPERATIONAL, not a validation error)`, async () => {
      const { client, userId } = await signedInClient(`rpc-gate-${country.toLowerCase()}`);
      cleanupUserIds.push(userId);
      const slug = `rpc-gate-${country.toLowerCase()}-${Date.now()}`;

      const { data, error } = await client.rpc("create_business", {
        p_name: `${label} Traders`,
        p_slug: slug,
        p_country_code: country,
        p_currency_code: currency,
        p_timezone: timezone,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      await assertNoSideEffects(slug);
    });
  }
});

describe("create_business RPC — unsupported/mismatched country, currency, and timezone combinations", () => {
  const cases: Array<{ label: string; country: string; currency: string; timezone: string }> = [
    { label: "unsupported country (FR) with mismatched currency/timezone", country: "FR", currency: "CHF", timezone: "Europe/London" },
    { label: "NG paired with a foreign currency (USD)", country: "NG", currency: "USD", timezone: "Africa/Lagos" },
    { label: "NG paired with a foreign timezone (America/Chicago)", country: "NG", currency: "NGN", timezone: "America/Chicago" },
    { label: "US paired with a foreign currency (GBP)", country: "US", currency: "GBP", timezone: "America/New_York" },
  ];

  for (const { label, country, currency, timezone } of cases) {
    it(`rejects ${label}`, async () => {
      const { client, userId } = await signedInClient("rpc-mismatch");
      cleanupUserIds.push(userId);
      const slug = `rpc-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const { data, error } = await client.rpc("create_business", {
        p_name: "Mismatch Co",
        p_slug: slug,
        p_country_code: country,
        p_currency_code: currency,
        p_timezone: timezone,
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      await assertNoSideEffects(slug);
    });
  }

  it("rejects an unsupported country even with no currency/timezone supplied (default-derivation path)", async () => {
    const { client, userId } = await signedInClient("rpc-unsupported-bare");
    cleanupUserIds.push(userId);
    const slug = `rpc-unsupported-bare-${Date.now()}`;

    const { data, error } = await client.rpc("create_business", {
      p_name: "Unsupported Bare Co",
      p_slug: slug,
      p_country_code: "FR",
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    await assertNoSideEffects(slug);
  });
});

describe("create_business RPC — no partial side effects on any rejected direct call", () => {
  it("a rejected GH call creates no business, subscription, audit event, notification, or branch", async () => {
    const { client, userId } = await signedInClient("rpc-no-side-effects");
    cleanupUserIds.push(userId);
    const slug = `rpc-no-side-effects-${Date.now()}`;

    const { error } = await client.rpc("create_business", {
      p_name: "No Side Effects Co",
      p_slug: slug,
      p_country_code: "GH",
      p_currency_code: "GHS",
      p_timezone: "Africa/Accra",
    });
    expect(error).not.toBeNull();

    const sql = createTestDbClient();
    try {
      const [business] = await sql`select id from public.businesses where slug = ${slug}`;
      expect(business).toBeUndefined();

      const [subscription] = await sql`
        select bs.id from public.business_subscriptions bs
        join public.businesses b on b.id = bs.business_id
        where b.slug = ${slug}
      `;
      expect(subscription).toBeUndefined();

      const [audit] = await sql`
        select ae.id from public.audit_events ae
        join public.businesses b on b.id = ae.business_id
        where b.slug = ${slug}
      `;
      expect(audit).toBeUndefined();

      const [notification] = await sql`
        select n.id from public.notifications n
        join public.businesses b on b.id = n.business_id
        where b.slug = ${slug}
      `;
      expect(notification).toBeUndefined();

      const [branch] = await sql`
        select bb.id from public.business_branches bb
        join public.businesses b on b.id = bb.business_id
        where b.slug = ${slug}
      `;
      expect(branch).toBeUndefined();

      const [membership] = await sql`
        select bm.id from public.business_members bm
        join public.businesses b on b.id = bm.business_id
        where b.slug = ${slug}
      `;
      expect(membership).toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});

describe("create_business RPC — Nigeria direct call still succeeds with every downstream effect intact", () => {
  it("NG/NGN/Africa/Lagos creates a business, owner membership, default branch, trial, audit event, and notification", async () => {
    const { client, userId } = await signedInClient("rpc-ng-success");
    cleanupUserIds.push(userId);
    const slug = `rpc-ng-success-${Date.now()}`;

    const { data, error } = await client.rpc("create_business", {
      p_name: "Lagos Direct Co",
      p_slug: slug,
      p_country_code: "NG",
      p_currency_code: "NGN",
      p_timezone: "Africa/Lagos",
    });
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data?.country_code).toBe("NG");
    expect(data?.currency_code).toBe("NGN");
    expect(data?.timezone).toBe("Africa/Lagos");

    const sql = createTestDbClient();
    try {
      const [membership] = await sql`
        select bm.id, r.name as role_name
        from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = ${data!.id} and bm.user_id = ${userId}
      `;
      expect(membership?.role_name).toBe("OWNER");

      const [branch] = await sql`select id from public.business_branches where business_id = ${data!.id}`;
      expect(branch).toBeDefined();

      const [subscription] = await sql`
        select sp.code as plan_code
        from public.business_subscriptions bs
        join public.subscription_plans sp on sp.id = bs.plan_id
        where bs.business_id = ${data!.id}
      `;
      expect(subscription?.plan_code).toBe("GROWTH");

      const [audit] = await sql`
        select action from public.audit_events
        where business_id = ${data!.id} and action = 'subscription.trial_started'
      `;
      expect(audit).toBeDefined();

      const [notification] = await sql`
        select notification_type from public.notifications
        where business_id = ${data!.id} and notification_type = 'subscription.trial_started'
      `;
      expect(notification).toBeDefined();
    } finally {
      await sql.end();
    }
  });

  it("the legacy 2-argument call (name, slug) still resolves to NG/NGN/Africa/Lagos with no overload ambiguity", async () => {
    const { client, userId } = await signedInClient("rpc-legacy-2arg");
    cleanupUserIds.push(userId);
    const slug = `rpc-legacy-2arg-${Date.now()}`;

    const { data, error } = await client.rpc("create_business", {
      p_name: "Legacy Two Arg Co",
      p_slug: slug,
    });
    expect(error).toBeNull();
    expect(data?.country_code).toBe("NG");
    expect(data?.currency_code).toBe("NGN");
    expect(data?.timezone).toBe("Africa/Lagos");
  });
});

describe("businesses.timezone — direct table UPDATE cannot desynchronize timezone from country (DB integrity, not just app validation)", () => {
  it("a service-role write pairing an NG business with a non-NG timezone is rejected at the database level", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ id: string }[]>`
        insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
        select 'NG Bypass Attempt', 'ng-bypass-attempt-' || floor(random() * 1e9)::text, id, 'NG', 'NGN', 'Africa/Lagos'
        from auth.users limit 1
        returning id
      `;
      expect(row).toBeDefined();

      await expect(
        sql`update public.businesses set timezone = 'America/Chicago' where id = ${row.id}`
      ).rejects.toThrow();

      const [after] = await sql`select timezone from public.businesses where id = ${row.id}`;
      expect(after.timezone).toBe("Africa/Lagos");
    } finally {
      await sql.end();
    }
  });

  it("a direct insert pairing GB with an unrelated valid timezone (America/New_York) is rejected at the database level", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
          select 'GB Bypass Attempt', 'gb-bypass-attempt-' || floor(random() * 1e9)::text, id, 'GB', 'GBP', 'America/New_York'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("a US business may still switch between its own multiple valid timezones directly (pairing check is per-country, not per-single-value)", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ id: string }[]>`
        insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
        select 'US Multi TZ Co', 'us-multi-tz-' || floor(random() * 1e9)::text, id, 'US', 'USD', 'America/New_York'
        from auth.users limit 1
        returning id
      `;
      await expect(
        sql`update public.businesses set timezone = 'America/Denver' where id = ${row.id}`
      ).resolves.toBeDefined();
    } finally {
      await sql.end();
    }
  });
});
