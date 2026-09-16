-- Phase 1M: WhatsApp + Customer Communication — APPLICATION / PROVIDER
-- LAYER, RELIABILITY REMEDIATION (WA-APP-01, WA-APP-02). Additive
-- on top of 20260908080000_whatsapp_application_provider_writer.sql
-- (itself additive on the frozen Phase 1M DB foundation, d3a2d3a —
-- still untouched, still not modified by this file). No frozen
-- Phase 1A–1M migration is edited here; every change below is either a
-- new column/constraint/table added to an already-frozen table via a
-- NEW file, or a brand-new function.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-01 — WEBHOOK RECEIPT CAN OUTLIVE FAILED PROCESSING
-- ═══════════════════════════════════════════════════════════════════
-- The frozen private.whatsapp_webhook_events ledger already tracks
-- processing_status (RECEIVED/PROCESSED/IGNORED/FAILED) and processed_at,
-- but nothing in the ORIGINAL application-layer migration ever advanced
-- those columns beyond their RECEIVED default before this file: the
-- webhook route called private.record_whatsapp_webhook_event (via the
-- public.ingest_whatsapp_webhook_event wrapper) to durably claim the
-- (provider, event key) pair, then called the downstream mutation RPC
-- SEPARATELY. If that second call failed transiently, the ledger row
-- was already durably RECEIVED — so an exact Meta retry saw
-- is_new = false and the webhook route treated that as a terminal,
-- already-handled replay, and the original inbound message / status
-- update was silently, permanently lost. This is exactly WA-APP-01.
--
-- FIX: two new ATOMIC orchestrator RPCs
-- (public.ingest_and_process_whatsapp_inbound_message,
-- public.ingest_and_process_whatsapp_status_event) each perform the
-- ledger receipt AND the authoritative downstream mutation IN ONE
-- TRANSACTION, with the ledger row locked (`for update`) for the
-- duration. Only when the downstream mutation actually succeeds does
-- the ledger transition to PROCESSED; a transient downstream failure is
-- caught internally (an exception inside a PL/pgSQL BEGIN/EXCEPTION
-- block implicitly rolls back to a savepoint, not the whole
-- transaction) and durably recorded as FAILED_RETRYABLE — the ledger
-- INSERT/lock/attempt-counter bump itself is NEVER undone. The webhook
-- route (lib/whatsapp/webhook-handlers.ts) inspects the returned
-- ledger_status and returns a 5xx to Meta whenever ANY event in the
-- batch ends FAILED_RETRYABLE, so Meta's own retry — the only recovery
-- source this round has, background workers being explicitly deferred
-- — is what repairs it. An exact replay of a FAILED_RETRYABLE event
-- re-enters the SAME function, sees a non-terminal status, and retries
-- the mutation; an exact replay of a PROCESSED/IGNORED event returns
-- immediately with zero re-mutation. Concurrency: the `for update` lock
-- on the ledger row serializes two simultaneous replays of the
-- identical event — the loser blocks until the winner's transaction
-- (ledger update AND downstream mutation) commits, then observes the
-- now-terminal status and returns without reprocessing; the downstream
-- mutation RPCs' own existing idempotency (ON CONFLICT DO NOTHING on
-- provider_message_id / the frozen partial unique conversation indexes)
-- is a second, independent safety net even in the pathological case of
-- two ledger rows racing before either commits.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-02 — PROVIDER ACCEPTED MESSAGE BUT LOCAL BIND FAILED
-- ═══════════════════════════════════════════════════════════════════
-- Once Meta's synchronous send API returns a provider_message_id, that
-- id is critical provider truth: it is the ONLY key future status
-- webhooks can ever resolve this message by. The original round bound
-- it with a single UPDATE (public.bind_outbound_provider_message_id)
-- called from the Server Action; if that call failed for any reason,
-- the action logged and returned {success:true} anyway, and the local
-- message stayed PENDING with no provider identity anywhere durable —
-- permanently unreconcilable, since a retry with the same
-- client_creation_key is (correctly, per WA-APP-01's sibling ambiguous-
-- timeout rule) never allowed to call Meta again.
--
-- FIX: a new, narrow, RLS-locked-down private table
-- (private.whatsapp_provider_bind_repairs) records the (message,
-- provider id) reconciliation obligation durably, and a single
-- idempotent RPC (public.repair_whatsapp_provider_bind) is now the
-- ONLY path the Server Action uses to bind a provider_message_id — for
-- the very first bind attempt AND for every later repair retry alike.
-- It (1) durably upserts the repair obligation FIRST, in a statement
-- outside any exception-catching block, so the obligation survives even
-- if the bind attempt right after it fails; (2) then attempts the bind
-- inside its own BEGIN/EXCEPTION block, so a transient failure there
-- rolls back only the bind attempt, never the just-recorded obligation;
-- (3) is idempotent on an exact-provider-id replay (already bound to
-- the SAME id -> success, no re-audit); and (4) rejects a conflicting
-- DIFFERENT provider id for the same local message outright, never
-- silently overwriting. The repair table's composite foreign key to
-- (whatsapp_messages.id, business_id) makes a cross-tenant repair
-- attempt structurally impossible (a mismatched pair fails the FK
-- before any other logic runs) — the same tenant-safety pattern this
-- codebase already uses everywhere else.
-- ===========================================================================
-- WA-APP-01: additive lifecycle columns on the frozen webhook ledger.
-- FAILED_RETRYABLE is a NEW allowed value (added via DROP/ADD
-- CONSTRAINT in this new file — the frozen migration file itself is
-- untouched); the old bare 'FAILED' value is left in the allowed set
-- for backward compatibility even though nothing writes it.
-- ===========================================================================
alter table private.whatsapp_webhook_events
  add column if not exists processing_attempts int not null default 0,
  add column if not exists last_processing_error_code text
    check (last_processing_error_code is null or length(last_processing_error_code) <= 50),
  add column if not exists last_attempted_at timestamptz;

alter table private.whatsapp_webhook_events
  drop constraint whatsapp_webhook_events_processing_status_check;
alter table private.whatsapp_webhook_events
  add constraint whatsapp_webhook_events_processing_status_check
  check (processing_status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'FAILED_RETRYABLE'));

-- private_whatsapp_provider_writer already owns/has insert+select+the
-- narrow `update (result)` grant on this table from the frozen
-- foundation migration — the new columns need their own explicit
-- grants (column grants are never implied by a grant on other columns).
grant select (id, processing_status, processing_attempts, event_type, payload_sha256, business_id, whatsapp_phone_number_id, message_id)
  on private.whatsapp_webhook_events to private_whatsapp_provider_writer;
grant update (processing_status, processing_attempts, last_processing_error_code, last_attempted_at, processed_at, message_id)
  on private.whatsapp_webhook_events to private_whatsapp_provider_writer;

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on
-- the function's own schema (public) — the prior migration granted this
-- narrowly and then revoked it again once done; re-granted here for the
-- same reason, and revoked again at the end of this file.
grant create on schema public to private_whatsapp_provider_writer;

-- ===========================================================================
-- ingest_and_process_whatsapp_inbound_message — WA-APP-01 atomic
-- orchestrator for inbound messages. Replaces the two-step
-- ingest-then-mutate call sequence in lib/whatsapp/webhook-handlers.ts
-- for the message.inbound event type. See this migration's own header
-- comment for the full rationale.
-- ===========================================================================
create or replace function public.ingest_and_process_whatsapp_inbound_message(
  p_provider_event_key        text,
  p_payload_sha256            text,
  p_business_id               uuid,
  p_whatsapp_phone_number_id  uuid,
  p_customer_phone_e164       text,
  p_provider_message_id       text,
  p_message_type              text,
  p_branch_id                 uuid default null,
  p_customer_id               uuid default null,
  p_body_text                 text default null,
  p_provider_timestamp        timestamptz default null
)
returns table (message_id uuid, conversation_id uuid, is_new_message boolean, ledger_status text)
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
  v_result              record;
  v_err                 text;
begin
  if p_provider_event_key is null or p_payload_sha256 is null or p_business_id is null
     or p_whatsapp_phone_number_id is null or p_customer_phone_e164 is null
     or p_provider_message_id is null or p_message_type is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;

  insert into private.whatsapp_webhook_events (
    provider, provider_event_key, event_type, business_id, whatsapp_phone_number_id, payload_sha256
  ) values (
    'META_CLOUD', p_provider_event_key, 'message.inbound', p_business_id, p_whatsapp_phone_number_id, p_payload_sha256
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

    if v_existing_type is distinct from 'message.inbound'
       or v_existing_hash is distinct from p_payload_sha256
       or v_existing_business is distinct from p_business_id
       or v_existing_number is distinct from p_whatsapp_phone_number_id then
      raise exception 'WHATSAPP_WEBHOOK_EVENT_CONFLICT' using errcode = '23514';
    end if;

    if v_status in ('PROCESSED', 'IGNORED') then
      -- Terminal: a legitimate replay of already-fully-handled work.
      -- Zero re-mutation — return the existing message untouched.
      select wm.id, wm.conversation_id into message_id, conversation_id
      from public.whatsapp_messages wm
      where wm.provider_message_id = p_provider_message_id;
      is_new_message := false;
      ledger_status := v_status;
      return next;
      return;
    end if;
    -- RECEIVED or FAILED_RETRYABLE: fall through and (re)attempt.
  end if;

  update private.whatsapp_webhook_events
  set processing_attempts = processing_attempts + 1, last_attempted_at = now()
  where id = v_ledger_id;

  begin
    select r.message_id, r.conversation_id, r.is_new
    into v_result
    from public.record_inbound_whatsapp_message(
      p_business_id, p_whatsapp_phone_number_id, p_customer_phone_e164, p_provider_message_id, p_message_type,
      p_branch_id, p_customer_id, p_body_text, p_provider_timestamp
    ) r;

    update private.whatsapp_webhook_events
    set processing_status = 'PROCESSED', processed_at = now(), message_id = v_result.message_id, last_processing_error_code = null
    where id = v_ledger_id;

    message_id := v_result.message_id;
    conversation_id := v_result.conversation_id;
    is_new_message := v_result.is_new;
    ledger_status := 'PROCESSED';
    return next;
    return;
  exception when others then
    v_err := left(coalesce(sqlstate, '') || ':' || coalesce(sqlerrm, ''), 50);
    update private.whatsapp_webhook_events
    set processing_status = 'FAILED_RETRYABLE', last_processing_error_code = v_err
    where id = v_ledger_id;

    message_id := null;
    conversation_id := null;
    is_new_message := false;
    ledger_status := 'FAILED_RETRYABLE';
    return next;
    return;
  end;
end;
$$;

alter function public.ingest_and_process_whatsapp_inbound_message(text, text, uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  owner to private_whatsapp_provider_writer;
revoke all on function public.ingest_and_process_whatsapp_inbound_message(text, text, uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_and_process_whatsapp_inbound_message(text, text, uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  to service_role;

-- ===========================================================================
-- ingest_and_process_whatsapp_status_event — WA-APP-01 atomic
-- orchestrator for message.status events. An unresolved (unknown, or
-- cross-tenant) provider_message_id is classified IGNORED — this is
-- intentional non-mutation ("ingest event evidence, do not mutate
-- unrelated message"), not a transient failure, so it is never
-- endlessly retried.
-- ===========================================================================
create or replace function public.ingest_and_process_whatsapp_status_event(
  p_provider_event_key        text,
  p_payload_sha256            text,
  p_business_id               uuid,
  p_whatsapp_phone_number_id  uuid,
  p_provider_message_id       text,
  p_status                    text,
  p_provider_timestamp        timestamptz default null,
  p_failure_reason            text default null
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

alter function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text)
  owner to private_whatsapp_provider_writer;
revoke all on function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text)
  to service_role;

-- ===========================================================================
-- WA-APP-02: durable provider-message-id reconciliation.
-- private_whatsapp_provider_writer already owns the surrounding schema
-- pieces this table's own single writer function depends on
-- (whatsapp_messages update, record_whatsapp_message_status_event,
-- record_audit_event) — this table itself is owned by that SAME role,
-- with NO grant of any kind to any other role. No policy of any kind
-- for any role, including service_role — the only path to this data is
-- the trusted repair_whatsapp_provider_bind function below, mirroring
-- private.whatsapp_webhook_events' own frozen "zero direct table
-- access, function-only" precedent exactly.
-- ===========================================================================
create table private.whatsapp_provider_bind_repairs (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete restrict,
  whatsapp_message_id   uuid not null,
  -- Bounded, same shape as whatsapp_messages.provider_message_id's own
  -- frozen constraint — never assumed longer.
  provider_message_id   text not null check (length(btrim(provider_message_id)) between 1 and 128),
  status                text not null default 'PENDING' check (status in ('PENDING', 'RESOLVED')),
  attempts              int not null default 0,
  -- Bounded, sanitized error CODE only — never sqlerrm's full text,
  -- never a raw provider response. Mirrors this same migration's own
  -- webhook-ledger last_processing_error_code bound exactly.
  last_error_code       text check (last_error_code is null or length(last_error_code) <= 50),
  last_attempted_at     timestamptz,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),

  unique (whatsapp_message_id),
  foreign key (whatsapp_message_id, business_id)
    references public.whatsapp_messages (id, business_id) on delete restrict
);

create index whatsapp_provider_bind_repairs_pending_idx
  on private.whatsapp_provider_bind_repairs (business_id) where status = 'PENDING';

alter table private.whatsapp_provider_bind_repairs enable row level security;
alter table private.whatsapp_provider_bind_repairs force row level security;

-- No policy of any kind for any role — see this section's own header
-- comment.
revoke all on private.whatsapp_provider_bind_repairs from public, anon, authenticated, service_role;
grant insert, select, update on private.whatsapp_provider_bind_repairs to private_whatsapp_provider_writer;

-- ===========================================================================
-- repair_whatsapp_provider_bind — the ONE path (first bind attempt AND
-- every later repair retry alike) that ever writes
-- whatsapp_messages.provider_message_id after a successful Meta send.
-- Durable-obligation-first, idempotent, conflict-safe — see this
-- migration's own header comment for the full contract.
-- ===========================================================================
create or replace function public.repair_whatsapp_provider_bind(
  p_message_id            uuid,
  p_business_id           uuid,
  p_provider_message_id   text,
  p_actor_user_id         uuid default null
)
returns table (resolved boolean, bound_provider_message_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_repair_id             uuid;
  v_repair_provider_id    text;
  v_current_provider_id   text;
  v_err                   text;
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
    -- idempotent no-op: close out the repair record, never re-audit.
    update private.whatsapp_provider_bind_repairs
    set status = 'RESOLVED', resolved_at = now()
    where id = v_repair_id;
    resolved := true;
    bound_provider_message_id := p_provider_message_id;
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

    resolved := true;
    bound_provider_message_id := p_provider_message_id;
    return next;
    return;
  exception when others then
    v_err := left(coalesce(sqlstate, '') || ':' || coalesce(sqlerrm, ''), 50);
    update private.whatsapp_provider_bind_repairs
    set last_error_code = v_err
    where id = v_repair_id;

    resolved := false;
    bound_provider_message_id := p_provider_message_id;
    return next;
    return;
  end;
end;
$$;

-- record_audit_event and record_whatsapp_message_status_event EXECUTE
-- were already granted to private_whatsapp_provider_writer by the prior
-- migration — no new grant needed for either here.
alter function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- get_whatsapp_outbound_message_reconciliation_state — narrow,
-- read-only helper the Server Action uses on a client_creation_key
-- replay (is_new = false) to decide whether the message is already
-- fully bound, has a pending repair to retry (with its own already-
-- known provider_message_id — never re-derived from the client), or is
-- still genuinely ambiguous (never got a provider response at all).
-- Read-only, service_role only — never exposes anything beyond the
-- three fields the action needs.
-- ===========================================================================
create or replace function public.get_whatsapp_outbound_message_reconciliation_state(
  p_message_id  uuid,
  p_business_id uuid
)
returns table (
  bound_provider_message_id  text,
  has_pending_repair         boolean,
  pending_provider_message_id text
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    wm.provider_message_id,
    r.status = 'PENDING',
    r.provider_message_id
  from public.whatsapp_messages wm
  left join private.whatsapp_provider_bind_repairs r
    on r.whatsapp_message_id = wm.id and r.business_id = wm.business_id
  where wm.id = p_message_id and wm.business_id = p_business_id;
$$;

grant select (id, business_id, provider_message_id) on public.whatsapp_messages to private_whatsapp_provider_writer;

alter function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  to service_role;

revoke create on schema public from private_whatsapp_provider_writer;
