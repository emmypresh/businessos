-- Phase 1M: WhatsApp + Customer Communication — WA-APP-03-RC-TERM
-- REMEDIATION. Additive on top of
-- 20260908080400_whatsapp_bind_failure_classification.sql (itself
-- additive on 20260908080300, itself additive on 20260908080200, itself
-- additive on 20260908080100, itself additive on 20260908080000, itself
-- additive on the frozen Phase 1M DB foundation, d3a2d3a — still
-- untouched). No frozen Phase 1A–1M migration is edited here, and none
-- of the five prior application-layer migration FILES is edited either
-- — this is a CREATE OR REPLACE (signature and return shape unchanged)
-- of ingest_and_process_whatsapp_status_event only.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-03-RC-TERM — FAILED WAS NOT TREATED AS A TERMINAL LEDGER
-- STATUS ON EXACT REPLAY
-- ═══════════════════════════════════════════════════════════════════
-- 20260908080400 (WA-APP-03-RC) correctly classified a PERMANENT/
-- unexpected internal bind failure as a terminal, safe FAILED ledger
-- row — but the exact-replay short-circuit near the top of
-- ingest_and_process_whatsapp_status_event only ever recognized
-- `PROCESSED` and `IGNORED` as terminal:
--
--   if v_status in ('PROCESSED', 'IGNORED') then ... return; end if;
--
-- FAILED fell through that check, so an exact provider replay of an
-- event already marked FAILED re-entered the mutation path below:
-- processing_attempts was incremented again, and — for the
-- callback-assisted branch specifically — repair_whatsapp_provider_bind
-- was called AGAIN for a bind already declared permanently unrecoverable.
-- That contradicts the FAILED contract 20260908080400 itself documents:
-- "no amount of identical replay can ever fix" a permanent failure.
--
-- FIX — widen the terminal short-circuit to also match FAILED:
--
--   if v_status in ('PROCESSED', 'IGNORED', 'FAILED') then ... end if;
--
-- An exact replay of a FAILED event now returns the existing ledger
-- result directly, exactly like PROCESSED/IGNORED already did:
--   - processing_attempts is never incremented (the increment statement
--     sits AFTER this short-circuit and is never reached)
--   - repair_whatsapp_provider_bind is never called again
--   - the message/status/correlation rows are never touched again
--   - no audit event is ever emitted
--   - the route's HTTP response is unchanged (FAILED was never one of
--     the FAILED_RETRYABLE-only 5xx cases — see
--     lib/whatsapp/webhook-handlers.ts — so this stays a normal,
--     non-retry terminal response)
--
-- FAILED_RETRYABLE is deliberately NOT added here — it must remain
-- retryable on exact replay (20260908080300's own contract, unchanged),
-- so a transient failure can still be repaired by Meta's own retry.
-- 23514 conflicts and no-correlation events continue to resolve IGNORED
-- exactly as before, unaffected by this change (they were already
-- covered by this same short-circuit).
--
-- No classification logic changes: the 40001/40P01/55P03 ->
-- retryable=true -> FAILED_RETRYABLE mapping, the "every other caught
-- internal error" -> retryable=false -> FAILED mapping, and the 23514 /
-- no-correlation -> IGNORED mappings from 20260908080300 and
-- 20260908080400 are all untouched. Every other line of this function's
-- body — the durable-obligation-first bind-repair upsert inside
-- repair_whatsapp_provider_bind, the correlation upsert, the conflict/
-- idempotency checks, the actual message bind, the audit event, the
-- direct provider_message_id lookup, the callback-token consistency
-- check, the cross-tenant/business_id check, and the outer
-- `exception when others` -> FAILED_RETRYABLE handler — is unchanged
-- from 20260908080400.
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

    -- WA-APP-03-RC-TERM: FAILED is now terminal on exact replay, exactly
    -- like PROCESSED and IGNORED already were. See this file's own
    -- header comment for the full rationale.
    if v_status in ('PROCESSED', 'IGNORED', 'FAILED') then
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
          -- safe FAILED ledger row — deliberately NEVER raised (see
          -- 20260908080400's own header comment for the savepoint-
          -- rollback rationale). WA-APP-03-RC-TERM (this file) makes an
          -- EXACT REPLAY of this same event terminal too, via the
          -- widened short-circuit above — this branch itself is only
          -- ever reached on the FIRST processing attempt now.
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
-- 20260908080400) — no ALTER/GRANT/REVOKE restated here, exactly like
-- 20260908080400's own identical precedent.
