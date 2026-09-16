-- Phase 1M: WhatsApp + Customer Communication — WA-APP-03 REMEDIATION.
-- Additive on top of 20260908080200_whatsapp_outbound_provider_correlation.sql
-- (itself additive on 20260908080100_whatsapp_provider_reliability.sql,
-- itself additive on 20260908080000_whatsapp_application_provider_writer.sql,
-- itself additive on the frozen Phase 1M DB foundation, d3a2d3a — still
-- untouched). No frozen Phase 1A–1M migration is edited here, and none
-- of the three prior application-layer migration FILES is edited
-- either — this is a `create or replace` of ONE function those files
-- defined, the same "additive correction" pattern each of those prior
-- files already used against the one before it.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-03 — A TRANSIENT CALLBACK-ASSISTED BIND FAILURE WAS WRONGLY
-- CLASSIFIED AS A TERMINAL IGNORED EVENT
-- ═══════════════════════════════════════════════════════════════════
-- public.repair_whatsapp_provider_bind (20260908080100, extended by
-- 20260908080200) returns `resolved boolean`, and that boolean is
-- ALREADY unambiguous: every genuinely permanent/non-retryable outcome
-- (a provider id already bound to a DIFFERENT value, a bind-repair
-- record conflict) is raised as an exception with sqlstate 23514
-- ("WHATSAPP_PROVIDER_BIND_CONFLICT") BEFORE that function's own
-- internal BEGIN/EXCEPTION block is ever entered — never folded into
-- `resolved`. `resolved = false` is returned from exactly ONE place:
-- that function's own internal `exception when others` handler, which
-- catches ONLY a failure occurring DURING the actual bind attempt
-- itself (the whatsapp_messages update, the status-event/audit calls)
-- — i.e. a transient, internal, retryable failure, by construction.
-- No refinement of that return contract is therefore needed (per this
-- remediation's own instruction to refine it ONLY if it actually
-- conflates outcomes — verified here that it does not).
--
-- The bug was entirely in the CALLER,
-- ingest_and_process_whatsapp_status_event's callback-assisted
-- resolution branch: when `resolved` came back false, the code did
-- nothing and fell through to the generic "still unresolved" check
-- immediately below, which classifies an unresolved v_message_id as
-- terminal IGNORED — silently treating a transient internal failure
-- exactly like "no correlation found at all". A signed Meta exact
-- retry could never repair this: replaying the SAME event against an
-- IGNORED ledger row is a no-op (this function's own existing terminal-
-- state short-circuit, unchanged here), so the message would remain
-- permanently unbound.
--
-- FIX: when the callback-assisted repair call returns resolved=false,
-- RAISE instead of falling through. That exception is not sqlstate
-- 23514 (already reserved, and still exclusively handled, for the
-- permanent-conflict case immediately above it — untouched), so it is
-- not caught there; it propagates to this function's own outer
-- `exception when others` handler (unchanged, pre-existing, the same
-- handler WA-APP-01 already relies on for every other transient-
-- failure path in this function) which marks the ledger row
-- FAILED_RETRYABLE and returns that outcome to the caller — from there
-- the existing, unmodified route handler already returns HTTP 5xx for
-- FAILED_RETRYABLE, and Meta's own exact retry re-enters this same
-- function, re-attempts the callback-assisted bind from a clean slate,
-- and on success binds the wamid, applies the status, audits
-- `whatsapp.message_sent` exactly once, and marks the ledger PROCESSED
-- — all via the SAME trusted repair_whatsapp_provider_bind path,
-- unmodified. No new mutation surface, no new grant, no change to the
-- trusted transaction/subtransaction boundary either function already
-- enforces.
--
-- Every other line of this function's body (20260908080200) — the
-- ledger insert/replay/terminal-state handling, the direct
-- provider_message_id lookup, the callback-token consistency check,
-- the cross-tenant/business_id check, the permanent-conflict
-- (sqlstate 23514) handling, the final status projection and PROCESSED
-- transition, and the outer `exception when others` ->
-- FAILED_RETRYABLE handler itself — is unchanged.
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
          select resolved
          into v_bind_resolved
          from public.repair_whatsapp_provider_bind(v_correlation_message_id, p_business_id, p_provider_message_id, null);
        exception when sqlstate '23514' then
          -- Permanent, non-retryable conflict (e.g. this correlation's
          -- message is already bound to a DIFFERENT wamid) — never
          -- endlessly retried, and zero mutation beyond the ledger
          -- itself.
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
        else
          -- WA-APP-03 FIX: repair_whatsapp_provider_bind returns
          -- resolved=false ONLY from its own internal
          -- "exception when others" handler — i.e. a transient
          -- failure occurred DURING the bind attempt itself (every
          -- permanent/conflict outcome is instead raised with
          -- sqlstate 23514 and already handled above, never folded
          -- into this boolean). Falling through to the generic
          -- "unresolved" check below would wrongly classify this as
          -- terminal IGNORED. RAISE here instead so this event is
          -- caught by this function's own outer exception handler
          -- and becomes FAILED_RETRYABLE, letting an exact Meta
          -- retry repair it. Error text is bounded and carries no
          -- internal detail.
          raise exception 'WHATSAPP_CALLBACK_BIND_RETRYABLE_FAILURE' using errcode = 'XX000';
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
-- 20260908080200) — no ALTER/GRANT/REVOKE restated here.
