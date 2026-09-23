import { describe, expect, it, afterEach } from "vitest";
import {
  createConfirmedTestUser,
  createUserClient,
  deleteTestUser,
} from "./helpers/admin-client";
import { createOwnerAndBusiness, addMemberWithRole } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1Q-0B-0B FINAL LOW-FINDING FOLLOW-UP (LOW finding #2): the two
// suites above already prove the businesses_timezone_country_check
// constraint rejects a bad pairing at the database level, but only via a
// privileged service-role connection — never through the exact real-world
// authenticated PostgREST UPDATE path a signed-in owner actually uses.
// These fixtures build that authenticated path directly: a real signed-in
// user, a real OWNER membership, and the ordinary `.from("businesses")
// .update(...)` call lib/business/actions.ts itself issues — never a
// helper-function call standing in for it.
async function createUsFixtureOwner(prefix: string) {
  const { client, userId } = await signedInClient(prefix);
  const sql = createTestDbClient();
  let businessId: string;
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
      values (${prefix}, ${prefix + "-" + Date.now()}, ${userId}, 'US', 'USD', 'America/New_York')
      returning id
    `;
    businessId = row.id;
  } finally {
    await sql.end();
  }
  // service-role fixture insertion is required strictly for setup: the
  // create_business RPC's own operational-activation gate
  // (private.is_fully_operational_country) intentionally blocks any
  // non-NG business from being created through the real app/RPC path
  // (see create-business-rpc-security.test.ts), so a US structural
  // fixture cannot be built any other way. The ACTION UNDER TEST in every
  // assertion below is still the authenticated client's own
  // `.from("businesses").update(...)` call, never this fixture insert.
  //
  // No addMemberWithRole call here: businesses_create_owner_membership
  // (20260825202825_owner_membership_and_last_owner_protection.sql)
  // already fires on this same insert and gives created_by an OWNER
  // membership (with branch access) automatically — calling
  // addMemberWithRole afterward would collide with that same unique
  // (business_id, user_id) row.
  return { client, userId, businessId };
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function signedInClient(prefix: string) {
  const email = `${prefix}-${Date.now()}@example.test`;
  const user = await createConfirmedTestUser(email, "Password1234");
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: "Password1234" });
  return { client, userId: user.id as string };
}

describe("create_business timezone", () => {
  it("a legacy call with no timezone (and no country) still succeeds and gets Africa/Lagos", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("tz-legacy-call");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("businesses")
      .select("timezone")
      .eq("id", businessId)
      .single();
    expect(error).toBeNull();
    expect(data?.timezone).toBe("Africa/Lagos");
  });

  // Codex remediation (Phase 1Q-0B-0B): GH and US are supported catalog
  // countries but are NOT yet fully operational — the RPC boundary itself
  // now enforces the NG-only activation gate (private.
  // is_fully_operational_country), not just the Server Action. These two
  // scenarios moved to tests/integration/create-business-rpc-security.test.ts
  // as explicit rejection assertions; see that file for the non-NG direct
  // RPC adversarial suite. Country-default-timezone derivation for a
  // supported-but-not-yet-operational country, and an explicit non-default
  // timezone choice, are covered there against a hypothetical once NG-only
  // is lifted would need re-adding these as success cases.
  it("an explicit country with no timezone derives the country's default timezone (NG, the only operational country)", async () => {
    const { client, userId } = await signedInClient("tz-derive");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Lagos Traders",
      p_slug: `lagos-traders-${Date.now()}`,
      p_country_code: "NG",
    });
    expect(error).toBeNull();
    expect(data?.timezone).toBe("Africa/Lagos");
  });

  it("rejects a timezone outside the supported catalog", async () => {
    const { client, userId } = await signedInClient("tz-bad");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Bad Timezone Co",
      p_slug: `bad-timezone-${Date.now()}`,
      p_country_code: "NG",
      p_timezone: "Europe/Paris",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a lowercase/mistyped-case timezone (case-sensitive, unlike country/currency codes)", async () => {
    const { client, userId } = await signedInClient("tz-case");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Case Sensitive Co",
      p_slug: `case-sensitive-${Date.now()}`,
      p_country_code: "NG",
      p_timezone: "africa/lagos",
    });
    expect(error).not.toBeNull();
  });
});

describe("businesses.timezone column constraints and backfill", () => {
  it("timezone cannot be null (direct service-role write)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code, currency_code)
          select 'Null Timezone Test', 'null-timezone-test-' || floor(random() * 1e9)::text, id, 'NG', 'NGN'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejects an unsupported timezone value at the table level", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
          select 'Bad Timezone Check', 'bad-timezone-check-' || floor(random() * 1e9)::text, id, 'NG', 'NGN', 'Mars/Olympus_Mons'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("every existing business has a non-null, catalog-supported timezone (backfill proof)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql`
        select count(*)::int as n
        from public.businesses
        where timezone is null
           or timezone not in (
             'Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg',
             'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'
           )
      `;
      expect(rows[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("timezone is editable via authenticated update (RLS + column grant), country/currency remain governed by the same business.manage policy", () => {
  it("a member with business.manage (OWNER, the sole member at creation) can update timezone directly", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("tz-owner-update");
    cleanupUserIds.push(userId);

    const { error } = await client
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId);
    expect(error).toBeNull();
  });

  it("a non-member cannot update another business's timezone", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("tz-rls-owner");
    const { client: outsiderClient, userId: outsiderId } = await createOwnerAndBusiness("tz-rls-outsider");
    cleanupUserIds.push(ownerId, outsiderId);

    const { data, error } = await outsiderClient
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId)
      .select();
    // RLS silently matches zero rows rather than raising — mirrors this
    // codebase's other cross-tenant RLS assertions (no error, no rows).
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a member holding VIEWER (no business.manage) cannot update timezone — the actual server boundary, not merely a disabled UI affordance", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("tz-viewer-owner");
    const { client: viewerClient, userId: viewerId } = await signedInClient("tz-viewer-member");
    cleanupUserIds.push(ownerId, viewerId);
    await addMemberWithRole(businessId, viewerId, "VIEWER");

    const { data, error } = await viewerClient
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId)
      .select();
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("businesses_timezone_country_check via the real authenticated PostgREST UPDATE path (Phase 1Q-0B-0B LOW finding #2)", () => {
  it("an authenticated NG OWNER can update timezone to Africa/Lagos (already its own country's only valid value)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("tz-ng-owner-valid");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId)
      .select();
    expect(error).toBeNull();
    expect(data?.[0]?.timezone).toBe("Africa/Lagos");
  });

  it("an authenticated NG OWNER is rejected by the database constraint when switching to a foreign timezone (America/Chicago), and the stored value is unchanged", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("tz-ng-owner-invalid");
    cleanupUserIds.push(userId);

    const { error } = await client
      .from("businesses")
      .update({ timezone: "America/Chicago" })
      .eq("id", businessId);
    expect(error).not.toBeNull();

    const sql = createTestDbClient();
    try {
      const [row] = await sql`select timezone from public.businesses where id = ${businessId}`;
      expect(row.timezone).toBe("Africa/Lagos");
    } finally {
      await sql.end();
    }
  });

  it("an authenticated US OWNER may switch between its own country's valid timezones (America/New_York -> America/Chicago)", async () => {
    const { client, businessId, userId } = await createUsFixtureOwner("tz-us-owner-valid");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("businesses")
      .update({ timezone: "America/Chicago" })
      .eq("id", businessId)
      .select();
    expect(error).toBeNull();
    expect(data?.[0]?.timezone).toBe("America/Chicago");
  });

  it("an authenticated US OWNER is rejected by the database constraint when switching to a foreign timezone (Africa/Lagos), and the last valid US timezone persists", async () => {
    const { client, businessId, userId } = await createUsFixtureOwner("tz-us-owner-invalid");
    cleanupUserIds.push(userId);

    const { error: firstError } = await client
      .from("businesses")
      .update({ timezone: "America/Chicago" })
      .eq("id", businessId);
    expect(firstError).toBeNull();

    const { error } = await client
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId);
    expect(error).not.toBeNull();

    const sql = createTestDbClient();
    try {
      const [row] = await sql`select timezone from public.businesses where id = ${businessId}`;
      expect(row.timezone).toBe("America/Chicago");
    } finally {
      await sql.end();
    }
  });

  it("a VIEWER (no business.manage) attempting a timezone update is denied by RLS, not the CHECK constraint", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("tz-check-viewer-owner");
    const { client: viewerClient, userId: viewerId } = await signedInClient("tz-check-viewer");
    cleanupUserIds.push(ownerId, viewerId);
    await addMemberWithRole(businessId, viewerId, "VIEWER");

    const { data, error } = await viewerClient
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId)
      .select();
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("an authenticated user from another business cannot update this business's timezone (cross-tenant, no row updated)", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("tz-check-cross-owner");
    const { client: outsiderClient, userId: outsiderId } = await createOwnerAndBusiness("tz-check-cross-outsider");
    cleanupUserIds.push(ownerId, outsiderId);

    const { data, error } = await outsiderClient
      .from("businesses")
      .update({ timezone: "Africa/Lagos" })
      .eq("id", businessId)
      .select();
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("private.is_timezone_valid_for_country EXECUTE grants (Phase 1Q-0B-0B LOW finding #1 fix)", () => {
  // The function lives in the `private` schema, which PostgREST never
  // exposes as an RPC target regardless of grants — so the meaningful,
  // exact check is the Postgres privilege catalog itself
  // (has_function_privilege / information_schema.routine_privileges),
  // not a client.rpc() call (which would 404 either way and prove
  // nothing about the grant).
  it("authenticated has no EXECUTE privilege on the private helper", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql`
        select has_function_privilege(
          'authenticated',
          'private.is_timezone_valid_for_country(text, text)',
          'EXECUTE'
        ) as can_execute
      `;
      expect(row.can_execute).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("anon has no EXECUTE privilege on the private helper", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql`
        select has_function_privilege(
          'anon',
          'private.is_timezone_valid_for_country(text, text)',
          'EXECUTE'
        ) as can_execute
      `;
      expect(row.can_execute).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("public has no EXECUTE privilege on the private helper", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql`
        select has_function_privilege(
          'public',
          'private.is_timezone_valid_for_country(text, text)',
          'EXECUTE'
        ) as can_execute
      `;
      expect(row.can_execute).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("private_business_creator (the create_business RPC's owning role) retains EXECUTE", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql`
        select has_function_privilege(
          'private_business_creator',
          'private.is_timezone_valid_for_country(text, text)',
          'EXECUTE'
        ) as can_execute
      `;
      expect(row.can_execute).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
