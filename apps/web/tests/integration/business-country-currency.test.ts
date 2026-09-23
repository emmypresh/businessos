import { describe, expect, it, afterEach } from "vitest";
import {
  createConfirmedTestUser,
  createUserClient,
  deleteTestUser,
} from "./helpers/admin-client";
import { createOwnerAndBusiness } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

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

describe("create_business country/currency", () => {
  it("a legacy 2-argument call (no country/currency given) still succeeds and gets the transitional NG/NGN default", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cc-legacy-call");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("businesses")
      .select("country_code, currency_code")
      .eq("id", businessId)
      .single();
    expect(error).toBeNull();
    expect(data?.country_code).toBe("NG");
    expect(data?.currency_code).toBe("NGN");
  });

  // Codex remediation (Phase 1Q-0B-0B): GH is a supported catalog country
  // but is not yet fully operational — the RPC boundary now enforces the
  // NG-only activation gate itself, so a direct call for GH (even with a
  // fully well-formed, correctly-derived currency) is rejected before any
  // row is created. See tests/integration/create-business-rpc-security.test.ts
  // for the dedicated non-NG activation-gate and mismatch-rejection suite,
  // which supersedes what these two cases used to assert.
  it("an explicit non-operational country with no currency is rejected by the activation gate, not silently allowed through", async () => {
    const { client, userId } = await signedInClient("cc-derive");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Accra Traders",
      p_slug: `accra-traders-${Date.now()}`,
      p_country_code: "gh",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("a currency diverging from the country's deterministic pairing is rejected, not persisted as given (CURRENCY_COUNTRY_MISMATCH)", async () => {
    const { client, userId } = await signedInClient("cc-override");
    cleanupUserIds.push(userId);

    const { data, error } = await client.rpc("create_business", {
      p_name: "Dollar-Priced Ghana Shop",
      p_slug: `gh-usd-${Date.now()}`,
      p_country_code: "gh",
      p_currency_code: "usd",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("rejects a malformed country code (a free-form name)", async () => {
    const { client, userId } = await signedInClient("cc-bad-country");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Bad Country",
      p_slug: `bad-country-${Date.now()}`,
      p_country_code: "Nigeria",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a malformed currency code (a currency symbol)", async () => {
    const { client, userId } = await signedInClient("cc-bad-currency");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Bad Currency",
      p_slug: `bad-currency-${Date.now()}`,
      p_currency_code: "₦",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a country outside the catalog with no explicit currency (fails closed, does not silently persist a guess)", async () => {
    const { client, userId } = await signedInClient("cc-unknown-country");
    cleanupUserIds.push(userId);

    const { error } = await client.rpc("create_business", {
      p_name: "Unlisted Country",
      p_slug: `unlisted-country-${Date.now()}`,
      p_country_code: "FR",
    });
    expect(error).not.toBeNull();
  });
});

describe("businesses.country_code / currency_code column constraints", () => {
  it("country_code cannot be null (direct service-role write)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, currency_code)
          select 'Null Country Test', 'null-country-test-' || floor(random() * 1e9)::text, id, 'NGN'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("currency_code cannot be null (direct service-role write)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code)
          select 'Null Currency Test', 'null-currency-test-' || floor(random() * 1e9)::text, id, 'NG'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejects a malformed country_code at the table level (lowercase)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code, currency_code)
          select 'Bad Country Check', 'bad-country-check-' || floor(random() * 1e9)::text, id, 'ng', 'NGN'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("rejects a malformed currency_code at the table level (4 letters)", async () => {
    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.businesses (name, slug, created_by, country_code, currency_code)
          select 'Bad Currency Check', 'bad-currency-check-' || floor(random() * 1e9)::text, id, 'NG', 'NGNX'
          from auth.users limit 1
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("every existing business has a non-null, well-formed country_code and currency_code (backfill proof)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql`
        select count(*)::int as n
        from public.businesses
        where country_code is null
           or currency_code is null
           or country_code !~ '^[A-Z]{2}$'
           or currency_code !~ '^[A-Z]{3}$'
      `;
      expect(rows[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe("tenant RLS behavior unchanged", () => {
  it("a business's country_code/currency_code are visible to a member exactly like every other businesses column (no new policy, no new leak)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cc-rls-visible");
    cleanupUserIds.push(userId);

    const { data, error } = await client
      .from("businesses")
      .select("id, country_code, currency_code")
      .eq("id", businessId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(businessId);
  });

  it("a non-member still cannot read another business's country_code/currency_code", async () => {
    const { businessId, userId: ownerId } = await createOwnerAndBusiness("cc-rls-owner");
    const { client: outsiderClient, userId: outsiderId } = await createOwnerAndBusiness("cc-rls-outsider");
    cleanupUserIds.push(ownerId, outsiderId);

    const { data, error } = await outsiderClient
      .from("businesses")
      .select("id, country_code, currency_code")
      .eq("id", businessId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});
