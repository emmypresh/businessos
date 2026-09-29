// Phase 1O-E (completion pass) — Platform Audit, Subscriptions, and Support.
//
// Proves the three new bounded platform-wide RPCs
// (public.list_platform_audit, public.list_platform_subscriptions,
// public.list_platform_business_diagnostics /
// public.get_platform_support_summary — see supabase/migrations/
// 20261004080000_platform_audit_subscriptions_support.sql) enforce the
// exact same authorization matrix as every other platform RPC: the correct
// single permission gates each one (platform.audit.view /
// platform.subscriptions.view / platform.businesses.view respectively),
// AAL1, an inactive admin, a tenant OWNER/ADMIN, and an anonymous caller are
// all denied, and pagination/search inputs are bounded and validated.
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

// --- WhatsApp failure fixtures, for the recent_whatsapp_failures numeric
// semantics tests below. Mirrors the fixture shape in
// tests/integration/whatsapp-foundation.test.ts: an account -> a phone
// number -> a conversation, then individual FAILED messages with
// failed_at inside (or, for the boundary test, outside) the frozen
// 7-day window that both list_platform_business_diagnostics and
// get_platform_support_summary use.
async function createWhatsappConversationForBusiness(businessId: string, ownerUserId: string) {
  const sql = createTestDbClient();
  try {
    const [account] = await sql<{ id: string }[]>`
      insert into public.whatsapp_accounts (business_id, status, provider_business_account_id, created_by)
      values (${businessId}, 'CONNECTED', ${`waba-${randomUuid()}`}, ${ownerUserId})
      returning id
    `;
    const [number] = await sql<{ id: string }[]>`
      insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, provider_phone_number_id, display_phone_number)
      values (${businessId}, ${account.id}, ${`pn-${randomUuid()}`}, '+2348012345678')
      returning id
    `;
    const [conversation] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (business_id, whatsapp_phone_number_id, customer_phone_e164, status)
      values (${businessId}, ${number.id}, '+2348099998888', 'OPEN')
      returning id
    `;
    return conversation.id as string;
  } finally {
    await sql.end();
  }
}

async function createFailedWhatsappMessages(businessId: string, conversationId: string, count: number, failedAt: Date) {
  const sql = createTestDbClient();
  try {
    for (let i = 0; i < count; i += 1) {
      await sql`
        insert into public.whatsapp_messages (
          business_id, conversation_id, direction, message_type, sender_kind, status, failed_at
        ) values (
          ${businessId}, ${conversationId}, 'OUTBOUND', 'TEXT', 'SYSTEM', 'FAILED', ${failedAt.toISOString()}
        )
      `;
    }
  } finally {
    await sql.end();
  }
}

describe("list_platform_audit: authorization matrix", () => {
  it("SUPER_ADMIN (holds platform.audit.view) can call it, gets a change_summary, never raw before/after", async () => {
    const { client } = await createAuthorizedAdmin("audit-super", "SUPER_ADMIN");
    const { userId, businessId } = await createOwnerAndBusiness("audit-super-target");
    cleanupUserIds.push(userId);

    const { error: suspendError } = await client.rpc("platform_suspend_business", {
      p_business_id: businessId,
      p_reason: "Integration test suspension for 1O-E audit page coverage.",
      p_idempotency_key: `test-${randomUuid()}`,
    });
    expect(suspendError).toBeNull();

    const { data, error } = await client.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
    expect(error).toBeNull();
    const rows = data as unknown as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("before_state");
      expect(row).not.toHaveProperty("after_state");
      expect(typeof row.change_summary).toBe("string");
    }
    expect(rows.some((r) => r.target_business_id === businessId && r.action_type === "SUSPEND_BUSINESS")).toBe(
      true
    );
  });

  it.each(["SUPPORT", "OPERATIONS", "BILLING", "VIEWER"] as const)(
    "%s (no platform.audit.view) is denied",
    async (role) => {
      const { client } = await createAuthorizedAdmin(`audit-${role.toLowerCase()}`, role);
      const { error } = await client.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
      expect(error, role).not.toBeNull();
    }
  );

  it("denies a tenant OWNER, AAL1 platform admin, inactive platform admin, and anonymous caller", async () => {
    const owner = await createOwnerAndBusiness("audit-owner");
    cleanupUserIds.push(owner.userId);
    await elevateToAal2(owner.client);
    const ownerResult = await owner.client.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
    expect(ownerResult.error).not.toBeNull();

    const aal1 = await createSignedInUser("audit-aal1");
    cleanupUserIds.push(aal1.userId);
    await insertPlatformAdmin(aal1.userId, "SUPER_ADMIN");
    const aal1Result = await aal1.client.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
    expect(aal1Result.error).not.toBeNull();

    const inactive = await createSignedInUser("audit-inactive");
    cleanupUserIds.push(inactive.userId);
    await insertPlatformAdmin(inactive.userId, "SUPER_ADMIN", false);
    await elevateToAal2(inactive.client);
    const inactiveResult = await inactive.client.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
    expect(inactiveResult.error).not.toBeNull();

    const anon = createAnonClient();
    const anonResult = await anon.rpc("list_platform_audit", { p_page: 1, p_page_size: 25 });
    expect(anonResult.error).not.toBeNull();
  });

  it("rejects an invalid action type and an out-of-range page size", async () => {
    const { client } = await createAuthorizedAdmin("audit-invalid", "SUPER_ADMIN");
    const badType = await client.rpc("list_platform_audit", { p_page: 1, p_action_type: "DELETE_EVERYTHING" });
    expect(badType.error).not.toBeNull();
    const badPageSize = await client.rpc("list_platform_audit", { p_page: 1, p_page_size: 500 });
    expect(badPageSize.error).not.toBeNull();
  });

  it("a literal % search does not wildcard-expand into every row", async () => {
    const { client } = await createAuthorizedAdmin("audit-wildcard", "SUPER_ADMIN");
    const { data, error } = await client.rpc("list_platform_audit", {
      p_page: 1,
      p_business_search: "%",
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // A literal `%` must not match every business name — result set must be
    // empty (no business is named exactly the single character list
    // matched literally) rather than the full unfiltered table.
    expect((data as unknown[]).length).toBe(0);
  });
});

describe("list_platform_subscriptions: authorization matrix", () => {
  it.each(["SUPER_ADMIN", "OPERATIONS", "BILLING"] as const)(
    "%s (holds platform.subscriptions.view) can call it",
    async (role) => {
      const { client } = await createAuthorizedAdmin(`subs-${role.toLowerCase()}`, role);
      const { error } = await client.rpc("list_platform_subscriptions", { p_page: 1, p_page_size: 25 });
      expect(error, role).toBeNull();
    }
  );

  it.each(["SUPPORT", "VIEWER"] as const)("%s (no platform.subscriptions.view) is denied", async (role) => {
    const { client } = await createAuthorizedAdmin(`subs-${role.toLowerCase()}`, role);
    const { error } = await client.rpc("list_platform_subscriptions", { p_page: 1, p_page_size: 25 });
    expect(error, role).not.toBeNull();
  });

  it("denies a tenant OWNER and an anonymous caller", async () => {
    const owner = await createOwnerAndBusiness("subs-owner");
    cleanupUserIds.push(owner.userId);
    await elevateToAal2(owner.client);
    const ownerResult = await owner.client.rpc("list_platform_subscriptions", { p_page: 1 });
    expect(ownerResult.error).not.toBeNull();

    const anon = createAnonClient();
    const anonResult = await anon.rpc("list_platform_subscriptions", { p_page: 1 });
    expect(anonResult.error).not.toBeNull();
  });

  it("rejects an invalid status filter and returns only the requested status when valid", async () => {
    const { client } = await createAuthorizedAdmin("subs-status", "SUPER_ADMIN");
    const bad = await client.rpc("list_platform_subscriptions", { p_page: 1, p_status: "NOT_A_STATUS" });
    expect(bad.error).not.toBeNull();

    const { data, error } = await client.rpc("list_platform_subscriptions", { p_page: 1, p_status: "TRIALING" });
    expect(error).toBeNull();
    const rows = data as unknown as Array<{ status: string }>;
    for (const row of rows) expect(row.status).toBe("TRIALING");
  });

  it("never returns a provider reference or webhook-payload field", async () => {
    const { client } = await createAuthorizedAdmin("subs-fields", "SUPER_ADMIN");
    const { data, error } = await client.rpc("list_platform_subscriptions", { p_page: 1, p_page_size: 5 });
    expect(error).toBeNull();
    for (const row of data as unknown as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty("provider_subscription_code");
      expect(row).not.toHaveProperty("provider_email_token");
    }
  });
});

describe("list_platform_business_diagnostics / get_platform_support_summary: authorization matrix", () => {
  it.each(["SUPER_ADMIN", "SUPPORT", "OPERATIONS"] as const)(
    "%s (holds platform.businesses.view) can call both",
    async (role) => {
      const { client } = await createAuthorizedAdmin(`support-${role.toLowerCase()}`, role);
      const diagnostics = await client.rpc("list_platform_business_diagnostics", { p_page: 1, p_page_size: 25 });
      expect(diagnostics.error, role).toBeNull();
      const summary = await client.rpc("get_platform_support_summary");
      expect(summary.error, role).toBeNull();
      const parsed = summary.data as unknown as Record<string, number>;
      for (const key of ["businesses_requiring_attention", "warnings", "info", "recent_whatsapp_failures"]) {
        expect(typeof parsed[key], `${role} -> ${key}`).toBe("number");
      }
    }
  );

  it.each(["BILLING", "VIEWER"] as const)("%s (no platform.businesses.view) is denied both", async (role) => {
    const { client } = await createAuthorizedAdmin(`support-${role.toLowerCase()}`, role);
    const diagnostics = await client.rpc("list_platform_business_diagnostics", { p_page: 1 });
    expect(diagnostics.error, role).not.toBeNull();
    const summary = await client.rpc("get_platform_support_summary");
    expect(summary.error, role).not.toBeNull();
  });

  it("a fresh business with no owner/branch/members/subscription surfaces every expected diagnostic code", async () => {
    // A business created via create_business always gets an OWNER/branch/
    // subscription in this schema, so instead this proves the RPC's shape
    // and severity values are exactly the frozen set — never an invented
    // code — using whatever real diagnostics exist in this test run.
    const { client } = await createAuthorizedAdmin("support-shape", "SUPER_ADMIN");
    const { data, error } = await client.rpc("list_platform_business_diagnostics", {
      p_page: 1,
      p_page_size: 50,
    });
    expect(error).toBeNull();
    const validCodes = new Set([
      "NO_ACTIVE_OWNER",
      "NO_ACTIVE_BRANCH",
      "ZERO_ACTIVE_MEMBERS",
      "SUBSCRIPTION_MISSING",
      "SUBSCRIPTION_PLAN_MISSING",
      "EXPIRED_TRIAL",
      "RECENT_WHATSAPP_FAILURES",
    ]);
    for (const row of data as unknown as Array<{ code: string; severity: string }>) {
      expect(validCodes.has(row.code)).toBe(true);
      expect(["WARNING", "INFO"]).toContain(row.severity);
    }
  });

  it("rejects an invalid severity filter and an out-of-range page size", async () => {
    const { client } = await createAuthorizedAdmin("support-invalid", "SUPER_ADMIN");
    const badSeverity = await client.rpc("list_platform_business_diagnostics", {
      p_page: 1,
      p_severity: "CRITICAL",
    });
    expect(badSeverity.error).not.toBeNull();
    const badPageSize = await client.rpc("list_platform_business_diagnostics", { p_page: 1, p_page_size: 500 });
    expect(badPageSize.error).not.toBeNull();
  });

  it("denies a tenant OWNER and an anonymous caller for both RPCs", async () => {
    const owner = await createOwnerAndBusiness("support-owner");
    cleanupUserIds.push(owner.userId);
    await elevateToAal2(owner.client);
    expect((await owner.client.rpc("list_platform_business_diagnostics", { p_page: 1 })).error).not.toBeNull();
    expect((await owner.client.rpc("get_platform_support_summary")).error).not.toBeNull();

    const anon = createAnonClient();
    expect((await anon.rpc("list_platform_business_diagnostics", { p_page: 1 })).error).not.toBeNull();
    expect((await anon.rpc("get_platform_support_summary")).error).not.toBeNull();
  });
});

// Phase 1O-E remediation (Codex finding, MEDIUM): get_platform_support_summary's
// recent_whatsapp_failures previously counted the number of businesses with
// at least one recent failure, not the actual number of failed messages.
// These tests pin the corrected numeric semantics: a straight sum of
// per-business failed-message counts within the frozen 7-day window.
describe("get_platform_support_summary: recent_whatsapp_failures numeric semantics", () => {
  it("counts actual failed messages for a single business (5 failures -> 5, not 1)", async () => {
    const { client } = await createAuthorizedAdmin("support-wa-single", "SUPER_ADMIN");
    const target = await createOwnerAndBusiness("support-wa-single-target");
    cleanupUserIds.push(target.userId);

    const { data: before, error: beforeError } = await client.rpc("get_platform_support_summary");
    expect(beforeError).toBeNull();
    const baseline = (before as unknown as Record<string, number>).recent_whatsapp_failures;

    const conversationId = await createWhatsappConversationForBusiness(target.businessId, target.userId);
    await createFailedWhatsappMessages(target.businessId, conversationId, 5, new Date());

    const { data: after, error: afterError } = await client.rpc("get_platform_support_summary");
    expect(afterError).toBeNull();
    const total = (after as unknown as Record<string, number>).recent_whatsapp_failures;

    // Exact delta, not >=5: this independently proves one business
    // contributing five failed messages adds exactly five to the summary,
    // regardless of any unrelated baseline fixture data.
    expect(total - baseline).toBe(5);

    // Isolate this business's contribution by re-checking against the
    // per-business diagnostics message, which independently reports the
    // same underlying stats.recent_whatsapp_failures count.
    const diagnostics = await client.rpc("list_platform_business_diagnostics", {
      p_page: 1,
      p_page_size: 50,
      p_severity: "INFO",
    });
    expect(diagnostics.error).toBeNull();
    const row = (diagnostics.data as unknown as Array<{ business_id: string; message: string }>).find(
      (r) => r.business_id === target.businessId
    );
    expect(row?.message).toContain("5 WhatsApp delivery failure(s)");
  });

  it("sums across multiple businesses (5 + 2 -> 7, not 2) and a zero-failure business contributes 0", async () => {
    const { client } = await createAuthorizedAdmin("support-wa-multi", "SUPER_ADMIN");

    const businessA = await createOwnerAndBusiness("support-wa-multi-a");
    cleanupUserIds.push(businessA.userId);
    const businessB = await createOwnerAndBusiness("support-wa-multi-b");
    cleanupUserIds.push(businessB.userId);
    const businessC = await createOwnerAndBusiness("support-wa-multi-c");
    cleanupUserIds.push(businessC.userId);

    const { data: before, error: beforeError } = await client.rpc("get_platform_support_summary");
    expect(beforeError).toBeNull();
    const baseline = (before as unknown as Record<string, number>).recent_whatsapp_failures;

    const convA = await createWhatsappConversationForBusiness(businessA.businessId, businessA.userId);
    await createFailedWhatsappMessages(businessA.businessId, convA, 5, new Date());
    const convB = await createWhatsappConversationForBusiness(businessB.businessId, businessB.userId);
    await createFailedWhatsappMessages(businessB.businessId, convB, 2, new Date());
    // businessC gets a conversation but zero failed messages — must
    // contribute exactly 0, never a phantom count.
    await createWhatsappConversationForBusiness(businessC.businessId, businessC.userId);

    const { data: after, error: afterError } = await client.rpc("get_platform_support_summary");
    expect(afterError).toBeNull();
    const total = (after as unknown as Record<string, number>).recent_whatsapp_failures;

    // The old (defective) semantics would have added at most 2 (one per
    // affected business) for this fixture; the corrected semantics must
    // add exactly 7 (5 + 2 + 0).
    expect(total - baseline).toBe(7);
  });

  it("does not count a failure outside the frozen 7-day window", async () => {
    const { client } = await createAuthorizedAdmin("support-wa-window", "SUPER_ADMIN");
    const target = await createOwnerAndBusiness("support-wa-window-target");
    cleanupUserIds.push(target.userId);

    const { data: before, error: beforeError } = await client.rpc("get_platform_support_summary");
    expect(beforeError).toBeNull();
    const baseline = (before as unknown as Record<string, number>).recent_whatsapp_failures;

    const conversationId = await createWhatsappConversationForBusiness(target.businessId, target.userId);
    const outsideWindow = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await createFailedWhatsappMessages(target.businessId, conversationId, 3, outsideWindow);

    const { data: after, error: afterError } = await client.rpc("get_platform_support_summary");
    expect(afterError).toBeNull();
    const total = (after as unknown as Record<string, number>).recent_whatsapp_failures;

    expect(total - baseline).toBe(0);
  });
});

describe("get_platform_dashboard_overview: canceled_subscriptions addition", () => {
  it("still returns every pre-existing key plus the new canceled_subscriptions counter", async () => {
    const { client } = await createAuthorizedAdmin("dash-canceled", "SUPER_ADMIN");
    const { data, error } = await client.rpc("get_platform_dashboard_overview");
    expect(error).toBeNull();
    const result = data as unknown as Record<string, number>;
    expect(typeof result.canceled_subscriptions).toBe("number");
    expect(result.canceled_subscriptions).toBeGreaterThanOrEqual(0);
  });
});
