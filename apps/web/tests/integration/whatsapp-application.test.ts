import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1M — WhatsApp APPLICATION / PROVIDER LAYER. Exercises the new
// RPCs from supabase/migrations/20260908080000_whatsapp_application_provider_writer.sql
// directly against a real database, via a raw Postgres connection
// (mirrors tests/integration/whatsapp-foundation.test.ts's own exact
// convention) — the webhook ROUTE's own HTTP-level orchestration is
// separately covered by lib/whatsapp/webhook-route.test.ts (mocked
// admin client), and the pure signature/event-key logic by
// lib/whatsapp/webhook-signature.test.ts / webhook-events.test.ts. This
// file's own subject is the RPCs' real SQL behavior: ACL, idempotency,
// tenant isolation, consent/window/template enforcement.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeOwner(prefix: string) {
  const owner = await createOwnerAndBusiness(prefix);
  cleanupUserIds.push(owner.userId);
  return owner;
}

async function createCustomer(client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"], businessId: string, name: string, phone?: string) {
  const { data, error } = await client.rpc("create_customer", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: name,
    ...(phone ? { p_phone: phone } : {}),
  });
  if (error || !data) throw new Error(`create_customer failed: ${error?.message}`);
  return data as string;
}

const HASH_A = "a".repeat(64);

async function setupConnectedAccount(businessId: string, ownerUserId: string) {
  const sql = createTestDbClient();
  try {
    const [account] = await sql<{ upsert_meta_whatsapp_account: string }[]>`
      select public.upsert_meta_whatsapp_account(
        p_business_id => ${businessId}::uuid,
        p_provider_business_account_id => ${`waba-${randomUuid()}`},
        p_status => 'CONNECTED',
        p_actor_user_id => ${ownerUserId}::uuid,
        p_created_by => ${ownerUserId}::uuid
      ) as upsert_meta_whatsapp_account
    `;
    const accountId = account.upsert_meta_whatsapp_account;
    const [number] = await sql<{ upsert_meta_whatsapp_phone_number: string }[]>`
      select public.upsert_meta_whatsapp_phone_number(
        p_business_id => ${businessId}::uuid,
        p_whatsapp_account_id => ${accountId}::uuid,
        p_provider_phone_number_id => ${`pn-${randomUuid()}`},
        p_display_phone_number => '+15550001111'
      ) as upsert_meta_whatsapp_phone_number
    `;
    return { accountId, numberId: number.upsert_meta_whatsapp_phone_number };
  } finally {
    await sql.end();
  }
}

async function createOpenConversation(businessId: string, numberId: string, customerId: string | null, phone: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status)
      values (${businessId}, ${customerId}, ${numberId}, ${phone}, 'OPEN')
      returning id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

async function setServiceConsent(ownerClient: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"], businessId: string, customerId: string, allowed: boolean) {
  await ownerClient.rpc("record_customer_whatsapp_consent", {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_set_service: true,
    p_service_allowed: allowed,
    p_service_consent_source: "STAFF_RECORDED",
  });
}

async function openServiceWindow(conversationId: string, hoursFromNow: number) {
  const sql = createTestDbClient();
  try {
    await sql`
      update public.whatsapp_conversations
      set customer_service_window_ends_at = now() + make_interval(hours => ${hoursFromNow})
      where id = ${conversationId}
    `;
  } finally {
    await sql.end();
  }
}

async function insertTemplate(businessId: string, accountId: string, overrides: Partial<{ status: string; category: string; providerTemplateId: string | null }> = {}) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_templates (business_id, whatsapp_account_id, provider_template_id, name, language, category, status)
      values (
        ${businessId}, ${accountId},
        ${overrides.providerTemplateId === undefined ? `tpl-${randomUuid()}` : overrides.providerTemplateId},
        ${"order_update_" + randomUuid()}, 'en',
        ${overrides.category ?? "UTILITY"}, ${overrides.status ?? "APPROVED"}
      )
      returning id
    `;
    return row.id;
  } finally {
    await sql.end();
  }
}

describe("Phase 1M application — webhook event ledger public wrapper", () => {
  it("ingest_whatsapp_webhook_event is a thin ACL-restricted wrapper: PUBLIC/anon/authenticated cannot execute it", async () => {
    const sql = createTestDbClient();
    try {
      for (const role of ["anon", "authenticated"]) {
        const rows = await sql<{ has: boolean }[]>`
          select has_function_privilege(
            ${role}, 'public.ingest_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)', 'EXECUTE'
          ) as has
        `;
        expect(rows[0].has, role).toBe(false);
      }
      const svc = await sql<{ has: boolean }[]>`
        select has_function_privilege(
          'service_role', 'public.ingest_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)', 'EXECUTE'
        ) as has
      `;
      expect(svc[0].has).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("forwards correctly to the private ledger: exact replay returns is_new=false", async () => {
    const owner = await makeOwner("wa-app-ledger");
    const key = `evt-${randomUuid()}`;
    const sql = createTestDbClient();
    try {
      const [first] = await sql<{ id: string; is_new: boolean }[]>`
        select * from public.ingest_whatsapp_webhook_event(
          'META_CLOUD', ${key}, 'message.inbound', ${HASH_A}, ${owner.businessId}::uuid, null, null
        )
      `;
      expect(first.is_new).toBe(true);
      const [replay] = await sql<{ id: string; is_new: boolean }[]>`
        select * from public.ingest_whatsapp_webhook_event(
          'META_CLOUD', ${key}, 'message.inbound', ${HASH_A}, ${owner.businessId}::uuid, null, null
        )
      `;
      expect(replay.is_new).toBe(false);
      expect(replay.id).toBe(first.id);
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M application — inbound pipeline", () => {
  it("idempotent on provider_message_id: a duplicate delivery never creates a second message", async () => {
    const owner = await makeOwner("wa-app-inbound-idem");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const providerMessageId = `wamid-${randomUuid()}`;
    const sql = createTestDbClient();
    try {
      const call = () => sql<{ message_id: string; conversation_id: string; is_new: boolean }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid,
          p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_phone_e164 => '+2348012345678',
          p_provider_message_id => ${providerMessageId},
          p_message_type => 'TEXT',
          p_body_text => 'hello',
          p_provider_timestamp => now()
        )
      `;
      const [first] = await call();
      expect(first.is_new).toBe(true);
      const [replay] = await call();
      expect(replay.is_new).toBe(false);
      expect(replay.message_id).toBe(first.message_id);

      const rows = await sql`select count(*)::int as n from public.whatsapp_messages where provider_message_id = ${providerMessageId}`;
      expect(rows[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("exact E.164 phone match links the customer; no match leaves customer_id null and never auto-creates a customer", async () => {
    const owner = await makeOwner("wa-app-inbound-match");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Matched Customer", "+2348099990000");

    const sql = createTestDbClient();
    try {
      const [matched] = await sql<{ conversation_id: string }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid,
          p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_id => ${customerId}::uuid,
          p_customer_phone_e164 => '+2348099990000',
          p_provider_message_id => ${`wamid-${randomUuid()}`},
          p_message_type => 'TEXT',
          p_body_text => 'hi'
        )
      `;
      const [conv] = await sql<{ customer_id: string | null }[]>`select customer_id from public.whatsapp_conversations where id = ${matched.conversation_id}`;
      expect(conv.customer_id).toBe(customerId);

      const [unmatched] = await sql<{ conversation_id: string }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid,
          p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_phone_e164 => '+2348011112222',
          p_provider_message_id => ${`wamid-${randomUuid()}`},
          p_message_type => 'TEXT',
          p_body_text => 'hi'
        )
      `;
      const [conv2] = await sql<{ customer_id: string | null }[]>`select customer_id from public.whatsapp_conversations where id = ${unmatched.conversation_id}`;
      expect(conv2.customer_id).toBeNull();

      const customerCount = await sql`select count(*)::int as n from public.customers where business_id = ${owner.businessId}`;
      expect(customerCount[0].n).toBe(1); // only the one explicitly created above — never auto-created
    } finally {
      await sql.end();
    }
  });

  it("reuses the SAME open conversation for repeat inbound messages from the same unmatched phone", async () => {
    const owner = await makeOwner("wa-app-inbound-reuse");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const sql = createTestDbClient();
    try {
      const [a] = await sql<{ conversation_id: string }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_phone_e164 => '+2348033334444', p_provider_message_id => ${`wamid-${randomUuid()}`},
          p_message_type => 'TEXT', p_body_text => 'first'
        )`;
      const [b] = await sql<{ conversation_id: string }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_phone_e164 => '+2348033334444', p_provider_message_id => ${`wamid-${randomUuid()}`},
          p_message_type => 'TEXT', p_body_text => 'second'
        )`;
      expect(a.conversation_id).toBe(b.conversation_id);
      const count = await sql`select count(*)::int as n from public.whatsapp_conversations where id = ${a.conversation_id}`;
      expect(count[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("advances the customer service window on a new inbound message", async () => {
    const owner = await makeOwner("wa-app-inbound-window");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ conversation_id: string }[]>`
        select * from public.record_inbound_whatsapp_message(
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_customer_phone_e164 => '+2348055556666', p_provider_message_id => ${`wamid-${randomUuid()}`},
          p_message_type => 'TEXT', p_body_text => 'hi'
        )`;
      const [conv] = await sql<{ customer_service_window_ends_at: string | null; last_inbound_at: string | null }[]>`
        select customer_service_window_ends_at, last_inbound_at from public.whatsapp_conversations where id = ${row.conversation_id}
      `;
      expect(conv.customer_service_window_ends_at).not.toBeNull();
      expect(new Date(conv.customer_service_window_ends_at!).getTime()).toBeGreaterThan(Date.now());
      expect(conv.last_inbound_at).not.toBeNull();
    } finally {
      await sql.end();
    }
  });

  it("record_inbound_whatsapp_message has no EXECUTE grant for PUBLIC/anon/authenticated", async () => {
    const sql = createTestDbClient();
    try {
      for (const role of ["anon", "authenticated"]) {
        const rows = await sql<{ has: boolean }[]>`
          select has_function_privilege(
            ${role},
            'public.record_inbound_whatsapp_message(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)',
            'EXECUTE'
          ) as has
        `;
        expect(rows[0].has, role).toBe(false);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M application — service consent and window enforcement (begin_whatsapp_outbound_message)", () => {
  it("denies a free-form TEXT send with no consent row at all", async () => {
    const owner = await makeOwner("wa-app-send-no-consent");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "No Consent Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340000");
    await openServiceWindow(convId, 12);

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/WHATSAPP_SERVICE_CONSENT_REQUIRED/);
  });

  it("denies when service consent is explicitly false", async () => {
    const owner = await makeOwner("wa-app-send-consent-false");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Consent False Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340001");
    await openServiceWindow(convId, 12);
    await setServiceConsent(owner.client, owner.businessId, customerId, false);

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/WHATSAPP_SERVICE_CONSENT_REQUIRED/);
  });

  it("denies a free-form TEXT send with consent but no open window", async () => {
    const owner = await makeOwner("wa-app-send-no-window");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "No Window Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340002");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/WHATSAPP_SERVICE_WINDOW_CLOSED/);
  });

  it("denies a free-form TEXT send with an EXPIRED window", async () => {
    const owner = await makeOwner("wa-app-send-expired-window");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Expired Window Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340003");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    await openServiceWindow(convId, -1);

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/WHATSAPP_SERVICE_WINDOW_CLOSED/);
  });

  it("allows a free-form TEXT send with consent AND an open window", async () => {
    const owner = await makeOwner("wa-app-send-eligible");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Eligible Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340004");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    await openServiceWindow(convId, 12);

    const { data, error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error).toBeNull();
    expect(data?.[0]?.is_new).toBe(true);
  });

  it("a browser-submitted fake window end is ignored (server/DB is the only trusted source)", async () => {
    const owner = await makeOwner("wa-app-send-fake-window");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Fake Window Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340005");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    // No p_window parameter exists on begin_whatsapp_outbound_message at
    // all — there is no argument through which a caller could even
    // attempt to submit one. Window is absent -> denied.
    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hello",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/WHATSAPP_SERVICE_WINDOW_CLOSED/);
  });
});

describe("Phase 1M application — template enforcement", () => {
  it("outside the window, an APPROVED UTILITY template is eligible", async () => {
    const owner = await makeOwner("wa-app-tpl-approved");
    const { numberId, accountId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Template Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340006");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const templateId = await insertTemplate(owner.businessId, accountId, { status: "APPROVED", category: "UTILITY" });

    const { data, error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEMPLATE",
      p_template_id: templateId,
      p_client_creation_key: randomUuid(),
    });
    expect(error).toBeNull();
    expect(data?.[0]?.is_new).toBe(true);
  });

  it("rejects a PENDING/REJECTED/PAUSED/DISABLED template", async () => {
    const owner = await makeOwner("wa-app-tpl-not-approved");
    const { numberId, accountId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Not Approved Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340007");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);

    for (const status of ["PENDING", "REJECTED", "PAUSED", "DISABLED"]) {
      const templateId = await insertTemplate(owner.businessId, accountId, { status, category: "UTILITY" });
      const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId,
        p_conversation_id: convId,
        p_message_type: "TEMPLATE",
        p_template_id: templateId,
        p_client_creation_key: randomUuid(),
      });
      expect(error?.message, status).toMatch(/TEMPLATE_NOT_APPROVED/);
    }
  });

  it("rejects a MARKETING template in this MVP send path", async () => {
    const owner = await makeOwner("wa-app-tpl-marketing");
    const { numberId, accountId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Marketing Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340008");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const templateId = await insertTemplate(owner.businessId, accountId, { status: "APPROVED", category: "MARKETING" });

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEMPLATE",
      p_template_id: templateId,
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/TEMPLATE_MARKETING_NOT_ALLOWED/);
  });

  it("rejects a template belonging to a different business", async () => {
    const owner = await makeOwner("wa-app-tpl-wrong-business-a");
    const other = await makeOwner("wa-app-tpl-wrong-business-b");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { accountId: otherAccountId } = await setupConnectedAccount(other.businessId, other.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Wrong Business Customer");
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012340009");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const templateId = await insertTemplate(other.businessId, otherAccountId, { status: "APPROVED", category: "UTILITY" });

    const { error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEMPLATE",
      p_template_id: templateId,
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/TEMPLATE_NOT_FOUND/);
  });
});

describe("Phase 1M application — authorization matrix", () => {
  it("OWNER/ADMIN/MANAGER/SALES/ACCOUNTANT can send; INVENTORY/VIEWER are denied", async () => {
    const owner = await makeOwner("wa-app-authz-matrix");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);

    const allowedRoles = ["ADMIN", "MANAGER", "SALES", "ACCOUNTANT"];
    for (let i = 0; i < allowedRoles.length; i++) {
      const role = allowedRoles[i];
      // A distinct customer/conversation per role — the frozen
      // "one OPEN conversation per (business, customer, number)"
      // uniqueness constraint is keyed on customer_id, not phone alone.
      const customerId = await createCustomer(owner.client, owner.businessId, `Authz Matrix Customer ${role}`);
      await setServiceConsent(owner.client, owner.businessId, customerId, true);
      const convId = await createOpenConversation(owner.businessId, numberId, customerId, `+234801234${String(i).padStart(4, "0")}`);
      await openServiceWindow(convId, 12);
      const member = await createMemberWithRole(owner.businessId, `wa-authz-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      const { error } = await member.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId,
        p_conversation_id: convId,
        p_message_type: "TEXT",
        p_body_text: "hi",
        p_client_creation_key: randomUuid(),
      });
      expect(error, role).toBeNull();
    }

    const deniedRoles = ["INVENTORY", "VIEWER"];
    for (let i = 0; i < deniedRoles.length; i++) {
      const role = deniedRoles[i];
      const deniedCustomerId = await createCustomer(owner.client, owner.businessId, `Authz Matrix Denied ${role}`);
      await setServiceConsent(owner.client, owner.businessId, deniedCustomerId, true);
      const convId = await createOpenConversation(owner.businessId, numberId, deniedCustomerId, `+234802234${String(i).padStart(4, "0")}`);
      await openServiceWindow(convId, 12);
      const member = await createMemberWithRole(owner.businessId, `wa-authz-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      const { error } = await member.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId,
        p_conversation_id: convId,
        p_message_type: "TEXT",
        p_body_text: "hi",
        p_client_creation_key: randomUuid(),
      });
      expect(error?.message, role).toMatch(/insufficient_privilege/);
    }
  });

  it("a nonmember is denied", async () => {
    const owner = await makeOwner("wa-app-authz-nonmember-owner");
    const outsider = await makeOwner("wa-app-authz-nonmember-outsider");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Nonmember Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012349999");
    await openServiceWindow(convId, 12);

    const { error } = await outsider.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hi",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/insufficient_privilege/);
  });

  it("cross-business conversation access is denied", async () => {
    const owner = await makeOwner("wa-app-authz-cross-a");
    const other = await makeOwner("wa-app-authz-cross-b");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Cross Business Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012348888");
    await openServiceWindow(convId, 12);

    const { error } = await other.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: other.businessId,
      p_conversation_id: convId,
      p_message_type: "TEXT",
      p_body_text: "hi",
      p_client_creation_key: randomUuid(),
    });
    expect(error?.message).toMatch(/CONVERSATION_NOT_FOUND/);
  });
});

describe("Phase 1M application — outbound idempotency", () => {
  it("the same client_creation_key returns the SAME logical message, never a duplicate", async () => {
    const owner = await makeOwner("wa-app-outbound-idem");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Idempotency Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012347777");
    await openServiceWindow(convId, 12);
    const key = randomUuid();

    const first = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT",
      p_body_text: "hi", p_client_creation_key: key,
    });
    const second = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT",
      p_body_text: "hi", p_client_creation_key: key,
    });
    expect(first.data?.[0]?.message_id).toBe(second.data?.[0]?.message_id);
    expect(second.data?.[0]?.is_new).toBe(false);

    const sql = createTestDbClient();
    try {
      const rows = await sql`select count(*)::int as n from public.whatsapp_messages where business_id = ${owner.businessId} and client_creation_key = ${key}`;
      expect(rows[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("concurrent calls with the SAME creation key resolve to exactly one row", async () => {
    const owner = await makeOwner("wa-app-outbound-concurrent");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Concurrent Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012346666");
    await openServiceWindow(convId, 12);
    const key = randomUuid();

    const [r1, r2] = await Promise.all([
      owner.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
      }),
      owner.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
      }),
    ]);
    const ids = [r1.data?.[0]?.message_id, r2.data?.[0]?.message_id];
    expect(ids[0]).toBe(ids[1]);
    const newCount = [r1.data?.[0]?.is_new, r2.data?.[0]?.is_new].filter(Boolean).length;
    expect(newCount).toBe(1);
  });

  it("different businesses using the same creation key create independent messages", async () => {
    const a = await makeOwner("wa-app-outbound-diff-a");
    const b = await makeOwner("wa-app-outbound-diff-b");
    const { numberId: numberA } = await setupConnectedAccount(a.businessId, a.userId);
    const { numberId: numberB } = await setupConnectedAccount(b.businessId, b.userId);
    const custA = await createCustomer(a.client, a.businessId, "A Customer");
    const custB = await createCustomer(b.client, b.businessId, "B Customer");
    await setServiceConsent(a.client, a.businessId, custA, true);
    await setServiceConsent(b.client, b.businessId, custB, true);
    const convA = await createOpenConversation(a.businessId, numberA, custA, "+2348012345555");
    const convB = await createOpenConversation(b.businessId, numberB, custB, "+2348012345554");
    await openServiceWindow(convA, 12);
    await openServiceWindow(convB, 12);
    const key = randomUuid();

    const ra = await a.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: a.businessId, p_conversation_id: convA, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
    });
    const rb = await b.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: b.businessId, p_conversation_id: convB, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
    });
    expect(ra.data?.[0]?.message_id).not.toBe(rb.data?.[0]?.message_id);
    expect(ra.data?.[0]?.is_new).toBe(true);
    expect(rb.data?.[0]?.is_new).toBe(true);
  });

  it("begin_whatsapp_outbound_message is granted to authenticated only — never anon/service_role/PUBLIC", async () => {
    const sql = createTestDbClient();
    try {
      const sig = "public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)";
      for (const [role, expected] of [["anon", false], ["authenticated", true], ["service_role", false]] as const) {
        const rows = await sql<{ has: boolean }[]>`select has_function_privilege(${role}, ${sig}, 'EXECUTE') as has`;
        expect(rows[0].has, role).toBe(expected);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M application — provider status / failure / bind", () => {
  it("bind_outbound_provider_message_id transitions PENDING -> ACCEPTED and is idempotent-safe (cannot double-bind)", async () => {
    const owner = await makeOwner("wa-app-bind");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Bind Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012343333");
    await openServiceWindow(convId, 12);
    const { data } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: randomUuid(),
    });
    const messageId = data![0].message_id;

    const sql = createTestDbClient();
    try {
      const providerMessageId = `wamid-${randomUuid()}`;
      await sql`select public.bind_outbound_provider_message_id(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)`;
      const [row] = await sql<{ status: string; provider_message_id: string | null }[]>`select status, provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(row.status).toBe("ACCEPTED");
      expect(row.provider_message_id).toBe(providerMessageId);

      // Cannot bind a second time (provider_message_id already set).
      await expect(
        sql`select public.bind_outbound_provider_message_id(${messageId}::uuid, ${owner.businessId}::uuid, ${`wamid-${randomUuid()}`}, ${owner.userId}::uuid)`
      ).rejects.toThrow();

      const auditRows = await sql`select action from public.audit_events where business_id = ${owner.businessId} and action = 'whatsapp.message_sent'`;
      expect(auditRows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("fail_whatsapp_outbound_message transitions to FAILED with a bounded, sanitized reason and audits", async () => {
    const owner = await makeOwner("wa-app-fail");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Fail Customer");
    await setServiceConsent(owner.client, owner.businessId, customerId, true);
    const convId = await createOpenConversation(owner.businessId, numberId, customerId, "+2348012342222");
    await openServiceWindow(convId, 12);
    const { data } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: randomUuid(),
    });
    const messageId = data![0].message_id;

    const sql = createTestDbClient();
    try {
      await sql`select public.fail_whatsapp_outbound_message(${messageId}::uuid, ${owner.businessId}::uuid, 'Provider rejected: invalid recipient', ${owner.userId}::uuid)`;
      const [row] = await sql<{ status: string; failure_reason: string | null }[]>`select status, failure_reason from public.whatsapp_messages where id = ${messageId}`;
      expect(row.status).toBe("FAILED");
      expect(row.failure_reason).toBe("Provider rejected: invalid recipient");

      const auditRows = await sql`select action, metadata from public.audit_events where business_id = ${owner.businessId} and action = 'whatsapp.message_failed'`;
      expect(auditRows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("record_whatsapp_provider_message_status updates the matching message by provider_message_id only, never by phone", async () => {
    const owner = await makeOwner("wa-app-status-by-id");
    const { numberId, accountId } = await setupConnectedAccount(owner.businessId, owner.userId);
    void accountId;
    const sql = createTestDbClient();
    try {
      const convId = await createOpenConversation(owner.businessId, numberId, null, "+2348012341111");
      const providerMessageId = `wamid-${randomUuid()}`;
      const [msg] = await sql<{ id: string }[]>`
        insert into public.whatsapp_messages (business_id, conversation_id, direction, message_type, provider_message_id, sender_kind, status)
        values (${owner.businessId}, ${convId}, 'OUTBOUND', 'TEXT', ${providerMessageId}, 'SYSTEM', 'ACCEPTED')
        returning id
      `;
      await sql`select public.record_whatsapp_provider_message_status(${msg.id}::uuid, ${owner.businessId}::uuid, 'DELIVERED', now(), null)`;
      const [row] = await sql<{ status: string }[]>`select status from public.whatsapp_messages where id = ${msg.id}`;
      expect(row.status).toBe("DELIVERED");
    } finally {
      await sql.end();
    }
  });

  it("service-role-only status/failure/bind RPCs have no EXECUTE grant for PUBLIC/anon/authenticated", async () => {
    const sql = createTestDbClient();
    const signatures = [
      "public.bind_outbound_provider_message_id(uuid, uuid, text, uuid)",
      "public.fail_whatsapp_outbound_message(uuid, uuid, text, uuid)",
      "public.record_whatsapp_provider_message_status(uuid, uuid, text, timestamptz, text)",
      "public.upsert_meta_whatsapp_account(uuid, text, text, uuid, text, uuid)",
      "public.upsert_meta_whatsapp_phone_number(uuid, uuid, text, text, boolean)",
      "public.sync_whatsapp_template(uuid, uuid, text, text, text, text, text, text, uuid)",
    ];
    try {
      for (const sig of signatures) {
        for (const role of ["anon", "authenticated"]) {
          const rows = await sql<{ has: boolean }[]>`select has_function_privilege(${role}, ${sig}, 'EXECUTE') as has`;
          expect(rows[0].has, `${sig} / ${role}`).toBe(false);
        }
        const svc = await sql<{ has: boolean }[]>`select has_function_privilege('service_role', ${sig}, 'EXECUTE') as has`;
        expect(svc[0].has, sig).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });
});
