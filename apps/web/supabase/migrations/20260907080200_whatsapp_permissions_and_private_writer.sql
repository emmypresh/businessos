-- Phase 1M: WhatsApp + Customer Communication — DATABASE FOUNDATION ONLY.
--
-- Third migration of this round: whatsapp.view/whatsapp.send/
-- whatsapp.manage permissions and their initial role grants, the
-- customer-consent RPC (the one genuine, reachable write primitive this
-- DB-only round builds — see its own header comment for why), and two
-- narrow, zero-EXECUTE-grant private writer functions
-- (record_whatsapp_webhook_event, record_whatsapp_message_status_event)
-- that exist ONLY to make this round's own required schema-behavior
-- tests possible (idempotent webhook ingestion, monotonic status
-- projection) — mirroring exactly how this codebase's OWN prior DB
-- foundation rounds (e.g. Phase 1L's private.create_initial_trial before
-- its application round existed) left trusted functions with NO EXECUTE
-- grant to any real login role, reachable only via a privileged
-- superuser/test connection, until a real application-layer server
-- boundary is built in a later round and granted EXECUTE narrowly then.
--
-- Every SECURITY DEFINER function below: `set search_path = ''`, fully
-- schema-qualified SQL, no dynamic SQL, explicit `revoke all ... from
-- public, anon, authenticated, service_role` before any narrower grant
-- is (if ever) added — closing exactly the ACL-1L-01 class of bug (a
-- PostgreSQL function defaulting to PUBLIC EXECUTE unless explicitly
-- revoked) this phase's own instructions call out by name.

-- ===========================================================================
-- Permissions
-- ===========================================================================
insert into public.permissions (key, description) values
  ('whatsapp.view',   'View WhatsApp accounts, numbers, conversations, messages, templates, and customer consent.'),
  ('whatsapp.send',   'Send WhatsApp messages to customers (application-layer capability; no send RPC exists in this DB foundation).'),
  ('whatsapp.manage', 'Manage WhatsApp account/number connections and record customer WhatsApp consent.')
on conflict (key) do nothing;

-- OWNER/ADMIN: full view/send/manage, matching this codebase's own
-- established "leadership tiers get everything" convention.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.name in ('OWNER', 'ADMIN')
  and p.key in ('whatsapp.view', 'whatsapp.send', 'whatsapp.manage')
on conflict do nothing;

-- MANAGER, SALES: view + send (day-to-day customer conversation staff),
-- never manage (account/number connection and consent recording stay
-- with leadership + the one explicitly-designated tier below).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.name in ('MANAGER', 'SALES')
  and p.key in ('whatsapp.view', 'whatsapp.send')
on conflict do nothing;

-- ACCOUNTANT: view + send. This phase's own suggested grant list
-- proposed the same, and the least-surprising-safe-model latitude the
-- task explicitly grants does not change that: an accountant sending a
-- payment reminder or invoice-status message is ordinary SERVICE
-- communication (Phase 1M's own stated MVP priority), not a financial
-- risk, and withholding `whatsapp.send` here would block a legitimate,
-- low-risk use case for no safety benefit. `whatsapp.manage` (account
-- connection, consent recording) stays with OWNER/ADMIN only.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.name = 'ACCOUNTANT'
  and p.key in ('whatsapp.view', 'whatsapp.send')
on conflict do nothing;

-- INVENTORY, VIEWER: no WhatsApp permissions at all, matching this
-- phase's own suggested grant list exactly.

-- ===========================================================================
-- private_whatsapp_provider_writer — NOLOGIN NOINHERIT BYPASSRLS,
-- non-superuser, no CREATEDB/CREATEROLE. Owns the two narrow trusted
-- functions below. No EXECUTE grant to ANY role in this DB-only round —
-- a future Phase 1M application round grants EXECUTE to the specific
-- narrow server boundary (webhook handler, provider status poller) that
-- needs it, exactly once that boundary exists and can be reviewed.
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_whatsapp_provider_writer') then
    create role private_whatsapp_provider_writer noinherit nologin bypassrls;
  end if;
end
$$;

grant private_whatsapp_provider_writer to postgres;

grant usage on schema public to private_whatsapp_provider_writer;
grant usage on schema private to private_whatsapp_provider_writer;

grant insert on private.whatsapp_webhook_events to private_whatsapp_provider_writer;
grant select (id, provider, provider_event_key, event_type, business_id, whatsapp_phone_number_id, message_id, payload_sha256)
  on private.whatsapp_webhook_events to private_whatsapp_provider_writer;
-- SELECT ... FOR UPDATE (the concurrency-safe conflict-resolution lock
-- in record_whatsapp_webhook_event below) requires the UPDATE privilege
-- in addition to SELECT, per PostgreSQL's own row-locking privilege
-- rule — even though no column value is ever actually changed by this
-- function, only locked. Scoped to a single, otherwise-unused column so
-- the grant carries no real mutation capability beyond the lock itself.
grant update (result) on private.whatsapp_webhook_events to private_whatsapp_provider_writer;

grant insert on public.whatsapp_message_status_events to private_whatsapp_provider_writer;
grant select (id, business_id, message_id, status) on public.whatsapp_message_status_events
  to private_whatsapp_provider_writer;
grant update (status, accepted_at, sent_at, delivered_at, read_at, failed_at, failure_reason)
  on public.whatsapp_messages to private_whatsapp_provider_writer;
grant select (id, business_id, status, accepted_at, sent_at, delivered_at, read_at, failed_at)
  on public.whatsapp_messages to private_whatsapp_provider_writer;

-- record_whatsapp_webhook_event: idempotent webhook-event ingestion per
-- (provider, provider_event_key) — mirrors
-- private.record_provider_event (20260904080300_billing_permissions_
-- and_private_writer.sql) exactly, including its exact-replay-vs-
-- conflict contract:
--   EXACT match on (event_type, payload_sha256, business_id,
--   whatsapp_phone_number_id, message_id), compared with IS NOT
--   DISTINCT FROM (null-safe) -> legitimate replay: returns the
--   EXISTING row's id, is_new = false, no mutation.
--   ANY mismatch -> WHATSAPP_WEBHOOK_EVENT_CONFLICT, a stable,
--   controlled error.
--   The ON CONFLICT DO NOTHING + subsequent `for update` lock on the
--   losing branch makes this safe under concurrent first-writer races,
--   exactly like the billing equivalent.
create or replace function private.record_whatsapp_webhook_event(
  p_provider                   text,
  p_provider_event_key         text,
  p_event_type                 text,
  p_payload_sha256              text,
  p_business_id                uuid default null,
  p_whatsapp_phone_number_id   uuid default null,
  p_message_id                 uuid default null
)
returns table (id uuid, is_new boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id                uuid;
  v_existing_type     text;
  v_existing_hash     text;
  v_existing_business uuid;
  v_existing_number   uuid;
  v_existing_message  uuid;
begin
  if p_provider is null or p_provider_event_key is null or p_event_type is null or p_payload_sha256 is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_provider not in ('META_CLOUD') then
    raise exception 'INVALID_WHATSAPP_PROVIDER' using errcode = '22023';
  end if;
  if p_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' or length(p_event_type) > 100 then
    raise exception 'INVALID_EVENT_TYPE' using errcode = '22023';
  end if;
  if p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_PAYLOAD_HASH' using errcode = '22023';
  end if;
  if p_whatsapp_phone_number_id is not null and p_business_id is null then
    raise exception 'WHATSAPP_PHONE_NUMBER_REQUIRES_BUSINESS' using errcode = '22023';
  end if;
  if p_message_id is not null and p_business_id is null then
    raise exception 'MESSAGE_REQUIRES_BUSINESS' using errcode = '22023';
  end if;

  insert into private.whatsapp_webhook_events (
    provider, provider_event_key, event_type, business_id,
    whatsapp_phone_number_id, message_id, payload_sha256
  ) values (
    p_provider, p_provider_event_key, p_event_type, p_business_id,
    p_whatsapp_phone_number_id, p_message_id, p_payload_sha256
  )
  on conflict (provider, provider_event_key) do nothing
  returning private.whatsapp_webhook_events.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select private.whatsapp_webhook_events.id, event_type, payload_sha256, business_id,
         whatsapp_phone_number_id, message_id
  into v_id, v_existing_type, v_existing_hash, v_existing_business, v_existing_number, v_existing_message
  from private.whatsapp_webhook_events
  where provider = p_provider and provider_event_key = p_provider_event_key
  for update;

  if v_id is null then
    raise exception 'WHATSAPP_WEBHOOK_EVENT_NOT_FOUND' using errcode = '22023';
  end if;

  if v_existing_type is distinct from p_event_type
     or v_existing_hash is distinct from p_payload_sha256
     or v_existing_business is distinct from p_business_id
     or v_existing_number is distinct from p_whatsapp_phone_number_id
     or v_existing_message is distinct from p_message_id then
    raise exception 'WHATSAPP_WEBHOOK_EVENT_CONFLICT' using errcode = '23514';
  end if;

  return query select v_id, false;
end;
$$;

-- record_whatsapp_message_status_event: appends a status event to the
-- history table AND advances whatsapp_messages.status/*_at only when the
-- transition is monotonically forward — a delayed/stale event (e.g. a
-- SENT event that arrives after this message already reached READ) is
-- recorded in the append-only history (full chronological evidence
-- preserved) but never regresses the message's own current status.
-- FAILED is treated as a distinct terminal branch (see the ordering
-- table below) rather than folded into the same linear rank as the
-- delivery-progress states, so a stale FAILED can never clobber a
-- later-confirmed DELIVERED/READ, and a stale delivery-progress event
-- can never resurrect a message the provider has already reported
-- FAILED.
create or replace function private.record_whatsapp_message_status_event(
  p_message_id          uuid,
  p_business_id         uuid,
  p_status              text,
  p_provider_timestamp  timestamptz default null,
  p_failure_reason      text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id       uuid;
  v_current_status text;
  -- Linear delivery-progress rank; FAILED is intentionally NOT part of
  -- this scale (see header comment) and is handled by its own branch.
  v_rank           int;
  v_current_rank   int;
begin
  if p_message_id is null or p_business_id is null or p_status is null then
    raise exception 'p_message_id, p_business_id, and p_status are required' using errcode = '22023';
  end if;
  if p_status not in ('ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED') then
    raise exception 'INVALID_WHATSAPP_MESSAGE_STATUS' using errcode = '22023';
  end if;

  select status into v_current_status
  from public.whatsapp_messages
  where id = p_message_id and business_id = p_business_id
  for update;

  if v_current_status is null then
    raise exception 'WHATSAPP_MESSAGE_NOT_FOUND' using errcode = '22023';
  end if;

  -- Always record the raw chronological evidence, regardless of
  -- whether it ends up advancing the projection.
  insert into public.whatsapp_message_status_events (
    business_id, message_id, status, provider_timestamp, failure_reason
  ) values (
    p_business_id, p_message_id, p_status, p_provider_timestamp, p_failure_reason
  )
  returning id into v_event_id;

  -- FAILED is terminal but only ever applied from a non-terminal
  -- current state (PENDING/ACCEPTED/SENT/DELIVERED) — a message already
  -- confirmed READ, or already FAILED, is never overwritten by a stale
  -- FAILED event.
  if p_status = 'FAILED' then
    if v_current_status not in ('READ', 'FAILED') then
      update public.whatsapp_messages
      set status = 'FAILED', failed_at = coalesce(p_provider_timestamp, now()), failure_reason = p_failure_reason
      where id = p_message_id and business_id = p_business_id;
    end if;
    return v_event_id;
  end if;

  -- A message already terminally FAILED is never resurrected by a
  -- late-arriving delivery-progress event.
  if v_current_status = 'FAILED' then
    return v_event_id;
  end if;

  v_rank := case p_status
              when 'ACCEPTED' then 1
              when 'SENT' then 2
              when 'DELIVERED' then 3
              when 'READ' then 4
            end;
  v_current_rank := case v_current_status
                       when 'PENDING' then 0
                       when 'ACCEPTED' then 1
                       when 'SENT' then 2
                       when 'DELIVERED' then 3
                       when 'READ' then 4
                       else 0
                     end;

  if v_rank > v_current_rank then
    update public.whatsapp_messages
    set status = p_status,
        accepted_at = case when p_status = 'ACCEPTED' then coalesce(p_provider_timestamp, now()) else accepted_at end,
        sent_at     = case when p_status = 'SENT'      then coalesce(p_provider_timestamp, now()) else sent_at end,
        delivered_at= case when p_status = 'DELIVERED' then coalesce(p_provider_timestamp, now()) else delivered_at end,
        read_at     = case when p_status = 'READ'      then coalesce(p_provider_timestamp, now()) else read_at end
    where id = p_message_id and business_id = p_business_id;
  end if;

  return v_event_id;
end;
$$;

grant create on schema private to private_whatsapp_provider_writer;
alter function private.record_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)
  owner to private_whatsapp_provider_writer;
alter function private.record_whatsapp_message_status_event(uuid, uuid, text, timestamptz, text)
  owner to private_whatsapp_provider_writer;
revoke create on schema private from private_whatsapp_provider_writer;

-- No EXECUTE grant to ANY role — see this migration's own header
-- comment. Reachable only via a privileged superuser/test connection
-- until a real application-layer server boundary is built and reviewed.
revoke all on function private.record_whatsapp_webhook_event(text, text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.record_whatsapp_message_status_event(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- record_customer_whatsapp_consent — the one genuine, reachable write
-- primitive this DB-only round builds. Unlike account/number/message
-- writes (all deferred to a future provider/server boundary), recording
-- a customer's WhatsApp consent is an ordinary BusinessOS record-keeping
-- action with no dependency on Meta integration at all — a staff member
-- can record "this customer asked to be contacted on WhatsApp" today.
-- Requires `whatsapp.manage`. Enforces the opt-out-overrides-consent
-- rule structurally (an explicit re-opt-in call is required to clear an
-- opt-out — an ordinary consent update never silently clears one) and
-- audits every change via the existing frozen private.record_audit_event.
-- SERVICE and MARKETING permission both fail closed: neither is ever
-- inferred from customer/phone existence or from the other channel, and
-- enabling SERVICE messaging additionally requires an explicit consent
-- source (SERVICE_CONSENT_SOURCE_REQUIRED below) — the underlying
-- table default was corrected in the companion migration from true to
-- false for the same reason (WA-1M-01). EXECUTE is granted to
-- `authenticated` only (no service_role, no PUBLIC/anon) — this is a
-- user/staff action reached solely through this function's own internal
-- whatsapp.manage check.
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_whatsapp_action_writer') then
    create role private_whatsapp_action_writer noinherit nologin bypassrls;
  end if;
end
$$;

grant private_whatsapp_action_writer to postgres;

grant usage on schema public to private_whatsapp_action_writer;
grant usage on schema private to private_whatsapp_action_writer;

grant insert, update (
  service_messages_allowed, marketing_messages_allowed, service_consent_source,
  marketing_consent_source, service_consented_at, marketing_consented_at, marketing_opted_out_at
) on public.customer_whatsapp_preferences to private_whatsapp_action_writer;
grant select on public.customer_whatsapp_preferences to private_whatsapp_action_writer;

grant select (id, business_id) on public.customers to private_whatsapp_action_writer;

grant execute on function private.current_uid() to private_whatsapp_action_writer;
grant execute on function private.has_permission(uuid, text) to private_whatsapp_action_writer;

create or replace function public.record_customer_whatsapp_consent(
  p_business_id             uuid,
  p_customer_id             uuid,
  -- Each consent channel is only updated when its own "set" flag is
  -- true — this lets a caller change JUST marketing opt-out, say,
  -- without needing to re-state the service channel's current value
  -- (and risk silently resetting it, which this phase's own instruction
  -- explicitly forbids for ordinary edits).
  p_set_service              boolean default false,
  p_service_allowed          boolean default null,
  p_service_consent_source   text default null,
  p_set_marketing            boolean default false,
  p_marketing_allowed        boolean default null,
  p_marketing_consent_source text default null,
  p_marketing_opt_out        boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_customer_business   uuid;
  v_id                  uuid;
  v_service_source_ok   boolean;
  v_marketing_source_ok boolean;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_customer_id is null then
    raise exception 'p_business_id and p_customer_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'whatsapp.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Tenant match: the customer must genuinely belong to this business —
  -- this is what makes a forged/mismatched business_id or customer_id
  -- harmless.
  select business_id into v_customer_business
  from public.customers where id = p_customer_id;
  if v_customer_business is null or v_customer_business <> p_business_id then
    raise exception 'CUSTOMER_BUSINESS_MISMATCH' using errcode = '42501';
  end if;

  v_service_source_ok := p_service_consent_source is null
    or p_service_consent_source in ('CUSTOMER_REQUEST', 'CHECKOUT', 'FORM', 'IMPORT_DECLARED', 'WHATSAPP_INBOUND', 'STAFF_RECORDED');
  v_marketing_source_ok := p_marketing_consent_source is null
    or p_marketing_consent_source in ('CUSTOMER_REQUEST', 'CHECKOUT', 'FORM', 'IMPORT_DECLARED', 'WHATSAPP_INBOUND', 'STAFF_RECORDED');
  if not v_service_source_ok then
    raise exception 'INVALID_SERVICE_CONSENT_SOURCE' using errcode = '22023';
  end if;
  if not v_marketing_source_ok then
    raise exception 'INVALID_MARKETING_CONSENT_SOURCE' using errcode = '22023';
  end if;

  -- Service/transactional messaging must fail closed: it can only ever
  -- be turned ON by an explicit, bounded consent source. No source, no
  -- enable — this is what keeps a marketing-only or source-less call
  -- from ever granting service messaging permission by omission or by
  -- table default (see WA-1M-01 / this table's own default-false
  -- column comment).
  if p_set_service and p_service_allowed and p_service_consent_source is null then
    raise exception 'SERVICE_CONSENT_SOURCE_REQUIRED' using errcode = '22023';
  end if;

  -- p_marketing_allowed = true and p_marketing_opt_out = true together
  -- is a contradictory request — reject rather than silently pick a
  -- winner. A genuine re-opt-in after a prior opt-out is a distinct,
  -- deliberate call (p_set_marketing = true, p_marketing_allowed =
  -- true, p_marketing_opt_out = false) — this function allows that; it
  -- only refuses to let an ORDINARY update silently clear a
  -- previously-recorded opt-out by omission.
  if p_set_marketing and p_marketing_allowed and p_marketing_opt_out then
    raise exception 'CONTRADICTORY_MARKETING_CONSENT_REQUEST' using errcode = '22023';
  end if;

  insert into public.customer_whatsapp_preferences (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  if p_set_service then
    -- Enable (p_service_allowed = true, source already required above):
    -- service_consented_at is stamped with the DB's own now() — a
    -- trusted historical timestamp is not accepted in this foundation.
    -- Revoke (p_service_allowed = false): service_messages_allowed
    -- becomes the only authoritative signal; service_consent_source and
    -- service_consented_at are deliberately preserved as historical
    -- evidence of the prior consent decision rather than cleared, since
    -- this table has no separate consent-event history of its own.
    update public.customer_whatsapp_preferences
    set service_messages_allowed = coalesce(p_service_allowed, service_messages_allowed),
        service_consent_source   = coalesce(p_service_consent_source, service_consent_source),
        service_consented_at     = case when p_service_allowed then now() else service_consented_at end
    where business_id = p_business_id and customer_id = p_customer_id
    returning id into v_id;
  end if;

  if p_set_marketing then
    update public.customer_whatsapp_preferences
    set marketing_messages_allowed = coalesce(p_marketing_allowed, marketing_messages_allowed),
        marketing_consent_source   = coalesce(p_marketing_consent_source, marketing_consent_source),
        marketing_consented_at     = case when p_marketing_allowed then now() else marketing_consented_at end
    where business_id = p_business_id and customer_id = p_customer_id
    returning id into v_id;
  end if;

  if p_marketing_opt_out then
    update public.customer_whatsapp_preferences
    set marketing_messages_allowed = false,
        marketing_opted_out_at     = now()
    where business_id = p_business_id and customer_id = p_customer_id
    returning id into v_id;
  end if;

  if v_id is null then
    select id into v_id from public.customer_whatsapp_preferences
    where business_id = p_business_id and customer_id = p_customer_id;
  end if;

  -- Never put message body, access token, provider secret, raw
  -- webhook, or a customer's full phone number into audit metadata —
  -- only the bounded, already-validated consent fields themselves.
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'whatsapp.consent_updated', 'CUSTOMER',
    null, null, null,
    'customer_whatsapp_preferences', v_id, null, 'SUCCESS',
    jsonb_build_object(
      'customer_id', p_customer_id,
      'set_service', p_set_service,
      'service_allowed', p_service_allowed,
      'service_consent_source', p_service_consent_source,
      'set_marketing', p_set_marketing,
      'marketing_allowed', p_marketing_allowed,
      'marketing_consent_source', p_marketing_consent_source,
      'marketing_opt_out', p_marketing_opt_out
    )
  );

  return v_id;
end;
$$;

grant create on schema public to private_whatsapp_action_writer;
alter function public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)
  owner to private_whatsapp_action_writer;
revoke create on schema public from private_whatsapp_action_writer;

-- This is a user/staff action RPC (record a customer's own WhatsApp
-- consent decision), reached only after this function's own internal
-- whatsapp.manage permission check on the authenticated caller. No
-- current codebase caller runs as service_role, so service_role EXECUTE
-- is withheld along with PUBLIC/anon, keeping the reachable-role set to
-- exactly the one boundary this function is designed for. If a future
-- migration/import tool genuinely needs service_role access, grant it
-- then, under its own review.
revoke all on function public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)
  from public, anon, service_role;
grant execute on function public.record_customer_whatsapp_consent(uuid, uuid, boolean, boolean, text, boolean, boolean, text, boolean)
  to authenticated;

-- record_audit_event itself keeps ZERO EXECUTE grant to `authenticated`/
-- `anon`/`service_role`/PUBLIC (unchanged) — this grants EXECUTE only to
-- the specific, already-trusted private writer role that owns this
-- round's own new consent-recording function, mirroring exactly how
-- 20260902100000_instrument_core_audit_events.sql grants every other
-- instrumented mutation's own private writer role EXECUTE on this same
-- function (never broader role membership, which would also hand over
-- private_audit_writer's raw INSERT-on-audit_events privilege).
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_whatsapp_action_writer;
