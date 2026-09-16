-- Phase 1M: WhatsApp + Customer Communication — WA-APP-03-RC REMEDIATION.
-- Additive on top of 20260908080300_whatsapp_status_reconciliation_retry_fix.sql
-- (itself additive on 20260908080200, itself additive on 20260908080100,
-- itself additive on 20260908080000, itself additive on the frozen
-- Phase 1M DB foundation, d3a2d3a — still untouched). No frozen Phase
-- 1A–1M migration is edited here, and none of the four prior
-- application-layer migration FILES is edited either — every change
-- below is either a drop+create (repair_whatsapp_provider_bind's return
-- shape widens by one column, so CREATE OR REPLACE cannot be used — the
-- same rule 20260908080200's own header comment already documents for
-- begin_whatsapp_outbound_message) or a `create or replace` (
-- ingest_and_process_whatsapp_status_event, whose signature and return
-- shape are unchanged) of functions those prior files defined — the
-- same "additive correction" pattern each of those prior files already
-- used against the one before it.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-03-RC — EXCEPTION WHEN OTHERS TURNED ANY INTERNAL FAILURE INTO
-- A RETRYABLE ONE
-- ═══════════════════════════════════════════════════════════════════
-- public.repair_whatsapp_provider_bind's own internal bind attempt
-- (20260908080000, unchanged in shape through 20260908080200) was
-- wrapped in a bare `exception when others` that folded EVERY failure —
-- a genuinely transient lock/serialization condition, but ALSO a
-- foreign-key violation, a check-constraint violation, or any other
-- unexpected internal/integrity/configuration error — into the SAME
-- `resolved = false` outcome. WA-APP-03 (20260908080300) correctly
-- taught the caller, ingest_and_process_whatsapp_status_event, to turn
-- `resolved = false` into FAILED_RETRYABLE so Meta's own retry could
-- repair a genuine transient failure. Combined, the two migrations
-- meant a PERMANENT/unexpected internal failure — which no amount of
-- identical replay can ever fix — was ALSO classified FAILED_RETRYABLE,
-- and would loop Meta's retries forever against an HTTP 5xx that can
-- never turn into a 2xx.
--
-- FIX — the "preferred approach" from this remediation's own
-- instructions: replace the boolean-only semantics with a classified
-- outcome. Rather than a full enum (which would touch every existing
-- caller's column list), the return table gains ONE new nullable
-- column, `retryable boolean`, meaningful only when `resolved = false`:
--
--   resolved = true                        -> bound (retryable: null, unused)
--   resolved = false, retryable = true      -> RETRYABLE_FAILURE (a
--                                              genuinely transient
--                                              PostgreSQL condition)
--   resolved = false, retryable = false     -> PERMANENT_FAILURE (an
--                                              unexpected/internal/
--                                              integrity/configuration
--                                              error)
--   (an exception with sqlstate 23514, raised BEFORE this function's
--   own internal exception block is ever entered, is the pre-existing,
--   untouched PERMANENT_CONFLICT signal — never folded into this
--   return table at all, exactly as before this migration.)
--
-- This function's OWN internal `exception when others` block still
-- catches every failure inside its bind attempt, exactly as before —
-- it is only SPLIT into two arms by SQLSTATE, never widened to
-- re-raise past this function's own boundary. This is a deliberate
-- correction from an earlier draft of this remediation that instead
-- re-raised unrecognized errors: PL/pgSQL's EXCEPTION clause rolls the
-- enclosing block back to an implicit SAVEPOINT the instant it is
-- entered, and re-raising past this function's own caller (which itself
-- may be sitting inside a caller's own EXCEPTION-catching block, as
-- ingest_and_process_whatsapp_status_event's callback-assisted branch
-- is) rolls back to THAT enclosing savepoint instead — undoing this
-- function's own "durable obligation first" INSERT into
-- whatsapp_provider_bind_repairs from before its internal block was
-- ever entered (real-Postgres-proven: rethrowing here caused exactly
-- that record to vanish under test). Classifying the outcome and
-- RETURNING it, instead of raising past this function's own boundary,
-- keeps every durable write this function itself makes — including for
-- a permanent/unexpected failure — intact, exactly as WA-APP-02
-- (20260908080100) originally guaranteed.
--
-- ingest_and_process_whatsapp_status_event's callback-assisted branch
-- reads the new `retryable` column directly (no exception/RAISE
-- round-trip needed for this case at all):
--   resolved = true         -> proceed to bind/status application (unchanged)
--   retryable = true        -> RAISE (unchanged from 20260908080300) so
--                              this function's own outer
--                              `exception when others` marks the ledger
--                              FAILED_RETRYABLE
--   retryable = false       -> a terminal, safe FAILED ledger row is
--                              set DIRECTLY here — never FAILED_RETRYABLE,
--                              and never routed through this function's
--                              own outer handler (which would need an
--                              exception to trigger, and this case
--                              intentionally never raises one, for the
--                              same savepoint-rollback reason described
--                              above).
--   sqlstate 23514 (unchanged) -> IGNORED, permanent conflict
--
-- Every other line of both functions' bodies — the durable-obligation-
-- first bind-repair upsert, the correlation upsert, the conflict/
-- idempotency checks, the actual message bind, the audit event, the
-- ledger insert/replay/terminal-state handling, the direct
-- provider_message_id lookup, the callback-token consistency check,
-- the cross-tenant/business_id check, and the outer
-- `exception when others` -> FAILED_RETRYABLE handler itself (still
-- reachable for every OTHER unexpected failure in
-- ingest_and_process_whatsapp_status_event's body, e.g. inside
-- record_whatsapp_provider_message_status) — is unchanged.
-- ===========================================================================

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on
-- the function's own schema (public) — granted narrowly here and
-- revoked again at the end of this file, exactly like every prior
-- application-layer migration's own identical precedent.
grant create on schema public to private_whatsapp_provider_writer;

-- ===========================================================================
-- repair_whatsapp_provider_bind — return shape widens by one column
-- (`retryable`), so CREATE OR REPLACE cannot be used (PostgreSQL does
-- not allow it to change a function's return type) — drop + create,
-- exactly like 20260908080200's own begin_whatsapp_outbound_message
-- precedent. Every other line of the body is unchanged from
-- 20260908080200 except the final exception handler, split by SQLSTATE.
-- See this file's own header comment above for the full rationale.
-- ===========================================================================
drop function if exists public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid);

create function public.repair_whatsapp_provider_bind(
  p_message_id            uuid,
  p_business_id           uuid,
  p_provider_message_id   text,
  p_actor_user_id         uuid default null
)
returns table (resolved boolean, bound_provider_message_id text, retryable boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_repair_id             uuid;
  v_repair_provider_id    text;
  v_current_provider_id   text;
  v_err                   text;
  v_correlation_provider_id text;
begin
  if p_message_id is null or p_business_id is null or p_provider_message_id is null then
    raise exception 'p_message_id, p_business_id, and p_provider_message_id are required' using errcode = '22023';
  end if;

  -- Durable obligation FIRST, outside any exception-catching block —
  -- this INSERT/UPDATE is never rolled back by a later bind failure.
  -- The composite FK on (whatsapp_message_id, business_id) makes a
  -- cross-tenant call fail right here, structurally (WA-APP-02 tenant
  -- safety), before any other logic runs.
  insert into private.whatsapp_provider_bind_repairs (
    business_id, whatsapp_message_id, provider_message_id, attempts, last_attempted_at
  ) values (
    p_business_id, p_message_id, p_provider_message_id, 1, now()
  )
  on conflict (whatsapp_message_id) do update
  set attempts = private.whatsapp_provider_bind_repairs.attempts + 1,
      last_attempted_at = now()
  where private.whatsapp_provider_bind_repairs.status = 'PENDING'
  returning private.whatsapp_provider_bind_repairs.id, private.whatsapp_provider_bind_repairs.provider_message_id
  into v_repair_id, v_repair_provider_id;

  if v_repair_id is null then
    -- Conflict target existed but was already RESOLVED (excluded by
    -- the WHERE above) — load it to report the already-resolved
    -- outcome / detect a conflicting id.
    select id, provider_message_id into v_repair_id, v_repair_provider_id
    from private.whatsapp_provider_bind_repairs
    where whatsapp_message_id = p_message_id;
  end if;

  if v_repair_provider_id is distinct from p_provider_message_id then
    raise exception 'WHATSAPP_PROVIDER_BIND_CONFLICT' using errcode = '23514';
  end if;

  -- WA-APP-02-R1: durably record the provider_message_id onto this
  -- message's own opaque correlation too — ALSO before any exception-
  -- catching block, and ALSO tenant-scoped by (whatsapp_message_id,
  -- business_id). A correlation row is expected to already exist
  -- (created atomically in begin_whatsapp_outbound_message before Meta
  -- was ever contacted) — its absence is tolerated, never fatal, since
  -- a message created before this remediation shipped would have none.
  update private.whatsapp_outbound_provider_correlations
  set provider_message_id = p_provider_message_id,
      state = 'PROVIDER_ACCEPTED_UNBOUND'
  where whatsapp_message_id = p_message_id
    and business_id = p_business_id
    and provider_message_id is null;

  if not found then
    -- Either no correlation row exists at all (pre-remediation
    -- message), or it already carries a provider_message_id — if that
    -- existing id conflicts with this call's, reject outright, never
    -- silently overwrite (mirrors the whatsapp_provider_bind_repairs
    -- conflict check immediately above, applied to the correlation too).
    select provider_message_id into v_correlation_provider_id
    from private.whatsapp_outbound_provider_correlations
    where whatsapp_message_id = p_message_id and business_id = p_business_id;

    if v_correlation_provider_id is not null and v_correlation_provider_id is distinct from p_provider_message_id then
      raise exception 'WHATSAPP_PROVIDER_BIND_CONFLICT' using errcode = '23514';
    end if;
  end if;

  select wm.provider_message_id into v_current_provider_id
  from public.whatsapp_messages wm
  where wm.id = p_message_id and wm.business_id = p_business_id
  for update;

  if not found then
    raise exception 'WHATSAPP_MESSAGE_NOT_FOUND' using errcode = '22023';
  end if;

  if v_current_provider_id is not null and v_current_provider_id is distinct from p_provider_message_id then
    raise exception 'WHATSAPP_PROVIDER_BIND_CONFLICT' using errcode = '23514';
  end if;

  if v_current_provider_id = p_provider_message_id then
    -- Already durably bound (a prior attempt actually succeeded, or
    -- this is an exact replay of an already-resolved repair) —
    -- idempotent no-op: close out the repair record AND the
    -- correlation, never re-audit.
    update private.whatsapp_provider_bind_repairs
    set status = 'RESOLVED', resolved_at = now()
    where id = v_repair_id;
    update private.whatsapp_outbound_provider_correlations
    set state = 'RESOLVED', resolved_at = coalesce(resolved_at, now())
    where whatsapp_message_id = p_message_id and business_id = p_business_id and state <> 'RESOLVED';
    resolved := true;
    bound_provider_message_id := p_provider_message_id;
    retryable := null;
    return next;
    return;
  end if;

  begin
    update public.whatsapp_messages
    set provider_message_id = p_provider_message_id
    where id = p_message_id and business_id = p_business_id and provider_message_id is null;

    if not found then
      raise exception 'WHATSAPP_MESSAGE_ALREADY_BOUND' using errcode = '22023';
    end if;

    perform private.record_whatsapp_message_status_event(p_message_id, p_business_id, 'ACCEPTED', now(), null);

    -- Actor USER when a staff-initiated retry resolved this; actor
    -- SYSTEM when a future status-webhook-assisted repair path resolves
    -- it with no acting user (p_actor_user_id left null) — see this
    -- migration's own header comment.
    perform private.record_audit_event(
      p_business_id,
      case when p_actor_user_id is not null then 'USER' else 'SYSTEM' end,
      p_actor_user_id, 'whatsapp.message_sent', 'CUSTOMER',
      null, null, null, 'whatsapp_messages', p_message_id, null, 'SUCCESS', '{}'::jsonb
    );

    update private.whatsapp_provider_bind_repairs
    set status = 'RESOLVED', resolved_at = now()
    where id = v_repair_id;

    update private.whatsapp_outbound_provider_correlations
    set state = 'RESOLVED', resolved_at = now()
    where whatsapp_message_id = p_message_id and business_id = p_business_id;

    resolved := true;
    bound_provider_message_id := p_provider_message_id;
    retryable := null;
    return next;
    return;
  exception
    when serialization_failure or deadlock_detected or lock_not_available then
      -- WA-APP-03-RC: ONLY these three genuinely transient PostgreSQL
      -- conditions (SQLSTATEs 40001 / 40P01 / 55P03 — the only
      -- conditions actually reachable from this block's own body: a
      -- single-row UPDATE plus two downstream function calls, all
      -- inside one transaction, contending with concurrent callers of
      -- this same idempotent repair path) are classified retryable.
      -- Durably recorded on the repair row for diagnostics, exactly as
      -- this codebase did before this migration.
      v_err := left(coalesce(sqlstate, '') || ':' || coalesce(sqlerrm, ''), 50);
      update private.whatsapp_provider_bind_repairs
      set last_error_code = v_err
      where id = v_repair_id;

      resolved := false;
      bound_provider_message_id := p_provider_message_id;
      retryable := true;
      return next;
      return;
    when others then
      -- Any OTHER error — a foreign-key/check-constraint violation, an
      -- unexpected internal error, a malformed stored configuration/
      -- state, anything not explicitly known to be transient — is
      -- classified NON-retryable instead. Caught and durably recorded
      -- HERE (never re-raised past this function's own boundary — see
      -- this file's own header comment on why a bare RAISE here would
      -- destroy this function's own durable repair-obligation record
      -- via the caller's savepoint rollback), so the durable diagnostic
      -- record survives exactly like the retryable case above; only
      -- the returned classification differs.
      v_err := left(coalesce(sqlstate, '') || ':' || coalesce(sqlerrm, ''), 50);
      update private.whatsapp_provider_bind_repairs
      set last_error_code = v_err
      where id = v_repair_id;

      resolved := false;
      bound_provider_message_id := p_provider_message_id;
      retryable := false;
      return next;
      return;
  end;
end;
$$;

alter function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  to service_role;

revoke create on schema public from private_whatsapp_provider_writer;

-- ===========================================================================
-- ingest_and_process_whatsapp_status_event — CREATE OR REPLACE (return
-- shape and signature unchanged from 20260908080300) to read the new
-- `retryable` column from repair_whatsapp_provider_bind's now-widened
-- return table and classify its callback-assisted branch accordingly.
-- See this file's own header comment for the full rationale.
-- ===========================================================================
create or replace function public.ingest_and_process_whatsapp_status_event(
  p_provider_event_key        text,
  p_payload_sha256            text,
  p_business_id               uuid,
  p_whatsapp_phone_number_id  uuid,
  p_provider_message_id       text,
  p_status                    text,
  p_provider_timestamp        timestamptz default null,
  p_failure_reason            text default null,
  p_opaque_callback_token     text default null
)
returns table (ledger_status text, message_resolved boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger_id           uuid;
  v_status              text;
  v_existing_type       text;
  v_existing_hash       text;
  v_existing_business   uuid;
  v_existing_number     uuid;
  v_message_id          uuid;
  v_message_business    uuid;
  v_err                 text;
  v_correlation_message_id uuid;
  v_correlation_business_id uuid;
  v_correlation_provider   text;
  v_bind_resolved       boolean;
  v_bind_retryable       boolean;
begin
  if p_provider_event_key is null or p_payload_sha256 is null or p_business_id is null
     or p_whatsapp_phone_number_id is null or p_provider_message_id is null or p_status is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;

  insert into private.whatsapp_webhook_events (
    provider, provider_event_key, event_type, business_id, whatsapp_phone_number_id, payload_sha256
  ) values (
    'META_CLOUD', p_provider_event_key, 'message.status', p_business_id, p_whatsapp_phone_number_id, p_payload_sha256
  )
  on conflict (provider, provider_event_key) do nothing
  returning private.whatsapp_webhook_events.id, private.whatsapp_webhook_events.processing_status
  into v_ledger_id, v_status;

  if v_ledger_id is null then
    select w.id, w.processing_status, w.event_type, w.payload_sha256, w.business_id, w.whatsapp_phone_number_id
    into v_ledger_id, v_status, v_existing_type, v_existing_hash, v_existing_business, v_existing_number
    from private.whatsapp_webhook_events w
    where w.provider = 'META_CLOUD' and w.provider_event_key = p_provider_event_key
    for update;

    if v_ledger_id is null then
      raise exception 'WHATSAPP_WEBHOOK_EVENT_NOT_FOUND' using errcode = '22023';
    end if;

    if v_existing_type is distinct from 'message.status'
       or v_existing_hash is distinct from p_payload_sha256
       or v_existing_business is distinct from p_business_id
       or v_existing_number is distinct from p_whatsapp_phone_number_id then
      raise exception 'WHATSAPP_WEBHOOK_EVENT_CONFLICT' using errcode = '23514';
    end if;

    if v_status in ('PROCESSED', 'IGNORED') then
      ledger_status := v_status;
      message_resolved := v_status = 'PROCESSED';
      return next;
      return;
    end if;
  end if;

  update private.whatsapp_webhook_events
  set processing_attempts = processing_attempts + 1, last_attempted_at = now()
  where id = v_ledger_id;

  begin
    select wm.id, wm.business_id into v_message_id, v_message_business
    from public.whatsapp_messages wm
    where wm.provider_message_id = p_provider_message_id;

    if v_message_id is not null and v_message_business is distinct from p_business_id then
      -- Resolved, but to a message in a DIFFERENT business — never
      -- treated as a usable match (cross-tenant anomaly, not a retry
      -- target).
      v_message_id := null;
      v_message_business := null;
    end if;

    -- Defensive cross-check (adversarial case: token names Message A
    -- but the wamid itself already resolves to Message B) — never
    -- overwrite/attach on inconsistent provider evidence.
    if v_message_id is not null and p_opaque_callback_token is not null
       and p_opaque_callback_token ~ '^[0-9a-f]{32}$' then
      select whatsapp_message_id into v_correlation_message_id
      from private.whatsapp_outbound_provider_correlations
      where opaque_callback_token = p_opaque_callback_token;

      if v_correlation_message_id is not null and v_correlation_message_id is distinct from v_message_id then
        update private.whatsapp_webhook_events
        set processing_status = 'IGNORED', processed_at = now(), last_processing_error_code = 'CALLBACK_TOKEN_MISMATCH'
        where id = v_ledger_id;
        ledger_status := 'IGNORED';
        message_resolved := false;
        return next;
        return;
      end if;
    end if;

    -- WA-APP-02-R1 callback-assisted recovery: only attempted when the
    -- direct wamid lookup above found nothing at all.
    if v_message_id is null and p_opaque_callback_token is not null
       and p_opaque_callback_token ~ '^[0-9a-f]{32}$' then
      select whatsapp_message_id, business_id, provider
      into v_correlation_message_id, v_correlation_business_id, v_correlation_provider
      from private.whatsapp_outbound_provider_correlations
      where opaque_callback_token = p_opaque_callback_token;

      if v_correlation_message_id is not null
         and v_correlation_provider = 'META_CLOUD'
         and v_correlation_business_id = p_business_id then
        begin
          select resolved, retryable
          into v_bind_resolved, v_bind_retryable
          from public.repair_whatsapp_provider_bind(v_correlation_message_id, p_business_id, p_provider_message_id, null);
        exception when sqlstate '23514' then
          -- Permanent, non-retryable conflict (e.g. this correlation's
          -- message is already bound to a DIFFERENT wamid) — never
          -- endlessly retried, and zero mutation beyond the ledger
          -- itself. Unchanged from 20260908080200.
          update private.whatsapp_webhook_events
          set processing_status = 'IGNORED', processed_at = now(), last_processing_error_code = 'CALLBACK_BIND_CONFLICT'
          where id = v_ledger_id;
          ledger_status := 'IGNORED';
          message_resolved := false;
          return next;
          return;
        end;

        if coalesce(v_bind_resolved, false) then
          v_message_id := v_correlation_message_id;
          v_message_business := p_business_id;
        elsif coalesce(v_bind_retryable, false) then
          -- WA-APP-03 (20260908080300): a genuinely transient
          -- PostgreSQL condition occurred DURING the bind attempt
          -- itself — RAISE so this event is caught by this function's
          -- own outer exception handler and becomes FAILED_RETRYABLE,
          -- letting an exact Meta retry repair it.
          raise exception 'WHATSAPP_CALLBACK_BIND_RETRYABLE_FAILURE' using errcode = 'XX000';
        else
          -- WA-APP-03-RC: resolved=false with retryable=false is a
          -- PERMANENT/unexpected internal failure (repair_whatsapp_provider_bind's
          -- own `when others` classification) — no amount of Meta
          -- replay can ever fix it, so it must NEVER become
          -- FAILED_RETRYABLE. Classified DIRECTLY here as a terminal,
          -- safe FAILED ledger row — deliberately NEVER raised: unlike
          -- the retryable branch above (whose RAISE is caught by this
          -- function's own outer handler and is EXPECTED to roll this
          -- entire nested block back to its own savepoint, discarding
          -- repair_whatsapp_provider_bind's own durable writes along
          -- with everything else — see the retryable-case test in
          -- tests/integration/whatsapp-status-retry-reconciliation.test.ts,
          -- which asserts the correlation stays untouched), a RAISE
          -- here would do the exact same destructive rollback for a
          -- case that does NOT need it. Not raising instead lets
          -- repair_whatsapp_provider_bind's own already-committed
          -- durable writes survive: the bind-repair row (PENDING, with
          -- the failure's error code recorded) and the correlation row
          -- (advanced to PROVIDER_ACCEPTED_UNBOUND, remembering the
          -- attempted provider_message_id) both persist — preserving
          -- WA-APP-02-R1's own "never lose a provider-accepted wamid"
          -- guarantee even for a permanently-failing first attempt; a
          -- later repair_whatsapp_provider_bind retry with the SAME
          -- provider_message_id, once the underlying condition is
          -- fixed, can still complete the bind. The message itself
          -- (public.whatsapp_messages.provider_message_id) is never
          -- partially bound and no status/audit event is ever recorded
          -- — repair_whatsapp_provider_bind's own internal exception
          -- handling confines the actual bind attempt to its own
          -- rolled-back subtransaction, unaffected by this decision.
          -- No raw SQL/database error text ever reaches the HTTP layer
          -- — the route (app/api/webhooks/meta-whatsapp/route.ts)
          -- never reads last_processing_error_code, only ledger_status,
          -- and only ever responds with a fixed, generic error string.
          update private.whatsapp_webhook_events
          set processing_status = 'FAILED', processed_at = now(), last_processing_error_code = 'CALLBACK_BIND_PERMANENT_FAILURE'
          where id = v_ledger_id;
          ledger_status := 'FAILED';
          message_resolved := false;
          return next;
          return;
        end if;
      end if;
    end if;

    if v_message_id is null or v_message_business is distinct from p_business_id then
      update private.whatsapp_webhook_events
      set processing_status = 'IGNORED', processed_at = now(), last_processing_error_code = null
      where id = v_ledger_id;
      ledger_status := 'IGNORED';
      message_resolved := false;
      return next;
      return;
    end if;

    perform public.record_whatsapp_provider_message_status(v_message_id, p_business_id, p_status, p_provider_timestamp, p_failure_reason);

    update private.whatsapp_webhook_events
    set processing_status = 'PROCESSED', processed_at = now(), message_id = v_message_id, last_processing_error_code = null
    where id = v_ledger_id;

    ledger_status := 'PROCESSED';
    message_resolved := true;
    return next;
    return;
  exception when others then
    v_err := left(coalesce(sqlstate, '') || ':' || coalesce(sqlerrm, ''), 50);
    update private.whatsapp_webhook_events
    set processing_status = 'FAILED_RETRYABLE', last_processing_error_code = v_err
    where id = v_ledger_id;

    ledger_status := 'FAILED_RETRYABLE';
    message_resolved := false;
    return next;
    return;
  end;
end;
$$;

-- Ownership and every existing grant/revoke on this function are
-- untouched by CREATE OR REPLACE (the signature is unchanged from
-- 20260908080300) — no ALTER/GRANT/REVOKE restated here, exactly like
-- 20260908080300's own identical precedent.
