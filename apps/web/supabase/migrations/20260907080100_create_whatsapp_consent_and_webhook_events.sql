-- Phase 1M: WhatsApp + Customer Communication — DATABASE FOUNDATION ONLY.
--
-- Second migration of this round: customer WhatsApp consent/preference
-- state, and the private, hash-only webhook-event idempotency ledger.
-- See 20260907080000_create_whatsapp_core_tables.sql for the full
-- round-level header comment (provider posture, RLS model, deletion
-- posture, WhatsApp-never-entitlement-gated).

-- ===========================================================================
-- customer_whatsapp_preferences: explicit, source-attributed consent —
-- never inferred from phone-number existence, a previous sale, a
-- customer record, or WhatsApp availability (this phase's own explicit
-- instruction). SERVICE and MARKETING permission are tracked
-- independently; marketing opt-out is a one-way override (see the
-- opt-out CHECK and the record_customer_whatsapp_consent function in
-- the companion permissions/private-writer migration for how that
-- override is actually enforced against ordinary edits).
-- ===========================================================================
create table public.customer_whatsapp_preferences (
  id                           uuid primary key default gen_random_uuid(),
  business_id                  uuid not null references public.businesses (id) on delete cascade,
  customer_id                  uuid not null,
  -- SERVICE/transactional communication (invoice, receipt, payment
  -- reminder, order update, account/service response) is ordinary
  -- business communication tied to a transaction the customer already
  -- initiated, and is tracked independently of marketing — but it MUST
  -- still fail closed like marketing: it defaults to NOT allowed, and
  -- is only ever set true by an explicit, source-attributed consent
  -- decision recorded through record_customer_whatsapp_consent
  -- (companion permissions/private-writer migration). This corrects an
  -- earlier draft of this same uncommitted migration that defaulted this
  -- column to true — that would have let a marketing-only consent
  -- update silently create a row with service messaging enabled by
  -- table default, with no explicit service consent decision ever made.
  -- Absence of a customer_whatsapp_preferences row, or a row with this
  -- column left at its default, both mean the same thing: service
  -- messaging is NOT allowed for that customer.
  service_messages_allowed     boolean not null default false,
  -- MARKETING/promotional communication (promotions, campaigns, offers,
  -- bulk advertising) NEVER defaults to allowed — must be explicitly
  -- recorded via a bounded consent source.
  marketing_messages_allowed   boolean not null default false,
  service_consent_source       text check (
                                  service_consent_source is null or service_consent_source in (
                                    'CUSTOMER_REQUEST', 'CHECKOUT', 'FORM', 'IMPORT_DECLARED',
                                    'WHATSAPP_INBOUND', 'STAFF_RECORDED'
                                  )
                                ),
  marketing_consent_source     text check (
                                  marketing_consent_source is null or marketing_consent_source in (
                                    'CUSTOMER_REQUEST', 'CHECKOUT', 'FORM', 'IMPORT_DECLARED',
                                    'WHATSAPP_INBOUND', 'STAFF_RECORDED'
                                  )
                                ),
  service_consented_at         timestamptz,
  marketing_consented_at       timestamptz,
  marketing_opted_out_at       timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  unique (id, business_id),
  unique (business_id, customer_id),
  foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete cascade,
  -- Opt-out overrides consent, structurally: a recorded opt-out can
  -- never coexist with marketing_messages_allowed = true.
  check (marketing_opted_out_at is null or marketing_messages_allowed = false)
);

create index customer_whatsapp_preferences_customer_idx
  on public.customer_whatsapp_preferences (customer_id);

create trigger customer_whatsapp_preferences_set_updated_at
  before update on public.customer_whatsapp_preferences
  for each row execute function private.set_updated_at();

alter table public.customer_whatsapp_preferences enable row level security;
alter table public.customer_whatsapp_preferences force row level security;

create policy customer_whatsapp_preferences_select on public.customer_whatsapp_preferences
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

-- No direct authenticated INSERT/UPDATE grant: consent is recorded only
-- through the trusted, audited
-- public.record_customer_whatsapp_consent RPC (companion migration),
-- which enforces the opt-out-overrides-consent rule against ordinary
-- edits and writes an audit event for every change.
revoke all on public.customer_whatsapp_preferences from public, anon, authenticated, service_role;
grant select (
  id, business_id, customer_id, service_messages_allowed, marketing_messages_allowed,
  service_consent_source, marketing_consent_source, service_consented_at,
  marketing_consented_at, marketing_opted_out_at, created_at, updated_at
) on public.customer_whatsapp_preferences to authenticated, service_role;

-- ===========================================================================
-- private.whatsapp_webhook_events: provider webhook idempotency ledger.
-- Modeled exactly on the already-frozen
-- private.billing_provider_events (20260904080200_create_billing_
-- history.sql) — normalized identity + a SHA-256 hash of the payload
-- only, NEVER the raw payload itself. No policy of any kind for any
-- role, including service_role — the only path to this data is the
-- trusted private.record_whatsapp_webhook_event function (companion
-- migration) or a privileged superuser/test connection, mirroring this
-- codebase's own established private-ledger convention exactly.
-- ===========================================================================
create table private.whatsapp_webhook_events (
  id                         uuid primary key default gen_random_uuid(),
  provider                   text not null check (provider in ('META_CLOUD')),
  -- Deliberately NOT assumed to be a provider-supplied UUID — bounded
  -- opaque text, exactly like billing_provider_events.provider_event_key.
  -- A future app-layer webhook verifier is responsible for deriving a
  -- deterministic key from whatever Meta payload fields actually
  -- guarantee uniqueness for a given event_type.
  provider_event_key         text not null check (length(provider_event_key) between 1 and 300),
  event_type                 text not null
                                check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(event_type) <= 100),
  -- Nullable "until safely resolved" — an event may arrive before its
  -- business/number/message association is confirmed, or (for a
  -- malformed/unrecognized event) never be resolved at all.
  business_id                uuid references public.businesses (id) on delete restrict,
  whatsapp_phone_number_id   uuid,
  message_id                 uuid,
  -- SHA-256 hex digest of the raw payload — for support/debugging
  -- correlation only, never treated as trusted authorization evidence.
  -- The raw payload itself is never stored (this phase's own explicit
  -- "no infinite raw-event payload retention" instruction).
  payload_sha256              text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  processing_status           text not null default 'RECEIVED'
                                 check (processing_status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  processed_at                 timestamptz,
  result                       text check (result is null or length(result) <= 100),
  received_at                  timestamptz not null default now(),

  -- The idempotency guarantee itself: the SAME (provider, event key)
  -- can never be recorded twice, regardless of provider redelivery or a
  -- replayed request.
  unique (provider, provider_event_key),

  -- Whenever an association is resolved, business_id must be resolved
  -- too — mirrors billing_provider_events' identical SEC-1L-04
  -- remediation exactly (MATCH SIMPLE would otherwise skip FK
  -- enforcement entirely whenever business_id is null).
  check (whatsapp_phone_number_id is null or business_id is not null),
  check (message_id is null or business_id is not null),

  foreign key (whatsapp_phone_number_id, business_id)
    references public.whatsapp_phone_numbers (id, business_id) on delete restrict,
  foreign key (message_id, business_id)
    references public.whatsapp_messages (id, business_id) on delete restrict
);

create index whatsapp_webhook_events_business_idx
  on private.whatsapp_webhook_events (business_id, received_at desc)
  where business_id is not null;
create index whatsapp_webhook_events_status_idx
  on private.whatsapp_webhook_events (processing_status, received_at desc);

alter table private.whatsapp_webhook_events enable row level security;
alter table private.whatsapp_webhook_events force row level security;

revoke all on private.whatsapp_webhook_events from public, anon, authenticated, service_role;
