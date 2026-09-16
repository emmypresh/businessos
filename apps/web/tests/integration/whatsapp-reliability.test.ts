import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// WA-APP-01 / WA-APP-02 remediation — real-Postgres proof that:
//  - a transient downstream-mutation failure never permanently loses a
//    verified webhook event (WA-APP-01: exact replay repairs it), and
//  - a provider-accepted outbound message never permanently loses its
//    provider_message_id (WA-APP-02: a durable repair obligation always
//    survives a failed bind attempt and can be retried to completion).
// See supabase/migrations/20260908080100_whatsapp_provider_reliability.sql
// for the full design rationale.

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

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function callIngestInbound(args: {
  key: string;
  hash?: string;
  businessId: string;
  numberId: string;
  phone?: string;
  providerMessageId: string;
  customerId?: string | null;
}) {
  const sql = createTestDbClient();
  try {
    return await sql<{ message_id: string | null; conversation_id: string | null; is_new_message: boolean; ledger_status: string }[]>`
      select * from public.ingest_and_process_whatsapp_inbound_message(
        p_provider_event_key => ${args.key},
        p_payload_sha256 => ${args.hash ?? HASH_A},
        p_business_id => ${args.businessId}::uuid,
        p_whatsapp_phone_number_id => ${args.numberId}::uuid,
        p_customer_phone_e164 => ${args.phone ?? "+2348012340000"},
        p_provider_message_id => ${args.providerMessageId},
        p_message_type => 'TEXT',
        p_customer_id => ${args.customerId ?? null}
      )
    `;
  } finally {
    await sql.end();
  }
}

describe("WA-APP-01 — inbound message reliability", () => {
  it("1. a transient downstream failure marks the ledger FAILED_RETRYABLE, not PROCESSED", async () => {
    const owner = await makeOwner("wa-rel-inbound-fail");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const key = `evt-${randomUuid()}`;
    const providerMessageId = `wamid-${randomUuid()}`;

    // Forces the downstream mutation to fail: a customer_id that does
    // not exist violates whatsapp_conversations' own FK to
    // public.customers, deterministically simulating a transient
    // downstream-mutation failure without touching the ledger's own
    // conflict-check tuple (business_id/number_id/hash).
    const [row] = await callIngestInbound({
      key, businessId: owner.businessId, numberId, providerMessageId, customerId: randomUuid(),
    });
    expect(row.ledger_status).toBe("FAILED_RETRYABLE");
    expect(row.message_id).toBeNull();

    const sql = createTestDbClient();
    try {
      const [ledger] = await sql<{ processing_status: string; processing_attempts: number }[]>`
        select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_status).toBe("FAILED_RETRYABLE");
      expect(ledger.processing_attempts).toBe(1);
      const messages = await sql`select count(*)::int as n from public.whatsapp_messages where provider_message_id = ${providerMessageId}`;
      expect(messages[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("2/3. exact replay retries and repairs a FAILED_RETRYABLE event; a further replay after PROCESSED never duplicates", async () => {
    const owner = await makeOwner("wa-rel-inbound-repair");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const key = `evt-${randomUuid()}`;
    const providerMessageId = `wamid-${randomUuid()}`;

    await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId, customerId: randomUuid() });

    // Exact replay: same key/hash/association, now with the bad
    // customer_id removed — the "transient" condition has cleared.
    const [repaired] = await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId });
    expect(repaired.ledger_status).toBe("PROCESSED");
    expect(repaired.message_id).not.toBeNull();

    const sql = createTestDbClient();
    try {
      const [ledger] = await sql<{ processing_status: string; processing_attempts: number }[]>`
        select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_status).toBe("PROCESSED");
      expect(ledger.processing_attempts).toBe(2);
    } finally {
      await sql.end();
    }

    // Further exact replay after PROCESSED — terminal, zero re-mutation.
    const [replay] = await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId });
    expect(replay.ledger_status).toBe("PROCESSED");
    expect(replay.message_id).toBe(repaired.message_id);

    const sql2 = createTestDbClient();
    try {
      const count = await sql2`select count(*)::int as n from public.whatsapp_messages where provider_message_id = ${providerMessageId}`;
      expect(count[0].n).toBe(1);
      const ledgerRows = await sql2`select processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}`;
      expect(ledgerRows[0].processing_attempts).toBe(2); // never incremented for a terminal replay
    } finally {
      await sql2.end();
    }
  });

  it("4. concurrent retries of a FAILED_RETRYABLE event produce exactly one message, never two", async () => {
    const owner = await makeOwner("wa-rel-inbound-concurrent");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const key = `evt-${randomUuid()}`;
    const providerMessageId = `wamid-${randomUuid()}`;

    await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId, customerId: randomUuid() });

    const [r1, r2] = await Promise.all([
      callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId }),
      callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId }),
    ]);
    const processedCount = [r1[0].ledger_status, r2[0].ledger_status].filter((s) => s === "PROCESSED").length;
    expect(processedCount).toBeGreaterThan(0);

    const sql = createTestDbClient();
    try {
      const count = await sql`select count(*)::int as n from public.whatsapp_messages where provider_message_id = ${providerMessageId}`;
      expect(count[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("9. a changed replay (same key, different business association) still conflicts", async () => {
    const a = await makeOwner("wa-rel-inbound-conflict-a");
    const b = await makeOwner("wa-rel-inbound-conflict-b");
    const { numberId: numberA } = await setupConnectedAccount(a.businessId, a.userId);
    const { numberId: numberB } = await setupConnectedAccount(b.businessId, b.userId);
    const key = `evt-${randomUuid()}`;

    await callIngestInbound({ key, businessId: a.businessId, numberId: numberA, providerMessageId: `wamid-${randomUuid()}` });
    await expect(
      callIngestInbound({ key, businessId: b.businessId, numberId: numberB, providerMessageId: `wamid-${randomUuid()}` })
    ).rejects.toThrow(/WHATSAPP_WEBHOOK_EVENT_CONFLICT/);
  });

  it("10. a FAILED_RETRYABLE attempt never produces a false whatsapp.inbound_received audit event; a successful repair produces exactly one", async () => {
    const owner = await makeOwner("wa-rel-inbound-audit");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const key = `evt-${randomUuid()}`;
    const providerMessageId = `wamid-${randomUuid()}`;

    await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId, customerId: randomUuid() });

    const sql = createTestDbClient();
    try {
      const before = await sql`
        select count(*)::int as n from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.inbound_received'
      `;
      expect(before[0].n).toBe(0);
    } finally {
      await sql.end();
    }

    await callIngestInbound({ key, businessId: owner.businessId, numberId, providerMessageId });

    const sql2 = createTestDbClient();
    try {
      const after = await sql2`
        select count(*)::int as n from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.inbound_received'
      `;
      expect(after[0].n).toBe(1);
    } finally {
      await sql2.end();
    }
  });
});

describe("WA-APP-01 — status event reliability", () => {
  async function createOutboundMessage(businessId: string, numberId: string) {
    const sql = createTestDbClient();
    try {
      const [conv] = await sql<{ id: string }[]>`
        insert into public.whatsapp_conversations (business_id, whatsapp_phone_number_id, customer_phone_e164, status)
        values (${businessId}, ${numberId}, '+2348012349999', 'OPEN') returning id
      `;
      const providerMessageId = `wamid-${randomUuid()}`;
      const [msg] = await sql<{ id: string }[]>`
        insert into public.whatsapp_messages (business_id, conversation_id, direction, message_type, provider_message_id, sender_kind, status)
        values (${businessId}, ${conv.id}, 'OUTBOUND', 'TEXT', ${providerMessageId}, 'SYSTEM', 'ACCEPTED')
        returning id
      `;
      return { messageId: msg.id, providerMessageId };
    } finally {
      await sql.end();
    }
  }

  async function callIngestStatus(args: { key: string; hash?: string; businessId: string; numberId: string; providerMessageId: string; status: string }) {
    const sql = createTestDbClient();
    try {
      return await sql<{ ledger_status: string; message_resolved: boolean }[]>`
        select * from public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${args.key},
          p_payload_sha256 => ${args.hash ?? HASH_A},
          p_business_id => ${args.businessId}::uuid,
          p_whatsapp_phone_number_id => ${args.numberId}::uuid,
          p_provider_message_id => ${args.providerMessageId},
          p_status => ${args.status}
        )
      `;
    } finally {
      await sql.end();
    }
  }

  it("5/6. a transient status-mutation failure is retryable and an exact replay repairs the projection", async () => {
    const owner = await makeOwner("wa-rel-status-repair");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, providerMessageId } = await createOutboundMessage(owner.businessId, numberId);
    const key = `evt-${randomUuid()}`;

    // An invalid status value forces private.record_whatsapp_message_status_event
    // to raise — a deterministic stand-in for any transient downstream failure.
    const [failed] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "BOGUS" });
    expect(failed.ledger_status).toBe("FAILED_RETRYABLE");

    const sql = createTestDbClient();
    try {
      const [msg] = await sql<{ status: string }[]>`select status from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.status).toBe("ACCEPTED"); // unchanged
    } finally {
      await sql.end();
    }

    const [repaired] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED" });
    expect(repaired.ledger_status).toBe("PROCESSED");
    expect(repaired.message_resolved).toBe(true);

    const sql2 = createTestDbClient();
    try {
      const [msg] = await sql2<{ status: string }[]>`select status from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.status).toBe("DELIVERED");
    } finally {
      await sql2.end();
    }
  });

  it("7. a further exact replay after PROCESSED never re-applies the status event", async () => {
    const owner = await makeOwner("wa-rel-status-noreapply");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, providerMessageId } = await createOutboundMessage(owner.businessId, numberId);
    const key = `evt-${randomUuid()}`;

    await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "READ" });
    const [replay] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "READ" });
    expect(replay.ledger_status).toBe("PROCESSED");

    const sql = createTestDbClient();
    try {
      const events = await sql`select count(*)::int as n from public.whatsapp_message_status_events where message_id = ${messageId}`;
      expect(events[0].n).toBe(1); // never re-applied on the terminal replay
    } finally {
      await sql.end();
    }
  });

  it("8. an unresolved (unknown provider message id) status event is classified IGNORED, never endlessly retried", async () => {
    const owner = await makeOwner("wa-rel-status-ignored");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const key = `evt-${randomUuid()}`;

    const [first] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId: `wamid-unknown-${randomUuid()}`, status: "DELIVERED" });
    expect(first.ledger_status).toBe("IGNORED");

    const sql = createTestDbClient();
    try {
      const [ledger] = await sql<{ processing_attempts: number }[]>`
        select processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_attempts).toBe(1);
    } finally {
      await sql.end();
    }

    // Exact replay of an IGNORED event is terminal — never re-attempted.
    const [replay] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId: `wamid-unknown-${randomUuid()}`, status: "DELIVERED" });
    expect(replay.ledger_status).toBe("IGNORED");
    const sql2 = createTestDbClient();
    try {
      const [ledger] = await sql2<{ processing_attempts: number }[]>`
        select processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_attempts).toBe(1);
    } finally {
      await sql2.end();
    }
  });
});

describe("WA-APP-02 — outbound provider-bind reconciliation", () => {
  async function beginPendingMessage(owner: Awaited<ReturnType<typeof makeOwner>>, numberId: string) {
    const customerId = await createCustomer(owner.client, owner.businessId, "Bind Repair Customer");
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
    const { data } = await owner.client.rpc("begin_whatsapp_outbound_message", {
      p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT",
      p_body_text: "hi", p_client_creation_key: randomUuid(),
    });
    return data![0].message_id as string;
  }

  /**
   * Forces repair_whatsapp_provider_bind's own internal bind UPDATE to
   * fail for exactly one message id via a temporary, test-only BEFORE
   * UPDATE trigger — deterministic and database-safe, created and
   * dropped entirely inside this test, never added to any migration.
   * `errcode` selects the SQLSTATE — see
   * supabase/migrations/20260908080400_whatsapp_bind_failure_classification.sql,
   * which classifies repair_whatsapp_provider_bind's own internal
   * exception handler by SQLSTATE: `serialization_failure` /
   * `deadlock_detected` / `lock_not_available` (40001 / 40P01 / 55P03)
   * fold into `resolved = false`; anything else is re-raised. Used here
   * with 55P03 (lock_not_available) — a genuinely transient condition —
   * to keep this test's original "bind attempt failed transiently"
   * assertion (`resolved = false`, repair stays PENDING) accurate under
   * the WA-APP-03-RC classification. (Prior to WA-APP-03-RC this test
   * forced the same outcome with a foreign-key violation from a
   * nonexistent actor_user_id — exactly the kind of PERMANENT error
   * WA-APP-03-RC stops folding into `resolved = false`; that mechanism
   * now correctly re-raises instead, see
   * tests/integration/whatsapp-status-retry-reconciliation.test.ts's
   * own "permanent internal bind failure" coverage for that case.)
   */
  async function forceTransientBindFailure(messageId: string) {
    const suffix = messageId.replace(/-/g, "_");
    const fnName = `wa_rel_force_bind_failure_${suffix}`;
    const triggerName = `wa_rel_force_bind_failure_trigger_${suffix}`;
    const sql = createTestDbClient();
    try {
      await sql.unsafe(`
        create or replace function public.${fnName}() returns trigger
        language plpgsql as $f$
        begin
          raise exception 'WA_REL_TEST_FORCED_TRANSIENT_FAILURE' using errcode = '55P03';
        end;
        $f$
      `);
      await sql.unsafe(`
        create trigger ${triggerName}
        before update on public.whatsapp_messages
        for each row
        when (old.id = '${messageId}'::uuid and old.provider_message_id is null and new.provider_message_id is not null)
        execute function public.${fnName}()
      `);
    } finally {
      await sql.end();
    }
    return async () => {
      const cleanup = createTestDbClient();
      try {
        await cleanup.unsafe(`drop trigger if exists ${triggerName} on public.whatsapp_messages`);
        await cleanup.unsafe(`drop function if exists public.${fnName}()`);
      } finally {
        await cleanup.end();
      }
    };
  }

  it("11. a failed bind attempt persists a durable PENDING repair obligation without binding the message", async () => {
    const owner = await makeOwner("wa-rel-bind-fail");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const messageId = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const dropTrigger = await forceTransientBindFailure(messageId);
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ resolved: boolean; bound_provider_message_id: string }[]>`
        select * from public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)
      `;
      expect(row.resolved).toBe(false);

      const [msg] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.provider_message_id).toBeNull();

      const [repair] = await sql<{ status: string; provider_message_id: string; attempts: number }[]>`
        select status, provider_message_id, attempts from private.whatsapp_provider_bind_repairs where whatsapp_message_id = ${messageId}
      `;
      expect(repair.status).toBe("PENDING");
      expect(repair.provider_message_id).toBe(providerMessageId);
      expect(repair.attempts).toBe(1);
    } finally {
      await sql.end();
      await dropTrigger();
    }
  });

  it("11b. WA-APP-03-RC: a permanent/unexpected internal error during the bind attempt is classified retryable=false, never folded into a retryable outcome", async () => {
    const owner = await makeOwner("wa-rel-bind-fail-permanent");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const messageId = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    // A nonexistent actor_user_id forces the internal audit insert to
    // fail its FK to auth.users — a genuine, non-transient, non-conflict
    // internal error (SQLSTATE 23503, foreign_key_violation — not one
    // of the three explicitly retryable SQLSTATEs, and not 23514). This
    // must still return an ordinary row (never throw — see
    // supabase/migrations/20260908080400_whatsapp_bind_failure_classification.sql's
    // own header comment on why re-raising past this function's own
    // boundary would destroy its own durable repair-obligation record),
    // but with `retryable = false`, distinguishing it from a genuinely
    // transient failure.
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ resolved: boolean; bound_provider_message_id: string; retryable: boolean | null }[]>`
        select * from public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${randomUuid()}::uuid)
      `;
      expect(row.resolved).toBe(false);
      expect(row.retryable).toBe(false);

      const [msg] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.provider_message_id).toBeNull();

      // The durable repair obligation is still recorded (inserted
      // BEFORE the exception-catching block), with the failure noted
      // for diagnostics, but never marked RESOLVED.
      const [repair] = await sql<{ status: string; provider_message_id: string; attempts: number; last_error_code: string | null }[]>`
        select status, provider_message_id, attempts, last_error_code from private.whatsapp_provider_bind_repairs where whatsapp_message_id = ${messageId}
      `;
      expect(repair.status).toBe("PENDING");
      expect(repair.provider_message_id).toBe(providerMessageId);
      expect(repair.attempts).toBe(1);
      expect(repair.last_error_code).toContain("23503");
    } finally {
      await sql.end();
    }
  });

  it("13/14. a repair retry with the SAME provider id resolves it, and is idempotent on further exact replay", async () => {
    const owner = await makeOwner("wa-rel-bind-repair");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const messageId = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${randomUuid()}::uuid)`;

      const [row] = await sql<{ resolved: boolean; bound_provider_message_id: string }[]>`
        select * from public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)
      `;
      expect(row.resolved).toBe(true);
      expect(row.bound_provider_message_id).toBe(providerMessageId);

      const [msg] = await sql<{ provider_message_id: string | null; status: string }[]>`select provider_message_id, status from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.provider_message_id).toBe(providerMessageId);
      expect(msg.status).toBe("ACCEPTED");

      const auditBefore = await sql`select count(*)::int as n from public.audit_events where business_id = ${owner.businessId} and action = 'whatsapp.message_sent'`;
      expect(auditBefore[0].n).toBe(1);

      // Idempotent replay with the SAME provider id.
      const [replay] = await sql<{ resolved: boolean }[]>`
        select * from public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)
      `;
      expect(replay.resolved).toBe(true);

      const auditAfter = await sql`select count(*)::int as n from public.audit_events where business_id = ${owner.businessId} and action = 'whatsapp.message_sent'`;
      expect(auditAfter[0].n).toBe(1); // never re-audited
    } finally {
      await sql.end();
    }
  });

  it("15. a conflicting different provider id for the same message is rejected, never silently overwritten", async () => {
    const owner = await makeOwner("wa-rel-bind-conflict");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const messageId = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)`;

      await expect(
        sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${`wamid-different-${randomUuid()}`}, ${owner.userId}::uuid)`
      ).rejects.toThrow(/WHATSAPP_PROVIDER_BIND_CONFLICT/);

      const [msg] = await sql<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.provider_message_id).toBe(providerMessageId); // unchanged
    } finally {
      await sql.end();
    }
  });

  it("16. a repaired message can then consume a provider status webhook correctly", async () => {
    const owner = await makeOwner("wa-rel-bind-then-status");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const messageId = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${owner.businessId}::uuid, ${providerMessageId}, ${owner.userId}::uuid)`;

      await sql`
        select public.ingest_and_process_whatsapp_status_event(
          p_provider_event_key => ${`evt-${randomUuid()}`}, p_payload_sha256 => ${HASH_B},
          p_business_id => ${owner.businessId}::uuid, p_whatsapp_phone_number_id => ${numberId}::uuid,
          p_provider_message_id => ${providerMessageId}, p_status => 'DELIVERED'
        )
      `;
      const [msg] = await sql<{ status: string }[]>`select status from public.whatsapp_messages where id = ${messageId}`;
      expect(msg.status).toBe("DELIVERED");
    } finally {
      await sql.end();
    }
  });

  it("17. a binding repair attempt is tenant-safe (mismatched business_id/message_id pair is rejected)", async () => {
    const a = await makeOwner("wa-rel-bind-tenant-a");
    const b = await makeOwner("wa-rel-bind-tenant-b");
    const { numberId: numberA } = await setupConnectedAccount(a.businessId, a.userId);
    const messageId = await beginPendingMessage(a, numberA);

    const sql = createTestDbClient();
    try {
      await expect(
        sql`select public.repair_whatsapp_provider_bind(${messageId}::uuid, ${b.businessId}::uuid, ${`wamid-${randomUuid()}`}, ${b.userId}::uuid)`
      ).rejects.toThrow();

      const leaked = await sql`select count(*)::int as n from private.whatsapp_provider_bind_repairs where whatsapp_message_id = ${messageId} and business_id = ${b.businessId}`;
      expect(leaked[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it("18. authenticated/anon cannot execute repair_whatsapp_provider_bind or read the repair table directly", async () => {
    const sql = createTestDbClient();
    try {
      for (const role of ["anon", "authenticated"]) {
        const rows = await sql<{ has: boolean }[]>`
          select has_function_privilege(${role}, 'public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)', 'EXECUTE') as has
        `;
        expect(rows[0].has, role).toBe(false);
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const tableRows = await sql<{ has: boolean }[]>`
            select has_table_privilege(${role}, 'private.whatsapp_provider_bind_repairs', ${priv}) as has
          `;
          expect(tableRows[0].has, `${role}/${priv}`).toBe(false);
        }
      }
      const svc = await sql<{ has: boolean }[]>`
        select has_function_privilege('service_role', 'public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)', 'EXECUTE') as has
      `;
      expect(svc[0].has).toBe(true);
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const svcTable = await sql<{ has: boolean }[]>`
          select has_table_privilege('service_role', 'private.whatsapp_provider_bind_repairs', ${priv}) as has
        `;
        expect(svcTable[0].has, priv).toBe(false); // zero direct table access even for service_role — function-only
      }
    } finally {
      await sql.end();
    }
  });

  it("19. the repair record stores only bounded, non-sensitive fields — no token/body/full raw error", async () => {
    const sql = createTestDbClient();
    try {
      const rows = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'private' and table_name = 'whatsapp_provider_bind_repairs'
      `;
      const names = rows.map((r) => r.column_name.toLowerCase());
      expect(names.sort()).toEqual(
        ["id", "business_id", "whatsapp_message_id", "provider_message_id", "status", "attempts", "last_error_code", "last_attempted_at", "resolved_at", "created_at"].sort()
      );
      for (const forbidden of ["access_token", "app_secret", "body", "phone", "raw_payload", "raw_error"]) {
        expect(names, forbidden).not.toContain(forbidden);
      }
    } finally {
      await sql.end();
    }
  });
});

describe("WA-APP-01/02 — ACL catalog for the new reliability functions", () => {
  it("every new orchestrator/repair function is service_role-only — no PUBLIC/anon/authenticated EXECUTE", async () => {
    const sql = createTestDbClient();
    const signatures = [
      "public.ingest_and_process_whatsapp_inbound_message(text, text, uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)",
      "public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text, text)",
      "public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)",
      "public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)",
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

  it("processing_status now accepts FAILED_RETRYABLE and rejects an arbitrary value", async () => {
    const sql = createTestDbClient();
    try {
      const owner = await makeOwner("wa-rel-acl-status-enum");
      const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
      await callIngestInbound({ key: `evt-${randomUuid()}`, businessId: owner.businessId, numberId, providerMessageId: `wamid-${randomUuid()}` });
      await expect(
        sql`update private.whatsapp_webhook_events set processing_status = 'NOT_A_REAL_STATUS' where business_id = ${owner.businessId}`
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});
