import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { createTestDbClient } from "./helpers/db-client";

// WA-APP-03 remediation — real-Postgres proof that a TRANSIENT internal
// failure inside the callback-assisted repair path
// (repair_whatsapp_provider_bind returning resolved=false) is never
// classified as terminal IGNORED, and instead becomes FAILED_RETRYABLE
// so an exact Meta replay can repair it — exactly once, with zero
// duplicate side effects. See
// supabase/migrations/20260908080300_whatsapp_status_reconciliation_retry_fix.sql
// for the full design rationale, and
// tests/integration/whatsapp-provider-correlation.test.ts for the
// non-failing callback-assisted-recovery baseline this test builds on.

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

async function beginPendingMessage(owner: Awaited<ReturnType<typeof makeOwner>>, numberId: string) {
  const customerId = await createCustomer(owner.client, owner.businessId, "Retry Reconciliation Customer");
  await owner.client.rpc("record_customer_whatsapp_consent", {
    p_business_id: owner.businessId, p_customer_id: customerId,
    p_set_service: true, p_service_allowed: true, p_service_consent_source: "STAFF_RECORDED",
  });
  const sql = createTestDbClient();
  let convId: string;
  try {
    const [conv] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status, customer_service_window_ends_at)
      values (${owner.businessId}, ${customerId}, ${numberId}, '+2348012340099', 'OPEN', now() + interval '12 hours')
      returning id
    `;
    convId = conv.id;
  } finally {
    await sql.end();
  }
  const { data, error } = await owner.client.rpc("begin_whatsapp_outbound_message", {
    p_business_id: owner.businessId, p_conversation_id: convId, p_message_type: "TEXT",
    p_body_text: "hi", p_client_creation_key: randomUuid(),
  });
  if (error || !data?.[0]) throw new Error(`begin_whatsapp_outbound_message failed: ${error?.message}`);
  return { messageId: data[0].message_id as string, opaqueCallbackToken: data[0].opaque_callback_token as string };
}

const HASH_A = "a".repeat(64);

/**
 * Forces repair_whatsapp_provider_bind's own internal bind UPDATE to
 * fail for exactly one message id — a temporary, test-only BEFORE
 * UPDATE trigger, scoped by a WHEN clause to that one row's own
 * PENDING -> bound transition, deterministic and database-safe. The
 * function/trigger names are unique per call (suffixed with the target
 * message id AND a caller-supplied tag, so a transient-failure and a
 * permanent-failure trigger for the SAME message id never collide) so
 * concurrent test runs never collide either, and both are dropped again
 * before this helper's cleanup callback returns. Never added to any
 * migration — created and dropped entirely inside this test, over a
 * real (non-temp-schema) connection so the trigger fires correctly
 * regardless of which later connection performs the UPDATE.
 *
 * `errcode` selects which SQLSTATE the forced failure carries — see
 * supabase/migrations/20260908080400_whatsapp_bind_failure_classification.sql,
 * which now classifies repair_whatsapp_provider_bind's own internal
 * exception handler by SQLSTATE: `serialization_failure` /
 * `deadlock_detected` / `lock_not_available` (40001 / 40P01 / 55P03)
 * fold into `resolved = false` (transient, retryable); anything else is
 * re-raised (permanent, never retryable).
 */
async function forceBindFailure(messageId: string, tag: string, errcode: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
    throw new Error("forceBindFailure: messageId is not a well-formed UUID");
  }
  const suffix = `${messageId.replace(/-/g, "_")}_${tag}`;
  const fnName = `wa_app_03_force_bind_failure_${suffix}`;
  const triggerName = `wa_app_03_force_bind_failure_trigger_${suffix}`;

  const sql = createTestDbClient();
  try {
    await sql.unsafe(`
      create or replace function public.${fnName}() returns trigger
      language plpgsql as $f$
      begin
        raise exception 'WA_APP_03_TEST_FORCED_BIND_FAILURE' using errcode = '${errcode}';
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

/** Genuinely transient (SQLSTATE 55P03, lock_not_available) — must become FAILED_RETRYABLE. */
async function forceTransientBindFailure(messageId: string) {
  return forceBindFailure(messageId, "transient", "55P03");
}

/**
 * A deterministic, non-transient, non-conflict failure (SQLSTATE
 * 22023, invalid_parameter_value — never one of the three explicitly
 * retryable SQLSTATEs, and never 23514, which is reserved for the
 * genuine WAMID-conflict case) — a stand-in for an unexpected/internal/
 * integrity error INSIDE the bind mutation itself. Must become a
 * terminal FAILED ledger row, never FAILED_RETRYABLE.
 */
async function forcePermanentBindFailure(messageId: string) {
  return forceBindFailure(messageId, "permanent", "22023");
}

async function callIngestStatus(args: { key: string; businessId: string; numberId: string; providerMessageId: string; status: string; opaqueCallbackToken: string }) {
  const sql = createTestDbClient();
  try {
    return await sql<{ ledger_status: string; message_resolved: boolean }[]>`
      select * from public.ingest_and_process_whatsapp_status_event(
        p_provider_event_key => ${args.key}, p_payload_sha256 => ${HASH_A},
        p_business_id => ${args.businessId}::uuid, p_whatsapp_phone_number_id => ${args.numberId}::uuid,
        p_provider_message_id => ${args.providerMessageId}, p_status => ${args.status},
        p_provider_timestamp => null, p_failure_reason => null,
        p_opaque_callback_token => ${args.opaqueCallbackToken}
      )
    `;
  } finally {
    await sql.end();
  }
}

describe("WA-APP-03 — callback-assisted transient bind failure is retryable, never terminal", () => {
  it("1/2. a transient internal bind failure marks the ledger FAILED_RETRYABLE, never IGNORED, and mutates nothing", async () => {
    const owner = await makeOwner("wa-retry-transient");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;
    const key = `evt-${randomUuid()}`;

    const dropTrigger = await forceTransientBindFailure(messageId);
    try {
      const [first] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
      expect(first.ledger_status).toBe("FAILED_RETRYABLE");
      expect(first.message_resolved).toBe(false);

      const sql = createTestDbClient();
      try {
        const [msg] = await sql<{ provider_message_id: string | null; status: string }[]>`
          select provider_message_id, status from public.whatsapp_messages where id = ${messageId}
        `;
        expect(msg.provider_message_id).toBeNull();
        expect(msg.status).toBe("PENDING");

        const [correlation] = await sql<{ state: string; provider_message_id: string | null }[]>`
          select state, provider_message_id from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}
        `;
        expect(correlation.state).toBe("PENDING_PROVIDER");
        expect(correlation.provider_message_id).toBeNull();

        const auditCount = await sql`
          select count(*)::int as n from public.audit_events
          where business_id = ${owner.businessId} and action = 'whatsapp.message_sent' and resource_id = ${messageId}
        `;
        expect(auditCount[0].n).toBe(0);

        const [ledger] = await sql<{ processing_status: string; processing_attempts: number }[]>`
          select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
        `;
        expect(ledger.processing_status).toBe("FAILED_RETRYABLE");
        expect(ledger.processing_attempts).toBe(1);
      } finally {
        await sql.end();
      }
    } finally {
      await dropTrigger();
    }

    // 3. Release the forced failure, replay the EXACT SAME event —
    // binds WAMID exactly once, applies status exactly once, audits
    // exactly once, marks PROCESSED.
    const [replay] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
    expect(replay.ledger_status).toBe("PROCESSED");
    expect(replay.message_resolved).toBe(true);

    const sql2 = createTestDbClient();
    try {
      const [msg] = await sql2<{ provider_message_id: string | null; status: string }[]>`
        select provider_message_id, status from public.whatsapp_messages where id = ${messageId}
      `;
      expect(msg.provider_message_id).toBe(providerMessageId);
      expect(msg.status).toBe("DELIVERED");

      const [correlation] = await sql2<{ state: string; provider_message_id: string | null }[]>`
        select state, provider_message_id from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}
      `;
      expect(correlation.state).toBe("RESOLVED");
      expect(correlation.provider_message_id).toBe(providerMessageId);

      const auditCount = await sql2`
        select count(*)::int as n from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.message_sent' and resource_id = ${messageId}
      `;
      expect(auditCount[0].n).toBe(1);

      const [ledger] = await sql2<{ processing_status: string; processing_attempts: number }[]>`
        select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_status).toBe("PROCESSED");
      expect(ledger.processing_attempts).toBe(2);
    } finally {
      await sql2.end();
    }

    // 4. A THIRD exact replay never duplicates anything and remains
    // PROCESSED.
    const [third] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
    expect(third.ledger_status).toBe("PROCESSED");

    const sql3 = createTestDbClient();
    try {
      const auditCount = await sql3`
        select count(*)::int as n from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.message_sent' and resource_id = ${messageId}
      `;
      expect(auditCount[0].n).toBe(1); // still exactly one

      const [ledger] = await sql3<{ processing_attempts: number }[]>`
        select processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_attempts).toBe(2); // never incremented for a terminal replay
    } finally {
      await sql3.end();
    }
  });

  it("5. a genuinely permanent conflict (wamid already bound to a different message) stays IGNORED, never endlessly retryable", async () => {
    const owner = await makeOwner("wa-retry-permanent-conflict");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const msgA = await beginPendingMessage(owner, numberId);
    const msgB = await beginPendingMessage(owner, numberId);
    const wamidForB = `wamid-${randomUuid()}`;

    const sql = createTestDbClient();
    try {
      await sql`select public.repair_whatsapp_provider_bind(${msgB.messageId}::uuid, ${owner.businessId}::uuid, ${wamidForB}, ${owner.userId}::uuid)`;
    } finally {
      await sql.end();
    }

    const [result] = await callIngestStatus({
      key: `evt-${randomUuid()}`, businessId: owner.businessId, numberId,
      providerMessageId: wamidForB, status: "DELIVERED", opaqueCallbackToken: msgA.opaqueCallbackToken,
    });
    expect(result.ledger_status).toBe("IGNORED");
    expect(result.message_resolved).toBe(false);

    const sql2 = createTestDbClient();
    try {
      const [a] = await sql2<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${msgA.messageId}`;
      expect(a.provider_message_id).toBeNull();
      const [b] = await sql2<{ provider_message_id: string | null }[]>`select provider_message_id from public.whatsapp_messages where id = ${msgB.messageId}`;
      expect(b.provider_message_id).toBe(wamidForB); // unchanged, never overwritten
    } finally {
      await sql2.end();
    }
  });

  it("6. an unresolvable status event (no correlation, no direct match) stays IGNORED, never converted to FAILED_RETRYABLE", async () => {
    const owner = await makeOwner("wa-retry-no-correlation");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);

    const [result] = await callIngestStatus({
      key: `evt-${randomUuid()}`, businessId: owner.businessId, numberId,
      providerMessageId: `wamid-unknown-${randomUuid()}`, status: "DELIVERED", opaqueCallbackToken: "f".repeat(32),
    });
    expect(result.ledger_status).toBe("IGNORED");
    expect(result.message_resolved).toBe(false);
  });
});

// WA-APP-03-RC remediation — real-Postgres proof that a PERMANENT,
// unexpected/internal failure inside the callback-assisted bind path
// (an error repair_whatsapp_provider_bind does not itself recognize as
// one of the three explicitly transient SQLSTATEs) is classified a
// terminal FAILED ledger row, never FAILED_RETRYABLE — distinct from
// both the existing transient-failure case above (5/2) and the existing
// known-WAMID-conflict case (test 5). See
// supabase/migrations/20260908080400_whatsapp_bind_failure_classification.sql.
//
// WA-APP-03-RC-TERM remediation — real-Postgres proof that FAILED is
// itself terminal on EXACT REPLAY, exactly like PROCESSED/IGNORED: a
// second (and third) exact replay of the same event must never
// increment processing_attempts, never call repair_whatsapp_provider_bind
// again, never mutate the message/status/correlation rows again, and
// never emit an audit event. See
// supabase/migrations/20260908080500_whatsapp_failed_terminal_replay_fix.sql.
describe("WA-APP-03-RC — a permanent internal bind failure is terminal, never an infinite provider retry", () => {
  it("a non-transient, non-conflict SQLSTATE inside the bind mutation becomes a terminal FAILED ledger row, not FAILED_RETRYABLE, with zero partial mutation, and stays terminal across exact replays", async () => {
    const owner = await makeOwner("wa-retry-permanent-internal");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    const { messageId, opaqueCallbackToken } = await beginPendingMessage(owner, numberId);
    const providerMessageId = `wamid-${randomUuid()}`;
    const key = `evt-${randomUuid()}`;

    const dropTrigger = await forcePermanentBindFailure(messageId);
    try {
      const [first] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
      // NOT FAILED_RETRYABLE — this is the core WA-APP-03-RC assertion.
      expect(first.ledger_status).toBe("FAILED");
      expect(first.message_resolved).toBe(false);

      const sql = createTestDbClient();
      try {
        // No partial WAMID bind on the message itself, no partial
        // status projection.
        const [msg] = await sql<{ provider_message_id: string | null; status: string }[]>`
          select provider_message_id, status from public.whatsapp_messages where id = ${messageId}
        `;
        expect(msg.provider_message_id).toBeNull();
        expect(msg.status).toBe("PENDING");

        // Unlike the transient-failure case above (where the caller's
        // own RAISE+catch rolls back everything repair_whatsapp_provider_bind
        // did, including its own correlation write), the permanent-
        // failure path here never raises, so
        // repair_whatsapp_provider_bind's own durable "obligation
        // first" writes remain committed — including the correlation
        // row, which durably remembers the attempted provider_message_id
        // and moves to PROVIDER_ACCEPTED_UNBOUND. This is intentional:
        // WA-APP-02-R1's own durable-recovery guarantee (never lose a
        // provider-accepted wamid) still holds even when the first bind
        // attempt fails for an unrelated internal reason — a later
        // repair_whatsapp_provider_bind retry with the SAME
        // provider_message_id (once the underlying condition is fixed)
        // will still find and complete this exact bind.
        const [correlation] = await sql<{ state: string; provider_message_id: string | null }[]>`
          select state, provider_message_id from private.whatsapp_outbound_provider_correlations where whatsapp_message_id = ${messageId}
        `;
        expect(correlation.state).toBe("PROVIDER_ACCEPTED_UNBOUND");
        expect(correlation.provider_message_id).toBe(providerMessageId);

        // The durable repair-obligation row also survives, PENDING,
        // with the failure recorded for diagnostics.
        const [repair] = await sql<{ status: string; provider_message_id: string; last_error_code: string | null }[]>`
          select status, provider_message_id, last_error_code from private.whatsapp_provider_bind_repairs where whatsapp_message_id = ${messageId}
        `;
        expect(repair.status).toBe("PENDING");
        expect(repair.provider_message_id).toBe(providerMessageId);
        expect(repair.last_error_code).toContain("22023");

        // No false audit event, and no partial status projection.
        const auditCount = await sql`
          select count(*)::int as n from public.audit_events
          where business_id = ${owner.businessId} and action = 'whatsapp.message_sent' and resource_id = ${messageId}
        `;
        expect(auditCount[0].n).toBe(0);

        const [ledger] = await sql<{ processing_status: string; processing_attempts: number }[]>`
          select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
        `;
        expect(ledger.processing_status).toBe("FAILED");
        expect(ledger.processing_attempts).toBe(1);
      } finally {
        await sql.end();
      }
    } finally {
      // WA-APP-03-RC-TERM: release the forced failure BEFORE replaying —
      // if an exact replay of a FAILED event were still re-entering the
      // mutation path (the bug this remediation fixes), the bind would
      // now SUCCEED and the assertions below would catch it. Proving
      // terminality this way is strictly stronger than replaying with
      // the trigger still attached.
      await dropTrigger();
    }

    // WA-APP-03-RC-TERM: an exact replay of an already-FAILED event must
    // return the SAME terminal result directly — no second bind attempt,
    // no processing_attempts growth, no status/correlation mutation, no
    // audit event.
    const [replay] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
    expect(replay.ledger_status).toBe("FAILED");
    expect(replay.message_resolved).toBe(false);

    const sqlReplay = createTestDbClient();
    try {
      const [ledger] = await sqlReplay<{ processing_status: string; processing_attempts: number }[]>`
        select processing_status, processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_status).toBe("FAILED");
      expect(ledger.processing_attempts).toBe(1); // unchanged — the replay never re-entered the mutation path

      // The bind trigger was removed before this replay, so a second
      // bind attempt would have SUCCEEDED had the replay re-entered the
      // mutation path — it did not, so the message remains unbound.
      const [msg] = await sqlReplay<{ provider_message_id: string | null; status: string }[]>`
        select provider_message_id, status from public.whatsapp_messages where id = ${messageId}
      `;
      expect(msg.provider_message_id).toBeNull();
      expect(msg.status).toBe("PENDING");

      const [repair] = await sqlReplay<{ status: string; attempts: number }[]>`
        select status, attempts from private.whatsapp_provider_bind_repairs where whatsapp_message_id = ${messageId}
      `;
      expect(repair.status).toBe("PENDING");
      expect(repair.attempts).toBe(1); // never incremented — repair_whatsapp_provider_bind was never called again

      const auditCount = await sqlReplay`
        select count(*)::int as n from public.audit_events
        where business_id = ${owner.businessId} and action = 'whatsapp.message_sent' and resource_id = ${messageId}
      `;
      expect(auditCount[0].n).toBe(0);
    } finally {
      await sqlReplay.end();
    }

    // A third exact replay remains terminal too.
    const [third] = await callIngestStatus({ key, businessId: owner.businessId, numberId, providerMessageId, status: "DELIVERED", opaqueCallbackToken });
    expect(third.ledger_status).toBe("FAILED");
    expect(third.message_resolved).toBe(false);

    const sqlThird = createTestDbClient();
    try {
      const [ledger] = await sqlThird<{ processing_attempts: number }[]>`
        select processing_attempts from private.whatsapp_webhook_events where provider_event_key = ${key}
      `;
      expect(ledger.processing_attempts).toBe(1);
    } finally {
      await sqlThird.end();
    }
  });
});
