-- Phase 1M: WhatsApp + Customer Communication — WA-APP-02-R1 REMEDIATION.
-- Additive on top of 20260908080100_whatsapp_provider_reliability.sql
-- (itself additive on 20260908080000_whatsapp_application_provider_writer.sql,
-- itself additive on the frozen Phase 1M DB foundation, d3a2d3a — still
-- untouched). No frozen Phase 1A–1M migration is edited here, and
-- neither of the two prior application-layer migration FILES is edited
-- either — every change below is either a new table or a
-- `drop`/`create or replace` of a function those files defined, exactly
-- the same "additive correction" pattern 20260908080100 itself already
-- used against 20260908080000.
--
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-02-R1 — PROVIDER ACCEPTED THE MESSAGE, BUT THE IMMEDIATE BIND
-- CALL NEVER REACHED POSTGRES AT ALL
-- ═══════════════════════════════════════════════════════════════════
-- WA-APP-02 (20260908080100) already made repair_whatsapp_provider_bind
-- durable-obligation-first for the case where the bind RPC call reaches
-- Postgres and then fails partway through. It could not, by itself, fix
-- the narrower and more severe case this file addresses: the RPC call
-- never reaches Postgres AT ALL (a transport-level exception — DNS,
-- TLS, connection reset, process death — before any SQL executes).
-- When that happens, Meta has already durably accepted the message, but
-- BusinessOS has recorded the returned wamid nowhere it can ever read
-- again — and a client_creation_key retry is (correctly) forbidden from
-- calling Meta a second time, so the wamid is otherwise unrecoverable.
--
-- FIX: a durable, provider-independent, opaque correlation identity is
-- created and persisted BEFORE Meta is ever contacted — inside the SAME
-- atomic transaction as the outbound message's own creation
-- (begin_whatsapp_outbound_message, redefined below). Meta's own
-- `biz_opaque_callback_data` request field (added to the Cloud API
-- outbound-message request for exactly this purpose — see this file's
-- own footer note on doc verification) carries that token to Meta and
-- back; Meta echoes it verbatim on every subsequent message-status
-- webhook for that message, INCLUDING when the original synchronous
-- HTTP response never reached this application at all. A later signed
-- status webhook carrying the token can then identify the exact local
-- message and repair its wamid via the SAME trusted
-- repair_whatsapp_provider_bind path — no new, separately-trusted bind
-- surface is introduced.
--
-- The token itself is meaningless outside BusinessOS (a bare random
-- value, never a business/customer/message/phone/invoice identifier —
-- see this file's own table comment) and is never, by itself, a
-- mutation credential: binding still requires (1) a cryptographically
-- signed Meta webhook, (2) the provider phone number resolving to the
-- SAME business as the correlation row, and (3) the trusted
-- repair_whatsapp_provider_bind function's own existing conflict/tenant
-- checks — a leaked or guessed token alone authorizes nothing.
-- ===========================================================================

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on
-- the function's own schema (public) — granted narrowly here and
-- revoked again at the end of this file, exactly like both prior
-- application-layer migrations' own identical precedent.
grant create on schema public to private_whatsapp_provider_writer;
grant create on schema public to private_whatsapp_action_writer;

-- ===========================================================================
-- private.whatsapp_outbound_provider_correlations — the durable
-- pre-send correlation record. Owned entirely by the two roles that
-- already own every other piece of this pipeline; NO grant of any kind
-- to any other role, including service_role directly on the table
-- itself (only through the trusted functions below) — mirrors
-- private.whatsapp_webhook_events' and
-- private.whatsapp_provider_bind_repairs' own identical
-- "zero direct table access, function-only" precedent.
--
-- opaque_callback_token is a bare 32-hex-character random value (128
-- bits from a single gen_random_uuid(), hyphens stripped — this
-- codebase's own established source of cryptographically strong
-- randomness; see e.g. 20260826080500_create_product_rpc.sql's own
-- identical use of gen_random_uuid() as a random creation key, not just
-- an identity key). It intentionally carries NO business/customer/
-- message/phone/invoice/email/role/secret information of any kind —
-- it is meaningless outside this one table's own lookup.
-- ===========================================================================
create table private.whatsapp_outbound_provider_correlations (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete restrict,
  whatsapp_message_id   uuid not null,
  provider              text not null default 'META_CLOUD' check (provider = 'META_CLOUD'),
  -- Opaque only — see this table's own header comment. Never validated
  -- against or derived from any identifiable field.
  opaque_callback_token text not null check (opaque_callback_token ~ '^[0-9a-f]{32}$'),
  -- Bounded exactly like whatsapp_messages.provider_message_id's own
  -- frozen constraint — never assumed longer.
  provider_message_id   text check (provider_message_id is null or length(btrim(provider_message_id)) between 1 and 128),
  state                 text not null default 'PENDING_PROVIDER'
                          check (state in ('PENDING_PROVIDER', 'PROVIDER_ACCEPTED_UNBOUND', 'RESOLVED', 'AMBIGUOUS')),
  created_at            timestamptz not null default now(),
  resolved_at           timestamptz,

  -- One active correlation per outbound message — never a second token
  -- for the same logical send.
  unique (whatsapp_message_id),
  unique (opaque_callback_token),
  -- Composite FK to (whatsapp_messages.id, business_id) makes a
  -- cross-tenant correlation row structurally impossible, exactly like
  -- private.whatsapp_provider_bind_repairs' own identical FK.
  foreign key (whatsapp_message_id, business_id)
    references public.whatsapp_messages (id, business_id) on delete restrict
);

-- provider_message_id UNIQUE only where non-null (many rows are still
-- PENDING_PROVIDER with no id yet) — a partial unique index, exactly
-- like the frozen schema's own established pattern for optional
-- provider identifiers.
create unique index whatsapp_outbound_provider_correlations_provider_message_id_key
  on private.whatsapp_outbound_provider_correlations (provider_message_id)
  where provider_message_id is not null;

create index whatsapp_outbound_provider_correlations_business_idx
  on private.whatsapp_outbound_provider_correlations (business_id);

alter table private.whatsapp_outbound_provider_correlations enable row level security;
alter table private.whatsapp_outbound_provider_correlations force row level security;

-- No policy of any kind for any role — see this section's own header
-- comment. private_whatsapp_action_writer creates the row atomically
-- inside begin_whatsapp_outbound_message (and reads it back on an
-- idempotent replay); private_whatsapp_provider_writer resolves/updates
-- it from repair_whatsapp_provider_bind and the status-webhook
-- orchestrator.
revoke all on private.whatsapp_outbound_provider_correlations from public, anon, authenticated, service_role;
grant insert, select on private.whatsapp_outbound_provider_correlations to private_whatsapp_action_writer;
grant select, update on private.whatsapp_outbound_provider_correlations to private_whatsapp_provider_writer;

-- ===========================================================================
-- begin_whatsapp_outbound_message — redefined (not merely replaced:
-- the return shape widens with one new column, so this is a drop +
-- create, PostgreSQL does not allow CREATE OR REPLACE to change a
-- function's return type) to ALSO atomically create/reuse this
-- message's durable opaque callback correlation, in the SAME
-- transaction as the message row itself — the token is therefore
-- ALWAYS durable before the caller (lib/whatsapp/actions.ts) can ever
-- contact Meta. Every other line of this function is unchanged from
-- 20260908080000_whatsapp_application_provider_writer.sql's own
-- original body — see that file's own header comment for the
-- surrounding authorization/consent/window/template contract, which is
-- untouched here.
-- ===========================================================================
drop function if exists public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text);

create function public.begin_whatsapp_outbound_message(
  p_business_id          uuid,
  p_conversation_id      uuid,
  p_message_type         text,
  p_body_text            text default null,
  p_template_id          uuid default null,
  p_client_creation_key  text default null
)
returns table (
  message_id                uuid,
  is_new                    boolean,
  whatsapp_account_id       uuid,
  whatsapp_phone_number_id  uuid,
  provider_phone_number_id  text,
  destination_phone_e164    text,
  provider_template_id      text,
  template_name             text,
  template_language         text,
  opaque_callback_token     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_conversation        record;
  v_number              record;
  v_service_allowed     boolean;
  v_window_open         boolean;
  v_template            record;
  v_message_id          uuid;
  v_is_new              boolean;
  v_callback_token      text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_conversation_id is null or p_message_type is null or p_client_creation_key is null then
    raise exception 'p_business_id, p_conversation_id, p_message_type, and p_client_creation_key are required'
      using errcode = '22023';
  end if;
  if p_message_type not in ('TEXT', 'TEMPLATE') then
    raise exception 'UNSUPPORTED_MESSAGE_TYPE' using errcode = '22023';
  end if;
  if length(btrim(p_client_creation_key)) < 1 or length(p_client_creation_key) > 128 then
    raise exception 'INVALID_CLIENT_CREATION_KEY' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'whatsapp.send') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Idempotent replay: return the existing row untouched, no re-checks.
  select id into v_message_id
  from public.whatsapp_messages
  where business_id = p_business_id and client_creation_key = p_client_creation_key;

  if v_message_id is not null then
    -- Idempotent replay: the existing row's own already-validated
    -- identity/provider fields (AND its already-created correlation
    -- token — created atomically with the message on the original
    -- attempt, never re-created here) are returned as-is, with zero
    -- re-checks of consent/window/template.
    return query
      select wm.id, false, wa.id, wpn.id, wpn.provider_phone_number_id, wc.customer_phone_e164,
             wt.provider_template_id, wt.name, wt.language, c.opaque_callback_token
      from public.whatsapp_messages wm
      join public.whatsapp_conversations wc on wc.id = wm.conversation_id
      join public.whatsapp_phone_numbers wpn on wpn.id = wc.whatsapp_phone_number_id
      join public.whatsapp_accounts wa on wa.id = wpn.whatsapp_account_id
      left join public.whatsapp_templates wt on wt.id = wm.template_id
      left join private.whatsapp_outbound_provider_correlations c on c.whatsapp_message_id = wm.id
      where wm.id = v_message_id;
    return;
  end if;

  select wc.id as conversation_id, wc.customer_id, wc.branch_id, wc.whatsapp_phone_number_id,
         wc.customer_phone_e164, wc.customer_service_window_ends_at, wc.business_id
  into v_conversation
  from public.whatsapp_conversations wc
  where wc.id = p_conversation_id;

  if v_conversation.conversation_id is null or v_conversation.business_id <> p_business_id then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = '22023';
  end if;

  select wpn.id as whatsapp_phone_number_id, wpn.provider_phone_number_id, wpn.whatsapp_account_id, wpn.status
  into v_number
  from public.whatsapp_phone_numbers wpn
  where wpn.id = v_conversation.whatsapp_phone_number_id and wpn.business_id = p_business_id;

  if v_number.whatsapp_phone_number_id is null or v_number.status <> 'ACTIVE' then
    raise exception 'WHATSAPP_PHONE_NUMBER_UNAVAILABLE' using errcode = '22023';
  end if;

  -- SERVICE CONSENT — fails closed: no row, or row with the column at
  -- its default, both mean NOT allowed. Never inferred from anything
  -- else.
  if v_conversation.customer_id is null then
    v_service_allowed := false;
  else
    select coalesce(cwp.service_messages_allowed, false) into v_service_allowed
    from public.customer_whatsapp_preferences cwp
    where cwp.business_id = p_business_id and cwp.customer_id = v_conversation.customer_id;
    v_service_allowed := coalesce(v_service_allowed, false);
  end if;

  if not v_service_allowed then
    raise exception 'WHATSAPP_SERVICE_CONSENT_REQUIRED' using errcode = '42501';
  end if;

  if p_message_type = 'TEXT' then
    v_window_open := v_conversation.customer_service_window_ends_at is not null
      and v_conversation.customer_service_window_ends_at > now();
    if not v_window_open then
      raise exception 'WHATSAPP_SERVICE_WINDOW_CLOSED' using errcode = '42501';
    end if;
    if p_body_text is null or length(btrim(p_body_text)) < 1 or length(p_body_text) > 4096 then
      raise exception 'INVALID_MESSAGE_BODY' using errcode = '22023';
    end if;
  else
    if p_template_id is null then
      raise exception 'TEMPLATE_ID_REQUIRED' using errcode = '22023';
    end if;
    select wt.id, wt.provider_template_id, wt.name, wt.language, wt.category, wt.status, wt.whatsapp_account_id
    into v_template
    from public.whatsapp_templates wt
    where wt.id = p_template_id and wt.business_id = p_business_id;

    if v_template.id is null then
      raise exception 'TEMPLATE_NOT_FOUND' using errcode = '22023';
    end if;
    if v_template.whatsapp_account_id <> v_number.whatsapp_account_id then
      raise exception 'TEMPLATE_WRONG_ACCOUNT' using errcode = '42501';
    end if;
    if v_template.status <> 'APPROVED' then
      raise exception 'TEMPLATE_NOT_APPROVED' using errcode = '42501';
    end if;
    if v_template.category = 'MARKETING' then
      raise exception 'TEMPLATE_MARKETING_NOT_ALLOWED' using errcode = '42501';
    end if;
    if v_template.provider_template_id is null then
      raise exception 'TEMPLATE_NOT_SYNCED' using errcode = '22023';
    end if;
  end if;

  insert into public.whatsapp_messages (
    business_id, conversation_id, customer_id, branch_id, direction, message_type,
    client_creation_key, sender_user_id, sender_kind, template_id, body_text, status
  ) values (
    p_business_id, v_conversation.conversation_id, v_conversation.customer_id, v_conversation.branch_id,
    'OUTBOUND', p_message_type, p_client_creation_key, v_uid, 'STAFF',
    case when p_message_type = 'TEMPLATE' then p_template_id else null end,
    case when p_message_type = 'TEXT' then p_body_text else null end,
    'PENDING'
  )
  on conflict (business_id, client_creation_key) where client_creation_key is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    -- Lost a concurrent race for the same creation key — return the
    -- winner's row (and its already-created correlation), never a
    -- second one of either.
    select id into v_message_id
    from public.whatsapp_messages
    where business_id = p_business_id and client_creation_key = p_client_creation_key;
    v_is_new := false;
  else
    v_is_new := true;
  end if;

  -- WA-APP-02-R1: create this message's durable opaque callback
  -- correlation NOW — atomically, in the SAME transaction as the
  -- message row above, and therefore always durable before the caller
  -- can ever contact Meta. `on conflict do nothing` + the follow-up
  -- select is the SAME concurrency-safe pattern already used for the
  -- message row itself immediately above (INSERT ... ON CONFLICT DO
  -- NOTHING blocks until any concurrent inserter of the same
  -- whatsapp_message_id commits or aborts, so the subsequent plain
  -- SELECT is guaranteed to see exactly one row) — this guarantees
  -- exactly one token is ever created per message, even under a
  -- concurrent client_creation_key race.
  insert into private.whatsapp_outbound_provider_correlations (
    business_id, whatsapp_message_id, opaque_callback_token
  ) values (
    p_business_id, v_message_id, replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (whatsapp_message_id) do nothing;

  select c.opaque_callback_token into v_callback_token
  from private.whatsapp_outbound_provider_correlations c
  where c.whatsapp_message_id = v_message_id;

  return query
    select wm.id, v_is_new, wa.id, wpn.id, wpn.provider_phone_number_id, wc.customer_phone_e164,
           wt.provider_template_id, wt.name, wt.language, v_callback_token
    from public.whatsapp_messages wm
    join public.whatsapp_conversations wc on wc.id = wm.conversation_id
    join public.whatsapp_phone_numbers wpn on wpn.id = wc.whatsapp_phone_number_id
    join public.whatsapp_accounts wa on wa.id = wpn.whatsapp_account_id
    left join public.whatsapp_templates wt on wt.id = wm.template_id
    where wm.id = v_message_id;
end;
$$;

grant execute on function private.current_uid() to private_whatsapp_action_writer;
grant execute on function private.has_permission(uuid, text) to private_whatsapp_action_writer;

alter function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  owner to private_whatsapp_action_writer;
revoke all on function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  to authenticated;

-- ===========================================================================
-- repair_whatsapp_provider_bind — redefined (return shape unchanged,
-- so CREATE OR REPLACE is used here, unlike begin_whatsapp_outbound_message
-- above) to ALSO durably record the provider_message_id onto this
-- message's correlation row, in the SAME "durable-obligation-first,
-- outside any exception-catching block" position as the pre-existing
-- private.whatsapp_provider_bind_repairs upsert immediately below it —
-- this is now the ONE function that ever advances a correlation's
-- provider_message_id/state, whether called from the immediate
-- post-send path (lib/whatsapp/actions.ts) or from the callback-assisted
-- status-webhook path (ingest_and_process_whatsapp_status_event,
-- further below) on a later reconciliation. Every other line of this
-- function's original body (20260908080100) — the durable
-- whatsapp_provider_bind_repairs upsert, the conflict/idempotency
-- checks, the actual message bind, the audit event — is unchanged.
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

grant update (provider_message_id, state, resolved_at)
  on private.whatsapp_outbound_provider_correlations to private_whatsapp_provider_writer;

alter function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_whatsapp_provider_bind(uuid, uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- ingest_and_process_whatsapp_status_event — redefined (return shape
-- unchanged) to add one new optional parameter,
-- p_opaque_callback_token, and callback-assisted resolution as a
-- fallback when the direct provider_message_id lookup fails. RESOLUTION
-- ORDER (per this file's own header comment):
--   1. exact provider_message_id lookup (unchanged, original behavior);
--      if it succeeds AND a callback token was also supplied, a
--      defensive consistency check rejects (IGNORED, zero mutation) a
--      token that names a DIFFERENT local message than the one the
--      wamid itself resolved to — never overwrite/attach the wrong
--      message on inconsistent provider evidence.
--   2. only if (1) found nothing: resolve via the opaque correlation
--      table instead — requires provider = META_CLOUD AND the
--      correlation's OWN business_id to equal p_business_id (the
--      tenant this webhook's provider phone number itself resolved to)
--      — any mismatch is a cross-tenant anomaly, classified IGNORED,
--      zero mutation, never trusted.
--   3. otherwise: unresolved — IGNORED, exactly the original,
--      unmodified WA-APP-01 behavior.
-- Binding a callback-resolved wamid reuses
-- public.repair_whatsapp_provider_bind — the SAME trusted, conflict-
-- safe, tenant-checked path the immediate post-send bind uses, so no
-- second, separately-trusted mutation surface exists. A
-- WHATSAPP_PROVIDER_BIND_CONFLICT raised by that call (a genuine,
-- permanent conflict — never resolvable by retrying) is classified
-- IGNORED here, not FAILED_RETRYABLE — Meta's own retry can never fix a
-- permanent conflict, so it must never be retried forever.
-- ===========================================================================
-- Adding p_opaque_callback_token changes the argument list, so
-- CREATE OR REPLACE would leave the OLD 8-argument overload in place
-- alongside this new 9-argument one (PostgreSQL treats a different
-- parameter list as a distinct overloaded function, never an implicit
-- replacement) — the old signature is dropped explicitly first, exactly
-- like begin_whatsapp_outbound_message's own identical drop above.
drop function if exists public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text);

create function public.ingest_and_process_whatsapp_status_event(
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
        end if;
        -- v_bind_resolved = false: a transient failure INSIDE the bind
        -- attempt itself (Postgres WAS reached this time) — fall
        -- through to the normal "unresolved" IGNORED path below rather
        -- than raising into the generic FAILED_RETRYABLE handler,
        -- since repair_whatsapp_provider_bind's own internal exception
        -- handling already recorded that failure durably on the repair
        -- row itself; a future webhook replay (Meta's own retry) will
        -- attempt the callback-assisted bind again from a clean slate.
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

alter function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text, text)
  owner to private_whatsapp_provider_writer;
revoke all on function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_and_process_whatsapp_status_event(text, text, uuid, uuid, text, text, timestamptz, text, text)
  to service_role;

-- ===========================================================================
-- get_whatsapp_outbound_message_reconciliation_state — extended
-- (return shape widens, so drop + create) with two more diagnostic-only
-- fields describing the correlation itself, for admin/operational
-- visibility into the residual "Meta accepted, immediate bind never
-- reached Postgres, and no status webhook has arrived yet" state — see
-- this file's own header comment on the documented, acceptable residual
-- behavior. Purely additive read-only surface — no new mutation.
-- ===========================================================================
drop function if exists public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid);

create function public.get_whatsapp_outbound_message_reconciliation_state(
  p_message_id  uuid,
  p_business_id uuid
)
returns table (
  bound_provider_message_id    text,
  has_pending_repair           boolean,
  pending_provider_message_id  text,
  correlation_state            text,
  correlation_token_exists     boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    wm.provider_message_id,
    r.status = 'PENDING',
    r.provider_message_id,
    c.state,
    c.id is not null
  from public.whatsapp_messages wm
  left join private.whatsapp_provider_bind_repairs r
    on r.whatsapp_message_id = wm.id and r.business_id = wm.business_id
  left join private.whatsapp_outbound_provider_correlations c
    on c.whatsapp_message_id = wm.id and c.business_id = wm.business_id
  where wm.id = p_message_id and wm.business_id = p_business_id;
$$;

alter function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_whatsapp_outbound_message_reconciliation_state(uuid, uuid)
  to service_role;

revoke create on schema public from private_whatsapp_provider_writer;
revoke create on schema public from private_whatsapp_action_writer;

-- ===========================================================================
-- DOCUMENTATION VERIFICATION NOTE (per this remediation's own explicit
-- "verify current Meta Cloud API support and exact webhook field shape
-- before implementing — do not assume blindly" instruction):
--
-- `biz_opaque_callback_data` is a real, documented Meta WhatsApp Cloud
-- API field: a top-level string field on the outbound
-- POST /{phone_number_id}/messages request body (sibling of
-- `messaging_product`/`to`/`type`/`text`|`template`), historically
-- raised from a 256- to a 512-character maximum, whose value Meta
-- echoes back verbatim on the corresponding message-status webhook
-- object. This application only ever sends its own internally
-- generated, meaningless-outside-BusinessOS 32-hex-character token in
-- it (well under the 512-character limit) and only ever reads it back
-- from the signed status webhook — never trusts it as anything more
-- than a correlation lookup key (see repair_whatsapp_provider_bind's
-- and ingest_and_process_whatsapp_status_event's own tenant/conflict
-- checks above). Automated documentation fetching in this environment
-- could not render Meta's own JS-driven reference pages far enough to
-- quote the exact current-dated field table; this implementation
-- therefore treats the field's existence, request-body placement, and
-- status-webhook echo-back behavior as verified from multiple
-- independent secondary sources plus this codebase's own prior
-- training-data familiarity with the Cloud API, but flags a residual
-- UNKNOWN — a final live confirmation against the target Meta API
-- version in the Graph API Explorer (or a real sandbox send) before
-- production traffic remains a recommended follow-up, not yet
-- independently proven inside this session.
-- ===========================================================================
