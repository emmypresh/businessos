-- Phase 1M: WhatsApp + Customer Communication — APPLICATION / PROVIDER
-- LAYER. Additive migration on top of the frozen Phase 1M DB foundation
-- (20260907080000/080100/080200_*.sql, commit d3a2d3a — treated as
-- FROZEN and NOT modified by this file). Adds the narrow, validated
-- write primitives the new webhook route and outbound-send Server
-- Action need; no frozen table/function/grant is altered, only new
-- functions and new, narrowly-scoped grants are added.
--
-- INTERIM SINGLE-TENANT PROVIDER CONFIGURATION: the frozen foundation
-- intentionally has no encrypted per-business credential storage, so
-- this round cannot support real multi-tenant Meta Embedded Signup.
-- Exactly one BusinessOS business (public.businesses.id =
-- WHATSAPP_CONTROLLED_BUSINESS_ID, a server environment variable) may be
-- connected to the one Meta WABA/phone number configured via server
-- environment variables in this interim round — see
-- lib/whatsapp/config.ts. Per-business encrypted credential onboarding
-- remains a separately reviewed future subphase.
--
-- WRITER ARCHITECTURE — mirrors this codebase's own established
-- SECURITY DEFINER / narrow-role precedent exactly (private_billing_*,
-- private_whatsapp_provider_writer/private_whatsapp_action_writer from
-- the frozen foundation): every function below is `set search_path =
-- ''`, fully schema-qualified, static SQL, owned by one of the two
-- ALREADY-EXISTING narrow roles from the frozen foundation (no new role
-- is created), with `revoke all ... from public, anon, authenticated,
-- service_role` before any narrower grant. Functions reached ONLY by the
-- server webhook handler / outbound-send admin client (service-role
-- identity, after independent signature/authorization checks already
-- performed in application code) are granted EXECUTE to `service_role`
-- ONLY, never to `authenticated`/`anon`/PUBLIC. Functions that are
-- themselves a user/staff action (the outbound send) are granted
-- EXECUTE to `authenticated` ONLY, gated by their own internal
-- `whatsapp.send` check — exactly like record_customer_whatsapp_consent.
--
-- No function here grants raw table INSERT/UPDATE to service_role — the
-- writer role's own table grants stay the only path, and service_role
-- itself only ever gets EXECUTE on these specific wrapper functions.

-- ===========================================================================
-- Additional narrow grants for private_whatsapp_provider_writer: bind
-- provider_message_id (frozen writer migration granted UPDATE on
-- status/*_at/failure_reason only — provider_message_id was correctly
-- left out because no writer needed it yet). Also needs INSERT/UPDATE on
-- whatsapp_accounts/whatsapp_phone_numbers/whatsapp_conversations/
-- whatsapp_messages/whatsapp_templates for the new functions below.
-- ===========================================================================
grant update (provider_message_id) on public.whatsapp_messages to private_whatsapp_provider_writer;
grant insert, update (
  provider_business_account_id, display_name, status, connected_at, disconnected_at
) on public.whatsapp_accounts to private_whatsapp_provider_writer;
grant select (id, business_id, provider_business_account_id, status, created_at)
  on public.whatsapp_accounts to private_whatsapp_provider_writer;
grant insert, update (provider_phone_number_id, display_phone_number, status, is_primary)
  on public.whatsapp_phone_numbers to private_whatsapp_provider_writer;
grant select (id, business_id, whatsapp_account_id, branch_id, provider_phone_number_id, created_at)
  on public.whatsapp_phone_numbers to private_whatsapp_provider_writer;
grant insert, update (customer_id, status, last_inbound_at, last_message_at, customer_service_window_ends_at)
  on public.whatsapp_conversations to private_whatsapp_provider_writer;
grant select (id, business_id, branch_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status, customer_service_window_ends_at)
  on public.whatsapp_conversations to private_whatsapp_provider_writer;
grant insert on public.whatsapp_messages to private_whatsapp_provider_writer;
grant select (id, business_id, conversation_id, provider_message_id, status)
  on public.whatsapp_messages to private_whatsapp_provider_writer;
grant insert, update (provider_template_id, status, category, language, body_snapshot)
  on public.whatsapp_templates to private_whatsapp_provider_writer;
grant select (id, business_id, whatsapp_account_id, provider_template_id, name, language)
  on public.whatsapp_templates to private_whatsapp_provider_writer;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_whatsapp_provider_writer;
grant execute on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) to private_whatsapp_provider_writer;
grant execute on function private.resolve_active_members_with_permission(uuid, text)
  to private_whatsapp_provider_writer;

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on
-- the function's own schema (public) — granted narrowly here, exactly
-- like the frozen foundation's own identical `grant create on schema
-- private to private_whatsapp_provider_writer` precedent
-- (20260907080200_whatsapp_permissions_and_private_writer.sql), and
-- revoked again once every ownership change below is complete.
grant create on schema public to private_whatsapp_provider_writer;
grant create on schema public to private_whatsapp_action_writer;

-- ===========================================================================
-- ingest_whatsapp_webhook_event: a PUBLIC-schema wrapper over the
-- frozen private.record_whatsapp_webhook_event. Required because
-- PostgREST (and therefore supabase-js's own `.rpc()`, which the
-- webhook route uses) only ever exposes functions in the `public`
-- schema — `private.*` functions are reachable only via a raw SQL
-- connection (as this codebase's own test helpers already do) or, as
-- here, via a thin public wrapper that does nothing beyond forwarding
-- arguments. No additional logic, no additional trust — reachable only
-- from the webhook route, running as service_role, AFTER that route has
-- independently verified the Meta webhook signature.
-- ===========================================================================
create or replace function public.ingest_whatsapp_webhook_event(
  p_provider                  text,
  p_provider_event_key        text,
  p_event_type                text,
  p_payload_sha256            text,
  p_business_id               uuid default null,
  p_whatsapp_phone_number_id  uuid default null,
  p_message_id                uuid default null
)
returns table (id uuid, is_new boolean)
language sql
security definer
set search_path = ''
as $$
  select * from private.record_whatsapp_webhook_event(
    p_provider, p_provider_event_key, p_event_type, p_payload_sha256,
    p_business_id, p_whatsapp_phone_number_id, p_message_id
  );
$$;

alter function public.ingest_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.ingest_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)
  to service_role;

-- ===========================================================================
-- upsert_meta_whatsapp_account: server-authoritative account
-- connect/reconnect/disconnect. Only ever called for the ONE
-- WHATSAPP_CONTROLLED_BUSINESS_ID business in this interim round — the
-- caller (lib/whatsapp/actions.ts) enforces that; this function itself
-- additionally never lets provider_business_account_id belong to more
-- than one business (relies on the frozen `unique (provider,
-- provider_business_account_id)` constraint — a genuine cross-business
-- collision surfaces as a normal Postgres unique-violation error).
-- ===========================================================================
create or replace function public.upsert_meta_whatsapp_account(
  p_business_id                 uuid,
  p_provider_business_account_id text,
  p_status                       text,
  p_actor_user_id                uuid,
  p_display_name                 text default null,
  p_created_by                   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id           uuid;
  v_prev_status  text;
begin
  if p_business_id is null or p_provider_business_account_id is null or p_status is null then
    raise exception 'p_business_id, p_provider_business_account_id, and p_status are required' using errcode = '22023';
  end if;
  if p_status not in ('CONNECTED', 'DISCONNECTED', 'SUSPENDED') then
    raise exception 'INVALID_WHATSAPP_ACCOUNT_STATUS' using errcode = '22023';
  end if;

  select id, status into v_id, v_prev_status
  from public.whatsapp_accounts
  where business_id = p_business_id
  order by created_at asc
  limit 1
  for update;

  if v_id is null then
    insert into public.whatsapp_accounts (
      business_id, provider, provider_business_account_id, display_name, status,
      connected_at, created_by
    ) values (
      p_business_id, 'META_CLOUD', p_provider_business_account_id, p_display_name, p_status,
      case when p_status = 'CONNECTED' then now() else null end,
      coalesce(p_created_by, p_actor_user_id)
    )
    returning id into v_id;
    v_prev_status := null;
  else
    update public.whatsapp_accounts
    set provider_business_account_id = p_provider_business_account_id,
        display_name = coalesce(p_display_name, display_name),
        status = p_status,
        connected_at = case when p_status = 'CONNECTED' and v_prev_status <> 'CONNECTED' then now() else connected_at end,
        disconnected_at = case when p_status = 'DISCONNECTED' and v_prev_status <> 'DISCONNECTED' then now() else disconnected_at end
    where id = v_id;
  end if;

  if p_status = 'CONNECTED' and v_prev_status is distinct from 'CONNECTED' then
    perform private.record_audit_event(
      p_business_id, 'USER', p_actor_user_id, 'whatsapp.account_connected', 'ORGANIZATION',
      null, null, null, 'whatsapp_accounts', v_id, null, 'SUCCESS',
      jsonb_build_object('provider', 'META_CLOUD')
    );
  elsif p_status = 'DISCONNECTED' and v_prev_status is distinct from 'DISCONNECTED' then
    perform private.record_audit_event(
      p_business_id, 'USER', p_actor_user_id, 'whatsapp.account_disconnected', 'ORGANIZATION',
      null, null, null, 'whatsapp_accounts', v_id, null, 'SUCCESS',
      jsonb_build_object('provider', 'META_CLOUD')
    );
    -- Useful-only notification (this phase's own explicit instruction):
    -- a disconnect is exactly the kind of permanent-failure-adjacent
    -- event worth surfacing — never sent/delivered/read, never every
    -- inbound message. Deduplicated by account id + status so a
    -- redundant disconnect call never re-notifies.
    perform private.create_notification(
      p_business_id, 'ORGANIZATION', 'whatsapp.account_disconnected', 'WhatsApp disconnected',
      private.resolve_active_members_with_permission(p_business_id, 'whatsapp.manage'),
      null, 'Your WhatsApp connection was disconnected. Reconnect to resume messaging.', 'WARNING',
      'whatsapp_accounts', v_id, '{}'::jsonb, 'whatsapp.account_disconnected:' || v_id::text
    );
  end if;

  return v_id;
end;
$$;

alter function public.upsert_meta_whatsapp_account(uuid, text, text, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.upsert_meta_whatsapp_account(uuid, text, text, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_meta_whatsapp_account(uuid, text, text, uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- upsert_meta_whatsapp_phone_number: registers/updates the ONE
-- configured provider phone number for a whatsapp_account. Cross-tenant
-- reuse of the same provider_phone_number_id is prevented by the frozen
-- `unique (provider_phone_number_id)` constraint.
-- ===========================================================================
create or replace function public.upsert_meta_whatsapp_phone_number(
  p_business_id               uuid,
  p_whatsapp_account_id       uuid,
  p_provider_phone_number_id  text,
  p_display_phone_number      text,
  p_is_primary                boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_business_id is null or p_whatsapp_account_id is null
     or p_provider_phone_number_id is null or p_display_phone_number is null then
    raise exception 'p_business_id, p_whatsapp_account_id, p_provider_phone_number_id, and p_display_phone_number are required'
      using errcode = '22023';
  end if;

  select id into v_id
  from public.whatsapp_phone_numbers
  where business_id = p_business_id and whatsapp_account_id = p_whatsapp_account_id
  order by created_at asc
  limit 1
  for update;

  if v_id is null then
    insert into public.whatsapp_phone_numbers (
      business_id, whatsapp_account_id, provider_phone_number_id, display_phone_number, status, is_primary
    ) values (
      p_business_id, p_whatsapp_account_id, p_provider_phone_number_id, p_display_phone_number, 'ACTIVE', p_is_primary
    )
    returning id into v_id;
  else
    update public.whatsapp_phone_numbers
    set provider_phone_number_id = p_provider_phone_number_id,
        display_phone_number = p_display_phone_number,
        status = 'ACTIVE'
    where id = v_id;
  end if;

  return v_id;
end;
$$;

alter function public.upsert_meta_whatsapp_phone_number(uuid, uuid, text, text, boolean)
  owner to private_whatsapp_provider_writer;
revoke all on function public.upsert_meta_whatsapp_phone_number(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_meta_whatsapp_phone_number(uuid, uuid, text, text, boolean)
  to service_role;

-- ===========================================================================
-- record_inbound_whatsapp_message: the trusted inbound pipeline
-- primitive. Everything this function trusts (business_id,
-- whatsapp_phone_number_id, provider_timestamp) has ALREADY been
-- resolved server-side from verified webhook metadata before this is
-- called — no argument here is browser-reachable. Idempotent on
-- provider_message_id (unique constraint) and safe under concurrent
-- duplicate delivery (the ON CONFLICT branches below rely on the
-- frozen partial unique indexes, which serialize concurrent inserts for
-- the identical logical conversation/message).
-- ===========================================================================
create or replace function public.record_inbound_whatsapp_message(
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
returns table (message_id uuid, conversation_id uuid, is_new boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_message_id      uuid;
  v_window_hours     constant int := 24; -- Meta's standard customer service window.
begin
  if p_business_id is null or p_whatsapp_phone_number_id is null
     or p_customer_phone_e164 is null or p_provider_message_id is null or p_message_type is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_customer_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'INVALID_PHONE_E164' using errcode = '22023';
  end if;

  -- Idempotency fast-path: if this exact provider message was already
  -- ingested, return it untouched — no conversation/window mutation on
  -- a replay.
  select wm.id, wm.conversation_id into v_message_id, v_conversation_id
  from public.whatsapp_messages wm
  where wm.provider_message_id = p_provider_message_id;

  if v_message_id is not null then
    return query select v_message_id, v_conversation_id, false;
    return;
  end if;

  if p_customer_id is not null then
    insert into public.whatsapp_conversations (
      business_id, branch_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status
    ) values (
      p_business_id, p_branch_id, p_customer_id, p_whatsapp_phone_number_id, p_customer_phone_e164, 'OPEN'
    )
    on conflict (business_id, customer_id, whatsapp_phone_number_id) where status = 'OPEN' and customer_id is not null
    do nothing
    returning id into v_conversation_id;

    if v_conversation_id is null then
      select id into v_conversation_id
      from public.whatsapp_conversations
      where business_id = p_business_id and customer_id = p_customer_id
        and whatsapp_phone_number_id = p_whatsapp_phone_number_id and status = 'OPEN'
      for update;
    end if;
  else
    insert into public.whatsapp_conversations (
      business_id, branch_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status
    ) values (
      p_business_id, p_branch_id, null, p_whatsapp_phone_number_id, p_customer_phone_e164, 'OPEN'
    )
    on conflict (business_id, whatsapp_phone_number_id, customer_phone_e164) where status = 'OPEN' and customer_id is null
    do nothing
    returning id into v_conversation_id;

    if v_conversation_id is null then
      select id into v_conversation_id
      from public.whatsapp_conversations
      where business_id = p_business_id and customer_id is null
        and whatsapp_phone_number_id = p_whatsapp_phone_number_id
        and customer_phone_e164 = p_customer_phone_e164 and status = 'OPEN'
      for update;
    end if;
  end if;

  if v_conversation_id is null then
    raise exception 'WHATSAPP_CONVERSATION_RESOLUTION_FAILED' using errcode = '22023';
  end if;

  insert into public.whatsapp_messages (
    business_id, conversation_id, customer_id, branch_id, direction, message_type,
    provider_message_id, sender_kind, body_text, status
  ) values (
    p_business_id, v_conversation_id, p_customer_id, p_branch_id, 'INBOUND',
    case when p_message_type in ('TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'LOCATION', 'CONTACT', 'INTERACTIVE') then p_message_type else 'UNKNOWN' end,
    p_provider_message_id, 'CUSTOMER', p_body_text, 'DELIVERED'
  )
  on conflict (provider_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    -- Lost a concurrent race to an identical provider_message_id —
    -- another call already inserted it; return that row, not a
    -- duplicate.
    select wm.id, wm.conversation_id into v_message_id, v_conversation_id
    from public.whatsapp_messages wm where wm.provider_message_id = p_provider_message_id;
    return query select v_message_id, v_conversation_id, false;
    return;
  end if;

  update public.whatsapp_conversations
  set last_inbound_at = coalesce(p_provider_timestamp, now()),
      last_message_at = coalesce(p_provider_timestamp, now()),
      customer_service_window_ends_at = coalesce(p_provider_timestamp, now()) + make_interval(hours => v_window_hours)
  where id = v_conversation_id;

  -- Restrained metadata only: never the message body or full phone
  -- number — see this migration's own header comment and this phase's
  -- own explicit audit instructions.
  perform private.record_audit_event(
    p_business_id, 'SYSTEM', null, 'whatsapp.inbound_received', 'CUSTOMER',
    p_branch_id, null, null, 'whatsapp_messages', v_message_id, null, 'SUCCESS',
    jsonb_build_object('message_type', p_message_type, 'matched_customer', p_customer_id is not null)
  );

  return query select v_message_id, v_conversation_id, true;
end;
$$;

alter function public.record_inbound_whatsapp_message(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  owner to private_whatsapp_provider_writer;
revoke all on function public.record_inbound_whatsapp_message(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_inbound_whatsapp_message(uuid, uuid, text, text, text, uuid, uuid, text, timestamptz)
  to service_role;

-- ===========================================================================
-- bind_outbound_provider_message_id: after Meta's synchronous send API
-- response accepts a message, binds the returned wamid and advances
-- status to ACCEPTED via the existing frozen monotonic status writer.
-- ===========================================================================
create or replace function public.bind_outbound_provider_message_id(
  p_message_id          uuid,
  p_business_id         uuid,
  p_provider_message_id text,
  p_actor_user_id       uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_message_id is null or p_business_id is null or p_provider_message_id is null or p_actor_user_id is null then
    raise exception 'p_message_id, p_business_id, p_provider_message_id, and p_actor_user_id are required' using errcode = '22023';
  end if;

  update public.whatsapp_messages
  set provider_message_id = p_provider_message_id
  where id = p_message_id and business_id = p_business_id and provider_message_id is null;

  if not found then
    raise exception 'WHATSAPP_MESSAGE_NOT_FOUND_OR_ALREADY_BOUND' using errcode = '22023';
  end if;

  perform private.record_whatsapp_message_status_event(p_message_id, p_business_id, 'ACCEPTED', now(), null);

  -- Actor USER: this binds a message a staff member (or the send
  -- action's own server-side flow, acting on their behalf) just sent.
  -- Restrained metadata only — never the message body or destination
  -- phone number.
  perform private.record_audit_event(
    p_business_id, 'USER', p_actor_user_id, 'whatsapp.message_sent', 'CUSTOMER',
    null, null, null, 'whatsapp_messages', p_message_id, null, 'SUCCESS', '{}'::jsonb
  );
end;
$$;

alter function public.bind_outbound_provider_message_id(uuid, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.bind_outbound_provider_message_id(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_outbound_provider_message_id(uuid, uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- sync_whatsapp_template: server-only provider-template cache upsert.
-- Provider is the sole source of truth for status/category/language —
-- see whatsapp_templates' own frozen header comment. Scoped by
-- (whatsapp_account_id, provider_template_id) exactly like the frozen
-- unique index.
-- ===========================================================================
create or replace function public.sync_whatsapp_template(
  p_business_id          uuid,
  p_whatsapp_account_id  uuid,
  p_provider_template_id text,
  p_name                 text,
  p_language             text,
  p_category             text,
  p_status               text,
  p_body_snapshot        text default null,
  p_actor_user_id        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_business_id is null or p_whatsapp_account_id is null or p_provider_template_id is null
     or p_name is null or p_language is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_category not in ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'UNKNOWN') then
    raise exception 'INVALID_TEMPLATE_CATEGORY' using errcode = '22023';
  end if;
  if p_status not in ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN') then
    raise exception 'INVALID_TEMPLATE_STATUS' using errcode = '22023';
  end if;

  insert into public.whatsapp_templates (
    business_id, whatsapp_account_id, provider_template_id, name, language, category, status, body_snapshot
  ) values (
    p_business_id, p_whatsapp_account_id, p_provider_template_id, p_name, p_language, p_category, p_status, p_body_snapshot
  )
  on conflict (whatsapp_account_id, provider_template_id) where provider_template_id is not null
  do update set
    name = excluded.name,
    language = excluded.language,
    category = excluded.category,
    status = excluded.status,
    body_snapshot = excluded.body_snapshot
  returning id into v_id;

  perform private.record_audit_event(
    p_business_id, 'USER', p_actor_user_id, 'whatsapp.template_synced', 'ORGANIZATION',
    null, null, null, 'whatsapp_templates', v_id, null, 'SUCCESS',
    jsonb_build_object('status', p_status, 'category', p_category)
  );

  return v_id;
end;
$$;

alter function public.sync_whatsapp_template(uuid, uuid, text, text, text, text, text, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.sync_whatsapp_template(uuid, uuid, text, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_whatsapp_template(uuid, uuid, text, text, text, text, text, text, uuid)
  to service_role;

-- ===========================================================================
-- begin_whatsapp_outbound_message — the ONE reachable user-facing send
-- primitive. Mirrors record_customer_whatsapp_consent's own architecture
-- exactly: SECURITY DEFINER, EXECUTE granted to `authenticated` only,
-- gated entirely by its own internal whatsapp.send check plus every
-- consent/window/template rule this phase requires. Re-reads EVERYTHING
-- server-side (conversation, customer, phone/account identity, consent,
-- window, template approval) — the caller (lib/whatsapp/actions.ts)
-- passes only business/conversation/message-content/client-creation-key,
-- never a destination phone, provider id, or any authorization/consent/
-- window/template state.
--
-- Idempotent on (business_id, client_creation_key): a retried call with
-- the same key returns the EXISTING row (is_new = false) without
-- creating a second PENDING message or re-validating consent/window
-- again — Meta is contacted by the caller (lib/whatsapp/actions.ts)
-- ONLY when is_new = true, which is what prevents a double provider
-- send under a client retry/race.
-- ===========================================================================
create or replace function public.begin_whatsapp_outbound_message(
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
  template_language         text
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
    -- identity/provider fields are returned as-is, with zero re-checks
    -- of consent/window/template (a legitimate retry of an
    -- already-accepted request must never be re-evaluated against
    -- state that may have since changed).
    return query
      select wm.id, false, wa.id, wpn.id, wpn.provider_phone_number_id, wc.customer_phone_e164,
             wt.provider_template_id, wt.name, wt.language
      from public.whatsapp_messages wm
      join public.whatsapp_conversations wc on wc.id = wm.conversation_id
      join public.whatsapp_phone_numbers wpn on wpn.id = wc.whatsapp_phone_number_id
      join public.whatsapp_accounts wa on wa.id = wpn.whatsapp_account_id
      left join public.whatsapp_templates wt on wt.id = wm.template_id
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
  -- else. This is a hard gate for EVERY outbound send in this MVP
  -- (TEXT and TEMPLATE both require it — this application builds no
  -- separate marketing-authorized path in this round).
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
    -- winner's row, never a second one.
    select id into v_message_id
    from public.whatsapp_messages
    where business_id = p_business_id and client_creation_key = p_client_creation_key;
    v_is_new := false;
  else
    v_is_new := true;
  end if;

  return query
    select wm.id, v_is_new, wa.id, wpn.id, wpn.provider_phone_number_id, wc.customer_phone_e164,
           wt.provider_template_id, wt.name, wt.language
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
grant select (id, business_id) on public.whatsapp_accounts to private_whatsapp_action_writer;
grant select (id, business_id, customer_id, branch_id, whatsapp_phone_number_id, customer_phone_e164, customer_service_window_ends_at)
  on public.whatsapp_conversations to private_whatsapp_action_writer;
grant select (id, business_id, whatsapp_account_id, provider_phone_number_id, status)
  on public.whatsapp_phone_numbers to private_whatsapp_action_writer;
grant select (id, business_id, provider_template_id, name, language, category, status, whatsapp_account_id)
  on public.whatsapp_templates to private_whatsapp_action_writer;
grant select (business_id, customer_id, service_messages_allowed) on public.customer_whatsapp_preferences to private_whatsapp_action_writer;
grant insert on public.whatsapp_messages to private_whatsapp_action_writer;
grant select (id, business_id, conversation_id, client_creation_key, template_id) on public.whatsapp_messages to private_whatsapp_action_writer;

alter function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  owner to private_whatsapp_action_writer;
revoke all on function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.begin_whatsapp_outbound_message(uuid, uuid, text, text, uuid, text)
  to authenticated;

-- ===========================================================================
-- fail_whatsapp_outbound_message: synchronous provider-rejection path
-- (step 10 of the outbound creation order — "if provider call fails
-- synchronously: transition local pending message to FAILED"). Reuses
-- the existing frozen monotonic status writer so the same terminal-state
-- rules apply uniformly regardless of whether FAILED arrived via a
-- webhook or a synchronous send failure.
-- ===========================================================================
create or replace function public.fail_whatsapp_outbound_message(
  p_message_id      uuid,
  p_business_id     uuid,
  p_failure_reason  text,
  p_actor_user_id   uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if p_message_id is null or p_business_id is null or p_actor_user_id is null then
    raise exception 'p_message_id, p_business_id, and p_actor_user_id are required' using errcode = '22023';
  end if;
  v_reason := left(coalesce(p_failure_reason, 'Provider rejected the message.'), 300);
  perform private.record_whatsapp_message_status_event(p_message_id, p_business_id, 'FAILED', now(), v_reason);

  -- Bounded, sanitized reason only — never the raw provider error object
  -- (see this migration's own header comment and the frozen schema's own
  -- 300-char failure_reason bound).
  perform private.record_audit_event(
    p_business_id, 'USER', p_actor_user_id, 'whatsapp.message_failed', 'CUSTOMER',
    null, null, null, 'whatsapp_messages', p_message_id, null, 'FAILED',
    jsonb_build_object('reason', v_reason)
  );
end;
$$;

alter function public.fail_whatsapp_outbound_message(uuid, uuid, text, uuid)
  owner to private_whatsapp_provider_writer;
revoke all on function public.fail_whatsapp_outbound_message(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_whatsapp_outbound_message(uuid, uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- record_whatsapp_provider_message_status: the webhook route's own entry
-- point for a Meta message-status event (sent/delivered/read/failed).
-- Thin wrapper over the frozen private.record_whatsapp_message_status_event
-- (monotonic projection, append-only history) that additionally raises a
-- useful-only notification on a PERMANENT (FAILED) outcome — never on
-- sent/delivered/read, per this phase's own explicit "notify only on
-- useful permanent failures" instruction. Deduplicated by message id (a
-- given message can only ever permanently fail once in a way worth a
-- fresh notification).
-- ===========================================================================
create or replace function public.record_whatsapp_provider_message_status(
  p_message_id          uuid,
  p_business_id         uuid,
  p_status              text,
  p_provider_timestamp  timestamptz default null,
  p_failure_reason      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_message_id is null or p_business_id is null or p_status is null then
    raise exception 'p_message_id, p_business_id, and p_status are required' using errcode = '22023';
  end if;

  perform private.record_whatsapp_message_status_event(p_message_id, p_business_id, p_status, p_provider_timestamp, p_failure_reason);

  if p_status = 'FAILED' then
    perform private.create_notification(
      p_business_id, 'CUSTOMER', 'whatsapp.message_failed', 'WhatsApp message failed to deliver',
      private.resolve_active_members_with_permission(p_business_id, 'whatsapp.send'),
      null, 'A WhatsApp message could not be delivered.', 'WARNING',
      'whatsapp_messages', p_message_id, '{}'::jsonb, 'whatsapp.message_failed:' || p_message_id::text
    );
  end if;
end;
$$;

alter function public.record_whatsapp_provider_message_status(uuid, uuid, text, timestamptz, text)
  owner to private_whatsapp_provider_writer;
revoke all on function public.record_whatsapp_provider_message_status(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_provider_message_status(uuid, uuid, text, timestamptz, text)
  to service_role;

revoke create on schema public from private_whatsapp_provider_writer;
revoke create on schema public from private_whatsapp_action_writer;
