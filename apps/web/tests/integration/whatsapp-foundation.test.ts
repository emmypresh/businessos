import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1M — WhatsApp + Customer Communication — DATABASE FOUNDATION
// ONLY. Exercises the whatsapp_* tables, customer_whatsapp_preferences,
// the private webhook-event idempotency ledger, and the two narrow
// trusted-writer functions (record_whatsapp_webhook_event,
// record_whatsapp_message_status_event), directly against a real
// database. Every trusted-function call and every fixture insert here
// goes through a raw Postgres connection (createTestDbClient()) — there
// is no application layer yet for any of this (no webhook route, no
// send-message RPC, no frontend), so this file's own subject is the
// FOUNDATION layer's own contracts in isolation.

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

async function createCustomer(client: Awaited<ReturnType<typeof createOwnerAndBusiness>>["client"], businessId: string, name: string) {
  const { data, error } = await client.rpc("create_customer", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: name,
  });
  if (error || !data) throw new Error(`create_customer failed: ${error?.message}`);
  return data as string;
}

async function getDefaultBranchId(businessId: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      select id from public.business_branches where business_id = ${businessId} and is_default = true
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

async function createWhatsappAccount(businessId: string, ownerUserId: string, overrides: Partial<{ status: string; providerBusinessAccountId: string | null }> = {}) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_accounts (business_id, status, provider_business_account_id, created_by)
      values (
        ${businessId},
        ${overrides.status ?? "CONNECTED"},
        ${overrides.providerBusinessAccountId === undefined ? `waba-${randomUuid()}` : overrides.providerBusinessAccountId},
        ${ownerUserId}
      )
      returning id
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

async function createWhatsappNumber(
  businessId: string,
  accountId: string,
  overrides: Partial<{ branchId: string | null; providerPhoneNumberId: string; isPrimary: boolean }> = {}
) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_phone_numbers (
        business_id, whatsapp_account_id, branch_id, provider_phone_number_id, display_phone_number, is_primary
      ) values (
        ${businessId}, ${accountId}, ${overrides.branchId ?? null},
        ${overrides.providerPhoneNumberId ?? `pn-${randomUuid()}`}, '+2348012345678',
        ${overrides.isPrimary ?? false}
      )
      returning id
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

async function createConversation(
  businessId: string,
  numberId: string,
  customerId: string | null,
  overrides: Partial<{ branchId: string | null; status: string; phone: string }> = {}
) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (
        business_id, branch_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status
      ) values (
        ${businessId}, ${overrides.branchId ?? null}, ${customerId}, ${numberId},
        ${overrides.phone ?? "+2348099998888"}, ${overrides.status ?? "OPEN"}
      )
      returning id
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

async function createMessage(
  businessId: string,
  conversationId: string,
  overrides: Partial<{
    customerId: string | null;
    direction: string;
    status: string;
    providerMessageId: string | null;
    clientCreationKey: string | null;
  }> = {}
) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_messages (
        business_id, conversation_id, customer_id, direction, message_type,
        provider_message_id, client_creation_key, sender_kind, status
      ) values (
        ${businessId}, ${conversationId}, ${overrides.customerId ?? null},
        ${overrides.direction ?? "OUTBOUND"}, 'TEXT',
        ${overrides.providerMessageId ?? null}, ${overrides.clientCreationKey ?? null},
        ${overrides.direction === "INBOUND" ? "CUSTOMER" : "SYSTEM"},
        ${overrides.status ?? "PENDING"}
      )
      returning id
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

async function recordStatusEvent(messageId: string, businessId: string, status: string, providerTimestamp?: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ record_whatsapp_message_status_event: string }[]>`
      select private.record_whatsapp_message_status_event(
        ${messageId}::uuid, ${businessId}::uuid, ${status}, ${providerTimestamp ?? null}::timestamptz, null
      ) as record_whatsapp_message_status_event
    `;
    return row.record_whatsapp_message_status_event;
  } finally {
    await sql.end();
  }
}

async function getMessageStatus(messageId: string) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<Record<string, unknown>[]>`select * from public.whatsapp_messages where id = ${messageId}`;
    return row;
  } finally {
    await sql.end();
  }
}

async function recordWebhookEvent(args: {
  provider?: string;
  key: string;
  eventType: string;
  hash: string;
  businessId?: string | null;
  numberId?: string | null;
  messageId?: string | null;
}) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<{ id: string; is_new: boolean }[]>`
      select * from private.record_whatsapp_webhook_event(
        ${args.provider ?? "META_CLOUD"}, ${args.key}, ${args.eventType}, ${args.hash},
        ${args.businessId ?? null}, ${args.numberId ?? null}, ${args.messageId ?? null}
      )
    `;
    return rows[0];
  } finally {
    await sql.end();
  }
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("Phase 1M — WhatsApp foundation: tenancy", () => {
  it("1. a member of business A cannot SELECT business B's whatsapp_accounts", async () => {
    const a = await makeOwner("wa-tenant-a");
    const b = await makeOwner("wa-tenant-b");
    await createWhatsappAccount(b.businessId, b.userId);

    const { data, error } = await a.client.from("whatsapp_accounts").select("id").eq("business_id", b.businessId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("2. a member of business A cannot SELECT business B's whatsapp_conversations or messages", async () => {
    const a = await makeOwner("wa-tenant-conv-a");
    const b = await makeOwner("wa-tenant-conv-b");
    const account = await createWhatsappAccount(b.businessId, b.userId);
    const number = await createWhatsappNumber(b.businessId, account);
    const conv = await createConversation(b.businessId, number, null);
    await createMessage(b.businessId, conv);

    const convRes = await a.client.from("whatsapp_conversations").select("id").eq("business_id", b.businessId);
    expect(convRes.data).toEqual([]);
    const msgRes = await a.client.from("whatsapp_messages").select("id").eq("business_id", b.businessId);
    expect(msgRes.data).toEqual([]);
  });

  it("3. record_customer_whatsapp_consent rejects a customer from a different business", async () => {
    const a = await makeOwner("wa-tenant-consent-a");
    const b = await makeOwner("wa-tenant-consent-b");
    const customerId = await createCustomer(b.client, b.businessId, "Cross Tenant Customer");

    const { error } = await a.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: a.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });
});

describe("Phase 1M — WhatsApp foundation: permissions", () => {
  it("4. OWNER can view whatsapp_accounts", async () => {
    const owner = await makeOwner("wa-perm-owner");
    await createWhatsappAccount(owner.businessId, owner.userId);
    const { data, error } = await owner.client.from("whatsapp_accounts").select("id").eq("business_id", owner.businessId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("5. ADMIN/MANAGER/SALES/ACCOUNTANT can view; INVENTORY and VIEWER cannot", async () => {
    const owner = await makeOwner("wa-perm-matrix");
    await createWhatsappAccount(owner.businessId, owner.userId);

    for (const role of ["ADMIN", "MANAGER", "SALES", "ACCOUNTANT"]) {
      const member = await createMemberWithRole(owner.businessId, `wa-perm-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      const { data, error } = await member.client
        .from("whatsapp_accounts")
        .select("id")
        .eq("business_id", owner.businessId);
      expect(error, role).toBeNull();
      expect(data, role).toHaveLength(1);
    }

    for (const role of ["INVENTORY", "VIEWER"]) {
      const member = await createMemberWithRole(owner.businessId, `wa-perm-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      const { data, error } = await member.client
        .from("whatsapp_accounts")
        .select("id")
        .eq("business_id", owner.businessId);
      expect(error, role).toBeNull();
      expect(data, role).toEqual([]);
    }
  });

  it("6. record_customer_whatsapp_consent requires whatsapp.manage — SALES (view+send only) is denied", async () => {
    const owner = await makeOwner("wa-perm-consent-manage");
    const customerId = await createCustomer(owner.client, owner.businessId, "Consent Manage Customer");
    const sales = await createMemberWithRole(owner.businessId, "wa-perm-consent-sales", "SALES");
    cleanupUserIds.push(sales.userId);

    const { error } = await sales.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });

  it("7. record_customer_whatsapp_consent succeeds for ADMIN (whatsapp.manage granted)", async () => {
    const owner = await makeOwner("wa-perm-consent-admin");
    const customerId = await createCustomer(owner.client, owner.businessId, "Consent Admin Customer");
    const admin = await createMemberWithRole(owner.businessId, "wa-perm-consent-admin2", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { data, error } = await admin.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });
});

describe("Phase 1M — WhatsApp foundation: RLS (membership status)", () => {
  it("8. a suspended member is denied SELECT on whatsapp_accounts", async () => {
    const owner = await makeOwner("wa-rls-suspended");
    await createWhatsappAccount(owner.businessId, owner.userId);
    const member = await createMemberWithRole(owner.businessId, "wa-rls-suspended-m", "ADMIN");
    cleanupUserIds.push(member.userId);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    const { data, error } = await member.client.from("whatsapp_accounts").select("id").eq("business_id", owner.businessId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("9. a nonmember is denied SELECT on whatsapp_accounts and whatsapp_messages", async () => {
    const owner = await makeOwner("wa-rls-nonmember");
    const outsider = await makeOwner("wa-rls-outsider");
    await createWhatsappAccount(owner.businessId, owner.userId);

    const accRes = await outsider.client.from("whatsapp_accounts").select("id").eq("business_id", owner.businessId);
    expect(accRes.data).toEqual([]);
    const msgRes = await outsider.client.from("whatsapp_messages").select("id").eq("business_id", owner.businessId);
    expect(msgRes.data).toEqual([]);
  });
});

describe("Phase 1M — WhatsApp foundation: branch model", () => {
  it("10. a phone number assigned to a branch from a different business is rejected", async () => {
    const a = await makeOwner("wa-branch-a");
    const b = await makeOwner("wa-branch-b");
    const account = await createWhatsappAccount(a.businessId, a.userId);
    const bBranch = await getDefaultBranchId(b.businessId);

    await expect(
      createWhatsappNumber(a.businessId, account, { branchId: bBranch })
    ).rejects.toThrow();
  });

  it("11. a conversation's branch must belong to the same business as the conversation", async () => {
    const a = await makeOwner("wa-branch-conv-a");
    const b = await makeOwner("wa-branch-conv-b");
    const account = await createWhatsappAccount(a.businessId, a.userId);
    const number = await createWhatsappNumber(a.businessId, account);
    const bBranch = await getDefaultBranchId(b.businessId);

    await expect(
      createConversation(a.businessId, number, null, { branchId: bBranch })
    ).rejects.toThrow();
  });

  it("12. a company-wide number (branch_id null) is a valid, supported configuration", async () => {
    const owner = await makeOwner("wa-branch-null");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const numberId = await createWhatsappNumber(owner.businessId, account, { branchId: null });
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ branch_id: string | null }[]>`select branch_id from public.whatsapp_phone_numbers where id = ${numberId}`;
      expect(row.branch_id).toBeNull();
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: customer consent", () => {
  it("13. service and marketing consent are tracked independently", async () => {
    const owner = await makeOwner("wa-consent-independent");
    const customerId = await createCustomer(owner.client, owner.businessId, "Independent Consent Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });

    const { data } = await owner.client
      .from("customer_whatsapp_preferences")
      .select("service_messages_allowed, marketing_messages_allowed")
      .eq("business_id", owner.businessId)
      .eq("customer_id", customerId)
      .single();

    expect(data?.service_messages_allowed).toBe(true);
    expect(data?.marketing_messages_allowed).toBe(false);
  });

  it("14. marketing opt-out overrides prior marketing consent and cannot be silently reset", async () => {
    const owner = await makeOwner("wa-consent-optout");
    const customerId = await createCustomer(owner.client, owner.businessId, "Opt Out Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "FORM",
    });
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_marketing_opt_out: true,
    });

    // An ordinary, unrelated edit (service consent only) must never
    // silently clear the opt-out.
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });

    const { data } = await owner.client
      .from("customer_whatsapp_preferences")
      .select("marketing_messages_allowed, marketing_opted_out_at")
      .eq("business_id", owner.businessId)
      .eq("customer_id", customerId)
      .single();

    expect(data?.marketing_messages_allowed).toBe(false);
    expect(data?.marketing_opted_out_at).not.toBeNull();
  });

  it("15. cannot set marketing_allowed=true and opt_out=true in the same call (contradictory request rejected)", async () => {
    const owner = await makeOwner("wa-consent-contradiction");
    const customerId = await createCustomer(owner.client, owner.businessId, "Contradiction Customer");

    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "FORM",
      p_marketing_opt_out: true,
    });
    expect(error).not.toBeNull();
  });

  it("16. no implicit marketing consent: creating a customer never creates a marketing-allowed preferences row", async () => {
    const owner = await makeOwner("wa-consent-no-implicit");
    const customerId = await createCustomer(owner.client, owner.businessId, "No Implicit Consent Customer");

    const { data } = await owner.client
      .from("customer_whatsapp_preferences")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("customer_id", customerId);
    // No preferences row exists at all until a consent RPC call creates
    // one — a phone number/customer record alone never implies consent.
    expect(data).toEqual([]);
  });

  it("17. an invalid consent source is rejected", async () => {
    const owner = await makeOwner("wa-consent-invalid-source");
    const customerId = await createCustomer(owner.client, owner.businessId, "Invalid Source Customer");

    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "MADE_UP_SOURCE",
    });
    expect(error).not.toBeNull();
  });

  it("18. record_customer_whatsapp_consent writes an audit event", async () => {
    const owner = await makeOwner("wa-consent-audit");
    const customerId = await createCustomer(owner.client, owner.businessId, "Audit Consent Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
        select action, metadata from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.consent_updated'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.customer_id).toBe(customerId);
      // Never a full phone number in audit metadata.
      expect(JSON.stringify(rows[0].metadata)).not.toMatch(/\+234\d{10}/);
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: provider identity", () => {
  it("19. a duplicate provider_business_account_id is rejected by the unique constraint", async () => {
    const owner = await makeOwner("wa-provider-dup-account");
    const wabaId = `waba-dup-${randomUuid()}`;
    await createWhatsappAccount(owner.businessId, owner.userId, { providerBusinessAccountId: wabaId });
    await expect(
      createWhatsappAccount(owner.businessId, owner.userId, { providerBusinessAccountId: wabaId })
    ).rejects.toThrow();
  });

  it("20. a duplicate provider_phone_number_id is rejected by the unique constraint", async () => {
    const owner = await makeOwner("wa-provider-dup-number");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const numberId = `pn-dup-${randomUuid()}`;
    await createWhatsappNumber(owner.businessId, account, { providerPhoneNumberId: numberId });
    await expect(
      createWhatsappNumber(owner.businessId, account, { providerPhoneNumberId: numberId })
    ).rejects.toThrow();
  });

  it("21. a phone number cannot be attached to a whatsapp_account from a different business", async () => {
    const a = await makeOwner("wa-provider-cross-a");
    const b = await makeOwner("wa-provider-cross-b");
    const accountB = await createWhatsappAccount(b.businessId, b.userId);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, provider_phone_number_id, display_phone_number)
          values (${a.businessId}, ${accountB}, ${`pn-${randomUuid()}`}, '+2348011112222')
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("22. at most one primary phone number per business", async () => {
    const owner = await makeOwner("wa-provider-one-primary");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    await createWhatsappNumber(owner.businessId, account, { isPrimary: true });
    await expect(createWhatsappNumber(owner.businessId, account, { isPrimary: true })).rejects.toThrow();
  });
});

describe("Phase 1M — WhatsApp foundation: messages", () => {
  it("23. provider_message_id is unique across the table", async () => {
    const owner = await makeOwner("wa-msg-unique-provider-id");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const providerMessageId = `wamid-${randomUuid()}`;
    await createMessage(owner.businessId, conv, { providerMessageId });
    await expect(createMessage(owner.businessId, conv, { providerMessageId })).rejects.toThrow();
  });

  it("24. direction integrity: an INBOUND message cannot be sender_kind=STAFF", async () => {
    const owner = await makeOwner("wa-msg-direction-integrity");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.whatsapp_messages (business_id, conversation_id, direction, message_type, sender_kind, status)
          values (${owner.businessId}, ${conv}, 'INBOUND', 'TEXT', 'STAFF', 'PENDING')
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("25. no arbitrary authenticated update of message status (no UPDATE grant at all)", async () => {
    const owner = await makeOwner("wa-msg-no-authenticated-update");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const messageId = await createMessage(owner.businessId, conv);

    const { error } = await owner.client.from("whatsapp_messages").update({ status: "DELIVERED" }).eq("id", messageId);
    expect(error).not.toBeNull();

    const row = await getMessageStatus(messageId);
    expect(row!.status).toBe("PENDING");
  });

  it("26. no arbitrary authenticated INSERT of a whatsapp_message", async () => {
    const owner = await makeOwner("wa-msg-no-authenticated-insert");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);

    const { error } = await owner.client.from("whatsapp_messages").insert({
      business_id: owner.businessId,
      conversation_id: conv,
      direction: "OUTBOUND",
      message_type: "TEXT",
      sender_kind: "SYSTEM",
      status: "PENDING",
    });
    expect(error).not.toBeNull();
  });
});

describe("Phase 1M — WhatsApp foundation: status monotonicity", () => {
  it("27. READ cannot regress to SENT via a delayed stale event", async () => {
    const owner = await makeOwner("wa-status-read-no-regress");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const messageId = await createMessage(owner.businessId, conv);

    await recordStatusEvent(messageId, owner.businessId, "ACCEPTED");
    await recordStatusEvent(messageId, owner.businessId, "SENT");
    await recordStatusEvent(messageId, owner.businessId, "DELIVERED");
    await recordStatusEvent(messageId, owner.businessId, "READ");
    // Stale, delayed SENT event arrives after READ.
    await recordStatusEvent(messageId, owner.businessId, "SENT");

    const row = await getMessageStatus(messageId);
    expect(row!.status).toBe("READ");
  });

  it("28. DELIVERED cannot regress to SENT via a delayed stale event", async () => {
    const owner = await makeOwner("wa-status-delivered-no-regress");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const messageId = await createMessage(owner.businessId, conv);

    await recordStatusEvent(messageId, owner.businessId, "ACCEPTED");
    await recordStatusEvent(messageId, owner.businessId, "SENT");
    await recordStatusEvent(messageId, owner.businessId, "DELIVERED");
    await recordStatusEvent(messageId, owner.businessId, "SENT");

    const row = await getMessageStatus(messageId);
    expect(row!.status).toBe("DELIVERED");
  });

  it("29. a FAILED event applies from a non-terminal state and does not resurrect from FAILED via a stale delivery event", async () => {
    const owner = await makeOwner("wa-status-failed-terminal");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const messageId = await createMessage(owner.businessId, conv);

    await recordStatusEvent(messageId, owner.businessId, "ACCEPTED");
    await recordStatusEvent(messageId, owner.businessId, "FAILED");
    let row = await getMessageStatus(messageId);
    expect(row!.status).toBe("FAILED");

    // Stale delivery-progress event arrives after FAILED — never
    // resurrects the message.
    await recordStatusEvent(messageId, owner.businessId, "DELIVERED");
    row = await getMessageStatus(messageId);
    expect(row!.status).toBe("FAILED");
  });

  it("30. every status event is preserved in the append-only history, even non-advancing ones", async () => {
    const owner = await makeOwner("wa-status-history-preserved");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    const conv = await createConversation(owner.businessId, number, null);
    const messageId = await createMessage(owner.businessId, conv);

    await recordStatusEvent(messageId, owner.businessId, "ACCEPTED");
    await recordStatusEvent(messageId, owner.businessId, "SENT");
    await recordStatusEvent(messageId, owner.businessId, "DELIVERED");
    await recordStatusEvent(messageId, owner.businessId, "READ");
    await recordStatusEvent(messageId, owner.businessId, "SENT"); // stale, non-advancing

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ status: string }[]>`
        select status from public.whatsapp_message_status_events where message_id = ${messageId} order by received_at
      `;
      expect(rows.map((r) => r.status)).toEqual(["ACCEPTED", "SENT", "DELIVERED", "READ", "SENT"]);
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: webhook event idempotency", () => {
  it("31. exact replay (same key, same hash/association) returns the existing row, is_new=false", async () => {
    const owner = await makeOwner("wa-webhook-exact-replay");
    const key = `evt-${randomUuid()}`;
    const first = await recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: owner.businessId });
    expect(first.is_new).toBe(true);

    const replay = await recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: owner.businessId });
    expect(replay.is_new).toBe(false);
    expect(replay.id).toBe(first.id);

    const sql = createTestDbClient();
    try {
      const rows = await sql`select count(*)::int as n from private.whatsapp_webhook_events where provider_event_key = ${key}`;
      expect(rows[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("32. same key with a changed payload hash conflicts", async () => {
    const owner = await makeOwner("wa-webhook-changed-hash");
    const key = `evt-${randomUuid()}`;
    await recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: owner.businessId });
    await expect(
      recordWebhookEvent({ key, eventType: "message.received", hash: HASH_B, businessId: owner.businessId })
    ).rejects.toThrow();
  });

  it("33. same key with a changed business association conflicts", async () => {
    const a = await makeOwner("wa-webhook-changed-assoc-a");
    const b = await makeOwner("wa-webhook-changed-assoc-b");
    const key = `evt-${randomUuid()}`;
    await recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: a.businessId });
    await expect(
      recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: b.businessId })
    ).rejects.toThrow();
  });

  it("34. concurrent identical inserts for the same key resolve to exactly one row, only one is_new=true", async () => {
    const owner = await makeOwner("wa-webhook-concurrent");
    const key = `evt-${randomUuid()}`;
    const [r1, r2] = await Promise.all([
      recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: owner.businessId }),
      recordWebhookEvent({ key, eventType: "message.received", hash: HASH_A, businessId: owner.businessId }),
    ]);
    const newCount = [r1.is_new, r2.is_new].filter(Boolean).length;
    expect(newCount).toBe(1);
    expect(r1.id).toBe(r2.id);
  });

  it("35. no raw payload column exists on the webhook events table (hash only)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'private' and table_name = 'whatsapp_webhook_events'
      `;
      const names = rows.map((r) => r.column_name);
      expect(names).toContain("payload_sha256");
      expect(names).not.toContain("payload");
      expect(names).not.toContain("raw_payload");
      expect(names).not.toContain("body");
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: service consent fails closed (WA-1M-01)", () => {
  async function getPrefs(businessId: string, customerId: string) {
    const sql = createTestDbClient();
    try {
      const rows = await sql<Record<string, unknown>[]>`
        select * from public.customer_whatsapp_preferences
        where business_id = ${businessId} and customer_id = ${customerId}
      `;
      return rows[0] as
        | {
            service_messages_allowed: boolean;
            service_consent_source: string | null;
            service_consented_at: string | null;
            marketing_messages_allowed: boolean;
            marketing_opted_out_at: string | null;
          }
        | undefined;
    } finally {
      await sql.end();
    }
  }

  it("47. no preference row: COALESCE(service_messages_allowed, false) interprets as service messaging NOT allowed", async () => {
    const owner = await makeOwner("wa-service-no-row");
    const customerId = await createCustomer(owner.client, owner.businessId, "No Row Customer");
    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs).toBeUndefined();
  });

  it("48. a marketing-only consent update creates a row with service_messages_allowed = false", async () => {
    const owner = await makeOwner("wa-service-marketing-only");
    const customerId = await createCustomer(owner.client, owner.businessId, "Marketing Only Customer");

    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "FORM",
    });
    expect(error).toBeNull();

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.service_messages_allowed).toBe(false);
    expect(prefs?.service_consent_source).toBeNull();
    expect(prefs?.service_consented_at).toBeNull();
  });

  it("49. marketing consent true does not imply service consent unless explicitly enabled", async () => {
    const owner = await makeOwner("wa-service-marketing-true-not-service");
    const customerId = await createCustomer(owner.client, owner.businessId, "Marketing True Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "CHECKOUT",
    });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.marketing_messages_allowed).toBe(true);
    expect(prefs?.service_messages_allowed).toBe(false);
  });

  it("50. marketing opt-out does not change service consent state", async () => {
    const owner = await makeOwner("wa-service-optout-independent");
    const customerId = await createCustomer(owner.client, owner.businessId, "Opt Out Independent Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_marketing_opt_out: true,
    });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.service_messages_allowed).toBe(true);
  });

  it("51. explicit service enable with a valid source sets allowed=true, records source, and stamps a timestamp", async () => {
    const owner = await makeOwner("wa-service-enable-valid");
    const customerId = await createCustomer(owner.client, owner.businessId, "Service Enable Customer");

    const before = new Date();
    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "CUSTOMER_REQUEST",
    });
    expect(error).toBeNull();

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.service_messages_allowed).toBe(true);
    expect(prefs?.service_consent_source).toBe("CUSTOMER_REQUEST");
    expect(prefs?.service_consented_at).not.toBeNull();
    expect(new Date(prefs!.service_consented_at as string).getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
  });

  it("52. explicit service enable WITHOUT a source is rejected", async () => {
    const owner = await makeOwner("wa-service-enable-no-source");
    const customerId = await createCustomer(owner.client, owner.businessId, "Service Enable No Source Customer");

    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
    });
    expect(error).not.toBeNull();

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs).toBeUndefined();
  });

  it("53. explicit service revoke sets service_messages_allowed = false", async () => {
    const owner = await makeOwner("wa-service-revoke");
    const customerId = await createCustomer(owner.client, owner.businessId, "Service Revoke Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    const { error } = await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: false,
    });
    expect(error).toBeNull();

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.service_messages_allowed).toBe(false);
  });

  it("54. service revoke does not change marketing state", async () => {
    const owner = await makeOwner("wa-service-revoke-marketing-independent");
    const customerId = await createCustomer(owner.client, owner.businessId, "Revoke Marketing Independent Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "FORM",
    });
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: false,
    });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.marketing_messages_allowed).toBe(true);
  });

  it("55. service enable does not change marketing state", async () => {
    const owner = await makeOwner("wa-service-enable-marketing-independent");
    const customerId = await createCustomer(owner.client, owner.businessId, "Enable Marketing Independent Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_marketing_opt_out: true,
    });
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.marketing_messages_allowed).toBe(false);
    expect(prefs?.marketing_opted_out_at).not.toBeNull();
  });

  it("56. no implicit service consent from customer creation alone", async () => {
    const owner = await makeOwner("wa-service-no-implicit-customer");
    const customerId = await createCustomer(owner.client, owner.businessId, "No Implicit Service Customer");
    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs).toBeUndefined();
  });

  it("57. no implicit service consent from phone number existence (whatsapp_conversations customer_phone_e164)", async () => {
    const owner = await makeOwner("wa-service-no-implicit-phone");
    const customerId = await createCustomer(owner.client, owner.businessId, "No Implicit Phone Customer");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const number = await createWhatsappNumber(owner.businessId, account);
    await createConversation(owner.businessId, number, customerId, { phone: "+2348055556666" });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs).toBeUndefined();
  });

  it("58. no implicit service consent from marketing preference creation", async () => {
    const owner = await makeOwner("wa-service-no-implicit-marketing-row");
    const customerId = await createCustomer(owner.client, owner.businessId, "No Implicit Marketing Row Customer");

    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_marketing: true,
      p_marketing_allowed: true,
      p_marketing_consent_source: "IMPORT_DECLARED",
    });

    const prefs = await getPrefs(owner.businessId, customerId);
    expect(prefs?.service_messages_allowed).toBe(false);
  });

  it("59. cross-business customer update is denied for the consent RPC", async () => {
    const a = await makeOwner("wa-service-cross-business-a");
    const b = await makeOwner("wa-service-cross-business-b");
    const customerId = await createCustomer(b.client, b.businessId, "Cross Business Service Customer");

    const { error } = await a.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: a.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });

  it("60. an inactive (suspended) member is denied the consent RPC", async () => {
    const owner = await makeOwner("wa-service-inactive-member");
    const customerId = await createCustomer(owner.client, owner.businessId, "Inactive Member Customer");
    const member = await createMemberWithRole(owner.businessId, "wa-service-inactive-m", "ADMIN");
    cleanupUserIds.push(member.userId);

    const sql = createTestDbClient();
    try {
      await sql`update public.business_members set status = 'suspended' where business_id = ${owner.businessId} and user_id = ${member.userId}`;
    } finally {
      await sql.end();
    }

    const { error } = await member.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });

  it("61. a nonmember is denied the consent RPC", async () => {
    const owner = await makeOwner("wa-service-nonmember");
    const outsider = await makeOwner("wa-service-nonmember-outsider");
    const customerId = await createCustomer(owner.client, owner.businessId, "Nonmember Denied Customer");

    const { error } = await outsider.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });

  it("62. INVENTORY and VIEWER (no whatsapp.manage) are denied the consent RPC", async () => {
    const owner = await makeOwner("wa-service-inv-viewer-denied");
    const customerId = await createCustomer(owner.client, owner.businessId, "Inventory Viewer Denied Customer");

    for (const role of ["INVENTORY", "VIEWER"]) {
      const member = await createMemberWithRole(owner.businessId, `wa-service-${role.toLowerCase()}`, role);
      cleanupUserIds.push(member.userId);
      const { error } = await member.client.rpc("record_customer_whatsapp_consent", {
        p_business_id: owner.businessId,
        p_customer_id: customerId,
        p_set_service: true,
        p_service_allowed: true,
        p_service_consent_source: "STAFF_RECORDED",
      });
      expect(error, role).not.toBeNull();
    }
  });

  it("63. an authorized role with whatsapp.manage (ADMIN) succeeds per the current permission matrix", async () => {
    const owner = await makeOwner("wa-service-admin-succeeds");
    const customerId = await createCustomer(owner.client, owner.businessId, "Admin Succeeds Customer");
    const admin = await createMemberWithRole(owner.businessId, "wa-service-admin-succeeds-m", "ADMIN");
    cleanupUserIds.push(admin.userId);

    const { error } = await admin.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).toBeNull();
  });

  it("64. PUBLIC cannot execute record_customer_whatsapp_consent", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has: boolean }[]>`
        select has_function_privilege(
          'public',
          'public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)',
          'EXECUTE'
        ) as has
      `;
      expect(rows[0].has).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("65. anon cannot execute record_customer_whatsapp_consent", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has: boolean }[]>`
        select has_function_privilege(
          'anon',
          'public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)',
          'EXECUTE'
        ) as has
      `;
      expect(rows[0].has).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("66. service_role cannot execute record_customer_whatsapp_consent after the WA-1M-01 cleanup", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has: boolean }[]>`
        select has_function_privilege(
          'service_role',
          'public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)',
          'EXECUTE'
        ) as has
      `;
      expect(rows[0].has).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it("67. authenticated caller can execute only when the internal whatsapp.manage check passes", async () => {
    const owner = await makeOwner("wa-service-authenticated-gated");
    const customerId = await createCustomer(owner.client, owner.businessId, "Authenticated Gated Customer");
    const sales = await createMemberWithRole(owner.businessId, "wa-service-authenticated-gated-sales", "SALES");
    cleanupUserIds.push(sales.userId);

    // authenticated role-level grant exists (has_function_privilege
    // true), but the internal whatsapp.manage permission check still
    // denies a caller without that permission.
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ has: boolean }[]>`
        select has_function_privilege(
          'authenticated',
          'public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)',
          'EXECUTE'
        ) as has
      `;
      expect(rows[0].has).toBe(true);
    } finally {
      await sql.end();
    }

    const { error } = await sales.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId,
      p_customer_id: customerId,
      p_set_service: true,
      p_service_allowed: true,
      p_service_consent_source: "STAFF_RECORDED",
    });
    expect(error).not.toBeNull();
  });
});

describe("Phase 1M — WhatsApp foundation: templates", () => {
  it("36. an ordinary authenticated user cannot forge a template's provider-approval status (no write grant)", async () => {
    const owner = await makeOwner("wa-template-no-forge");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);

    const { error: insertError } = await owner.client.from("whatsapp_templates").insert({
      business_id: owner.businessId,
      whatsapp_account_id: account,
      name: "order_update",
      language: "en",
      status: "APPROVED",
    });
    expect(insertError).not.toBeNull();
  });

  it("37. template name+language is unique per business", async () => {
    const owner = await makeOwner("wa-template-unique-name-lang");
    const account = await createWhatsappAccount(owner.businessId, owner.userId);
    const sql = createTestDbClient();
    try {
      await sql`
        insert into public.whatsapp_templates (business_id, whatsapp_account_id, name, language)
        values (${owner.businessId}, ${account}, 'order_update', 'en')
      `;
      await expect(
        sql`
          insert into public.whatsapp_templates (business_id, whatsapp_account_id, name, language)
          values (${owner.businessId}, ${account}, 'order_update', 'en')
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: ACL", () => {
  it("38. neither trusted private writer function has PUBLIC/anon/authenticated/service_role EXECUTE", async () => {
    const sql = createTestDbClient();
    try {
      for (const fn of ["record_whatsapp_webhook_event", "record_whatsapp_message_status_event"]) {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'private' and p.proname = ${fn} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee);
        expect(grantees, fn).not.toContain("PUBLIC");
        expect(grantees, fn).not.toContain("anon");
        expect(grantees, fn).not.toContain("authenticated");
        expect(grantees, fn).not.toContain("service_role");
      }
    } finally {
      await sql.end();
    }
  });

  it("39. record_customer_whatsapp_consent is granted to authenticated only — never service_role/anon/PUBLIC (WA-1M-01 least-privilege cleanup)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ grantee: string }[]>`
        select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) as acl
        left join pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public' and p.proname = 'record_customer_whatsapp_consent' and acl.privilege_type = 'EXECUTE'
      `;
      const grantees = rows.map((r) => r.grantee).sort();
      expect(grantees).toContain("authenticated");
      // This is a user/staff action RPC reached only through its own
      // internal whatsapp.manage check — no repository caller runs as
      // service_role, so EXECUTE was revoked from it (WA-1M-01).
      expect(grantees).not.toContain("service_role");
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("anon");
    } finally {
      await sql.end();
    }
  });

  it("40. no anon table access anywhere on any whatsapp_* or customer_whatsapp_preferences table", async () => {
    const sql = createTestDbClient();
    try {
      for (const table of [
        "whatsapp_accounts",
        "whatsapp_phone_numbers",
        "whatsapp_conversations",
        "whatsapp_messages",
        "whatsapp_message_status_events",
        "whatsapp_templates",
        "customer_whatsapp_preferences",
      ]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const rows = await sql<{ has: boolean }[]>`select has_table_privilege('anon', ${"public." + table}, ${priv}) as has`;
          expect(rows[0].has, `${table}.${priv}`).toBe(false);
        }
      }
    } finally {
      await sql.end();
    }
  });

  it("41. authenticated has no direct INSERT/UPDATE/DELETE on any provider-backed table", async () => {
    const sql = createTestDbClient();
    try {
      for (const table of [
        "whatsapp_accounts",
        "whatsapp_phone_numbers",
        "whatsapp_messages",
        "whatsapp_message_status_events",
        "whatsapp_templates",
      ]) {
        for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
          const rows = await sql<{ has: boolean }[]>`select has_table_privilege('authenticated', ${"public." + table}, ${priv}) as has`;
          expect(rows[0].has, `${table}.${priv}`).toBe(false);
        }
      }
    } finally {
      await sql.end();
    }
  });

  it("42. private.whatsapp_webhook_events has no SELECT/INSERT/UPDATE/DELETE grant for service_role", async () => {
    const sql = createTestDbClient();
    try {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const rows = await sql<{ has: boolean }[]>`select has_table_privilege('service_role', 'private.whatsapp_webhook_events', ${priv}) as has`;
        expect(rows[0].has, priv).toBe(false);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("Phase 1M — WhatsApp foundation: data privacy", () => {
  it("43. no access-token/app-secret/verify-token column exists on whatsapp_accounts", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'whatsapp_accounts'
      `;
      const names = rows.map((r) => r.column_name.toLowerCase());
      for (const forbidden of ["access_token", "app_secret", "verify_token", "secret", "token"]) {
        expect(names, forbidden).not.toContain(forbidden);
      }
    } finally {
      await sql.end();
    }
  });

  it("44. whatsapp_messages has no raw provider-webhook-payload column", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'whatsapp_messages'
      `;
      const names = rows.map((r) => r.column_name.toLowerCase());
      expect(names).not.toContain("raw_payload");
      expect(names).not.toContain("payload");
      expect(names).not.toContain("webhook_payload");
    } finally {
      await sql.end();
    }
  });

  it("45. WhatsApp is never gated by a feature entitlement key — no whatsapp.* row exists in plan_entitlements", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ entitlement_key: string }[]>`
        select entitlement_key from public.plan_entitlements where entitlement_key like 'feature.whatsapp%' or entitlement_key like 'whatsapp.%'
      `;
      expect(rows).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("46. all four paid plans exist and none carries a WhatsApp-blocking entitlement", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ code: string }[]>`select code from public.subscription_plans`;
      const codes = rows.map((r) => r.code);
      for (const plan of ["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE"]) {
        expect(codes, plan).toContain(plan);
      }
    } finally {
      await sql.end();
    }
  });
});
