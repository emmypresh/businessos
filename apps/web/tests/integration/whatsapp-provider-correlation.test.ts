import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// WA-APP-02-R1 remediation — real-Postgres proof that a durable,
// provider-independent opaque correlation token exists BEFORE Meta is
// ever contacted, that it alone never authorizes a mutation, and that a
// later signed status webhook carrying it back can recover a
// provider_message_id that an immediate post-send bind attempt never
// reached PostgreSQL to record. See
// supabase/migrations/20260908080200_whatsapp_outbound_provider_correlation.sql
// for the full design rationale.

const CORRELATIONS_TABLE = "private.whatsapp_outbound_provider_correlations";

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

async function beginPendingMessage(owner: Awaited<ReturnType<typeof makeOwner>>, numberId: string, clientCreationKey?: string) {
  const customerId = await createCustomer(owner.client, owner.businessId, "Correlation Test Customer");
  await owner.client.rpc("record_customer_whatsapp_consent", {
    p_business_id: owner.businessId, p_customer_id: customerId,
    p_set_service: true, p_service_allowed: true, p_service_consent_source: "STAFF_RECORDED",
  });
  const sql = createTestDbClient();
  let convId: string;
  try {
    const [conv] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status, customer_service_window_ends_at)
      values (${owner.businessId}, ${customerId}, ${numberId}, '+2348012340077', 'OPEN', now() + interval '12 hours')
      returning id
    `;
    convId = conv.id;
  } finally {
    await sql.end();
  }
  const key = clientCreationKey ?? randomUuid();
  const { data, error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
    p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT",
    p_body_text: "hi", p_client_creation_key: key,
  });
  if (error || !data?.[0]) throw new Error(`begin_whatsapp_outbound_message failed: ${error?.message}`);
  return { messageId: data[0].message_id as string, opaqueCallbackToken: data[0].opaque_callback_token as string, clientCreationKey: key };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("WA-APP-02-R1 — pre-send correlation durability", () => {
  it("1/2/5. a new outbound message atomically creates exactly one durable opaque token BEFORE any provider contact, with no identifiable data", async () => {
    const owner = await makeOwner("wa-corr-presend");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(owner, numberId);

    expect(opaqueCallbackToken).toMatch(/^[0-9a-f]{32}$/);

    const sql = createTestDbClient();
    try {
      const rows = await sql<{ opaque_callback_token: string; state: string; provider_message_id: string | null }[]>`
        select opaque_callback_token, state, provider_message_id from private.whatsapp_outbound_provider_correlations
        where whatsapp_message_id = ${messageId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].opaque_callback_token).toBe(opaqueCallbackToken);
      expect(rows[0].state).toBe("PENDING_PROVIDER");
      expect(rows[0].provider_message_id).toBeNull();
      // No business/customer/message/phone identifiers embedded — bare
      // 32-hex-char opaque value only.
      expect(opaqueCallbackToken).not.toContain(owner.businessId.replace(/-/g, ""));
      expect(opaqueCallbackToken).not.toBe(messageId.replace(/-/g, ""));
    } finally {
      await sql.end();
    }
  });

  it("3. a same client_creation_key replay returns the SAME token, never a new one", async () => {
    const owner = await makeOwner("wa-corr-replay");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, opaqueCallbackToken, clientCreationKey } = await beginPendingMessage(owner, numberId);

    const conv = await createTestDbClient();
    let conversationId: string;
    try {
      const [row] = await conv<{ conversation_id: string }[]>`select conversation_id from public.whatsapp_messages where id = ${messageId}`;
      conversationId = row.conversation_id;
    } finally {
      await conv.end();
    }

    const { data } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: conversationId, p_message_type: "TEXT",
      p_body_text: "hi", p_client_creation_key: clientCreationKey,
    });
    expect(data?.[0]?.is_new).toBe(false);
    expect(data?.[0]?.opaque_callback_token).toBe(opaqueCallbackToken);

    const sql = createTestDbClient();
    try {
      const count = await sql`select count(*)::int as n from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}`;
      expect(count[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("4. concurrent begin_whatsapp_outbound_message calls with the SAME client_creation_key create exactly one correlation row", async () => {
    const owner = await makeOwner("wa-corr-concurrent");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const customerId = await createCustomer(owner.client, owner.businessId, "Concurrent Customer");
    await owner.client.rpc("record_customer_whatsapp_consent", {
      p_business_id: owner.businessId, p_customer_id: customerId,
      p_set_service: true, p_service_allowed: true, p_service_consent_source: "STAFF_RECORDED",
    });
    const sql = createTestDbClient();
    let convId: string;
    try {
      const [conv] = await sql<{ id: string }[]>`
        insert into public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status, customer_service_window_ends_at)
        values (${owner.businessId}, ${customerId}, ${numberId}, '+2348012340088', 'OPEN', now() + interval '12 hours')
        returning id
      `;
      convId = conv.id;
    } finally {
      await sql.end();
    }
    const key = randomUuid();
    const [r1, r2] = await Promise.all([
      owner.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
      }),
      owner.client.rpc("begin_whatsapp_outbound_message", {
        p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT", p_body_text: "hi", p_client_creation_key: key,
      }),
    ]);
    const messageId = r1.data?.[0]?.message_id ?? r2.data?.[0]?.message_id;
    expect(messageId).toBeTruthy();
    const tokens = new Set([r1.data?.[0]?.opaque_callback_token, r2.data?.[0]?.opaque_callback_token].filter(Boolean));
    expect(tokens.size).toBe(1);

    const sql2 = createTestDbClient();
    try {
      const count = await sql2`select count(*)::int as n from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId!}`;
      expect(count[0].n).toBe(1);
    } finally {
      await sql2.end();
    }
  });
});

describe("WA-APP-02-R1 — immediate bind also resolves the correlation", () => {
  it("repair_whatsapp_provider_bind resolving a message also marks its correlation RESOLVED with the matching provider id", async () => {
    const owner = await makeOwner("wa-corr-bind-resolve");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId } = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)`;

      const [row] = await sql<{ state: string; provider_message_id: string; resolved_at: string | null }[]>`
        select state, provider_message_id, resolved_at from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}
      `;
      expect(row.state).toBe("RESOLVED");
      expect(row.provider_message_id).toBe(providerMessageId);
      expect(row.resolved_at).not.toBeNull();
    } finally {
      await sql.end();
    }
  });
});

describe("WA-APP-02-R1 — critical case: bind never reaches Postgres, status webhook recovers it", () => {
  it("9/10/11/16. an unbound message with a durable correlation is recovered by a signed status webhook carrying the callback token", async () => {
    const owner = await makeOwner("wa-corr-webhook-recover");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    // Simulates: Meta accepted the send AND returned this wamid, but the
    // immediate repair_whatsapp_provider_bind call never reached
    // Postgres at all — no repair row, no bound provider_message_id,
    // ONLY the pre-send correlation exists.
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      const [before] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(before.provider_message_id).toBeNull();

      const [result] = await sql<{ ledger_status: string; message_resolved: boolean }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${`evt-${randomUuid()}`}, p_payload_sha256 => ${HASH_A},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${providerMessageId}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${opaqueCallbackToken}
        )
      `;
      expect(result.ledger_status).toBe("PROCESSED");
      expect(result.message_resolved).toBe(true);

      const [after] = await sql<{ provider_message_id: string | null; status: string }[]>`
        select provider_message_id, status from public.whatsapp_messages where id = ${messageId}
      `;
      expect(after.provider_message_id).toBe(providerMessageId);
      expect(after.status).toBe("DELIVERED");

      const [correlation] = await sql<{ state: string }[]>`
        select state from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}
      `;
      expect(correlation.state).toBe("RESOLVED");
    } finally {
      await sql.end();
    }
  });

  it("20. a later replay of the same status webhook event does nothing duplicate", async () => {
    const owner = await makeOwner("wa-corr-webhook-replay");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;
    const key = `evt-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`
        select public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${key}, p_payload_sha256 => ${HASH_A},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${providerMessageId}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${opaqueCallbackToken}
        )
      `;
      const [replay] = await sql<{ ledger_status: string }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${key}, p_payload_sha256 => ${HASH_A},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${providerMessageId}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${opaqueCallbackToken}
        )
      `;
      expect(replay.ledger_status).toBe("PROCESSED");

      // The FIRST call legitimately records TWO status transitions —
      // ACCEPTED (from the callback-assisted repair_whatsapp_provider_bind
      // it triggers) and DELIVERED (the status this webhook itself
      // carries) — an exact replay must add ZERO more.
      const events = await sql`select count(*)::int as n from public.whatsapp_message_status_events where message_id = ${messageId}`;
      expect(events[0].n).toBe(2);
    } finally {
      await sql.end();
    }
  });

  it("12/13. a same client_creation_key retry after a lost bind response never calls Meta again and remains reconcilable via the reconciliation-state RPC", async () => {
    const owner = await makeOwner("wa-corr-retry-no-resend");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, clientCreationKey } = await beginPendingMessage(owner, numberId);

    const sqlBefore = createTestDbClient();
    let conversationId: string;
    try {
      const [row] = await sqlBefore<{ conversation_id: string }[]>`select conversation_id from public.whatsapp_messages where id = ${messageId}`;
      conversationId = row.conversation_id;
    } finally {
      await sqlBefore.end();
    }

    // Retry with the SAME client_creation_key — must return is_new=false
    // and never create a second message or correlation.
    const { data } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: conversationId, p_message_type: "TEXT",
      p_body_text: "hi", p_client_creation_key: clientCreationKey,
    });
    expect(data?.[0]?.is_new).toBe(false);
    expect(data?.[0]?.message_id).toBe(messageId);

    const admin = createTestDbClient();
    try {
      const [state] = await admin<{ bound_provider_message_id: string | null; correlation_token_exists: boolean }[]>`
        select * from public.get_whatsapp_outbound_message_reconciliation_state(${messageId}::uuid, ${owner.businessId}::uuid)
      `;
      expect(state.bound_provider_message_id).toBeNull();
      expect(state.correlation_token_exists).toBe(true);
    } finally {
      await admin.end();
    }
  });
});

describe("WA-APP-02-R1 — cross-tenant and conflict safety", () => {
  it("25. a callback token belonging to Business A is rejected when the webhook's own provider phone resolves to Business B", async () => {
    const a = await makeOwner("wa-corr-tenant-a");
    const b = await makeOwner("wa-corr-tenant-b");
    const { numberId: numberA } = await setupConnectedAccount(a.businessId, a.userId);
    const { numberId: numberB } = await setupConnectedAccount(b.businessId, b.userId);
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(a, numberA);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      const [result] = await sql<{ ledger_status: string; message_resolved: boolean }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${`evt-${randomUuid()}`}, p_payload_sha256 => ${HASH_B},
          p_business_id => ${b.businessId}::uuid, p_whatsapp_phone_number_id => ${numberB}::uuid,
          p_provider_message_id => ${providerMessageId}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${opaqueCallbackToken}
        )
      `;
      expect(result.ledger_status).toBe("IGNORED");
      expect(result.message_resolved).toBe(false);

      const [msg] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.provider_message_id).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it("26. a callback token for Message A is rejected when its provider wamid already directly resolves to a different Message B", async () => {
    const owner = await makeOwner("wa-corr-conflict-ab");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const msgA = await beginPendingMessage(owner, numberId);
    const msgB = await beginPendingMessage(owner, numberId);
    const wamidForB = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      // B already directly bound to wamidForB.
      await sql`select public.repair_whatsapp_provider_bind(${msgB.messageId}::uuid, ${owner.businessId}::uuid, ${wamidForB}, ${owner.userId}::uuid)`;

      // A status webhook naming A's own callback token but B's wamid.
      const [result] = await sql<{ ledger_status: string; message_resolved: boolean }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${`evt-${randomUuid()}`}, p_payload_sha256 => ${HASH_B},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${wamidForB}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${msgA.opaqueCallbackToken}
        )
      `;
      expect(result.ledger_status).toBe("IGNORED");

      const [a] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${msgA.messageId}`;
      expect(a.provider_message_id).toBeNull();
      const [b] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${msgB.messageId}`;
      expect(b.provider_message_id).toBe(wamidForB); // unchanged
    } finally {
      await sql.end();
    }
  });

  it("27. an unknown/unmatched callback token with an otherwise-unresolvable wamid is IGNORED, never mutates anything", async () => {
    const owner = await makeOwner("wa-corr-unknown-token");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);

    const sql = createTestDbClient();
    try {
      const [result] = await sql<{ ledger_status: string }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${`evt-${randomUuid()}`}, p_payload_sha256 => ${HASH_A},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${`wamid-unknown-${randomUuid()}`}, p_status => 'DELIVERED',
          p_provider_timestamp => null, p_failure_reason => null,
          p_opaque_callback_token => ${"f".repeat(32)}
        )
      `;
      expect(result.ledger_status).toBe("IGNORED");
    } finally {
      await sql.end();
    }
  });
});

describe("WA-APP-02-R1 — ACL", () => {
  it("28/29/30/31/32. authenticated/anon cannot read the correlation table or bind via any surface; service_role only via the intended function-only path", async () => {
    const sql = createTestDbClient();
    try {
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const rows = await sql<{ has: boolean }[]>`
            select has_table_privilege(${role}, ${CORRELATIONS_TABLE}, ${priv}) as has
          `;
          expect(rows[0].has, `${role}/${priv}`).toBe(false);
        }
      }
      // service_role itself gets zero direct table access too — the
      // ONLY path is through the trusted functions, exactly like this
      // codebase's own whatsapp_webhook_events / whatsapp_provider_bind_repairs
      // precedent.
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const rows = await sql<{ has: boolean }[]>`
          select has_table_privilege('service_role', ${CORRELATIONS_TABLE}, ${priv}) as has
        `;
        expect(rows[0].has, `service_role/${priv}`).toBe(false);
      }

      const sig = "public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text, text)";
      for (const role of ["anon", "authenticated"]) {
        const rows = await sql<{ has: boolean }[]>`select has_function_privilege(${role}, ${sig}, 'EXECUTE') as has`;
        expect(rows[0].has, `${sig} / ${role}`).toBe(false);
      }
      const svc = await sql<{ has: boolean }[]>`select has_function_privilege('service_role', ${sig}, 'EXECUTE') as has`;
      expect(svc[0].has).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("no PUBLIC EXECUTE exists on any new/redefined function from this migration (no null-grantee ACL entry)", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ proname: string; has_public_grant: boolean }[]>`
        select p.proname,
               exists (
                 select 1 from aclexplode(p.proacl) g where g.grantee = 0
               ) as has_public_grant
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'begin_whatsapp_outbound_message',
            'repair_whatsapp_provider_bind',
            'ingest_and_process_whatsapp_status_event',
            'get_whatsapp_outbound_message_reconciliation_state'
          )
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.has_public_grant, row.proname).toBe(false);
      }
    } finally {
      await sql.end();
    }
  });
});
