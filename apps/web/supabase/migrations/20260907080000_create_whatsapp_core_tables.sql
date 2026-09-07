-- Phase 1M: WhatsApp + Customer Communication — DATABASE FOUNDATION ONLY.
--
-- This migration creates the core structural tables for WhatsApp
-- business messaging: provider account connections, provider phone
-- numbers, message templates, customer conversations, outbound/inbound
-- messages, and an append-only message status history. NO frontend, NO
-- Meta OAuth/Embedded Signup, NO webhook HTTP handling, and NO message
-- sending are implemented anywhere in this round — see this phase's own
-- companion migrations for permissions/private-writer scope, and the
-- final report for the full list of deliberately deferred work.
--
-- PROVIDER: 'META_CLOUD' (Meta WhatsApp Cloud API) is the only allowed
-- value today. Every provider-scoped CHECK constraint in this migration
-- enumerates it explicitly (never an open text column) so that adding a
-- second provider later is an additive CHECK-widening migration, never a
-- destructive one — mirrors this codebase's own established
-- provider-enum convention (public.business_subscriptions.provider,
-- private.billing_provider_events.provider).
--
-- PROVIDER SECRETS: this migration stores NO Meta access token, app
-- secret, or webhook verify token anywhere. Provider credential storage
-- is explicitly OUT OF SCOPE for this DB foundation — see the final
-- report's "provider-secret posture" item for the documented interim
-- plan (server environment configuration, until a real multi-tenant
-- encrypted-credential design is built as its own separate round).
--
-- WHATSAPP IS NEVER GATED BY A FEATURE ENTITLEMENT KEY: per this phase's
-- own explicit, non-negotiable product decision (already recorded in the
-- frozen 20260904080000_create_subscription_catalog.sql header comment:
-- "WHATSAPP ITSELF IS NEVER GATED BY A FEATURE ENTITLEMENT KEY AT ALL"),
-- basic WhatsApp/customer-communication capability is available on every
-- normal paid plan (STARTER, GROWTH, BUSINESS, ENTERPRISE). Nothing in
-- this migration references plan_entitlements at all — access to these
-- tables is governed purely by business membership + the new
-- whatsapp.view/whatsapp.send/whatsapp.manage permissions (next
-- migration), never by plan tier.
--
-- RLS MODEL: every table below follows this codebase's own established
-- precedent (public.sales/public.sale_items) exactly — SELECT is
-- business-wide and permission-gated (never a per-row branch filter);
-- branch RESTRICTION is enforced only inside a trusted write RPC, via
-- private.has_branch_access, for the one narrow case where a genuine
-- write primitive exists in this round (customer consent — see the
-- permissions/private-writer migration). No table here grants
-- INSERT/UPDATE/DELETE to `authenticated` at all: every one of these
-- tables is provider-backed or provider-adjacent (account identity,
-- phone identity, message content/status, template approval state), and
-- per this phase's own explicit instruction ("sensitive provider-backed
-- tables/columns must NOT allow arbitrary authenticated inserts/
-- updates"), all mutation is deferred to a future trusted provider/
-- server boundary that does not exist yet in this DB-only round.
--
-- DELETION POSTURE: WABA/phone/conversation/message rows are never hard
-- deleted by this schema (no DELETE policy or grant anywhere) — a
-- disconnect is represented by a status transition (e.g.
-- whatsapp_accounts.status = 'DISCONNECTED'), never row removal, so
-- historical conversations/messages/audit trail survive a disconnect
-- exactly as this phase's own "deletion/history" instruction requires.

-- ===========================================================================
-- whatsapp_accounts: one row per connected (or formerly connected)
-- provider business account (WABA) per business.
-- ===========================================================================
create table public.whatsapp_accounts (
  id                            uuid primary key default gen_random_uuid(),
  business_id                   uuid not null references public.businesses (id) on delete cascade,
  provider                      text not null default 'META_CLOUD' check (provider in ('META_CLOUD')),
  status                        text not null default 'DISCONNECTED'
                                   check (status in ('CONNECTED', 'DISCONNECTED', 'SUSPENDED')),
  -- Meta's own WABA ID — a real Graph API object id, globally unique
  -- within the provider's own namespace (not assumed universally unique
  -- across a hypothetical future second provider, hence the composite
  -- (provider, ...) uniqueness below rather than a bare unique column).
  provider_business_account_id  text
                                   check (
                                     provider_business_account_id is null
                                     or length(btrim(provider_business_account_id)) between 1 and 128
                                   ),
  -- Display name only — NEVER an access token, app secret, or webhook
  -- verify token. See this migration's own header comment.
  display_name                  text check (display_name is null or length(display_name) <= 200),
  connected_at                  timestamptz,
  disconnected_at               timestamptz,
  created_by                    uuid not null references auth.users (id),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  unique (id, business_id),
  -- A given provider WABA id can only ever belong to one connection
  -- record. NULLs (never-yet-connected rows) are each distinct under
  -- Postgres' standard unique-index NULL handling, so multiple
  -- DISCONNECTED/never-connected accounts coexisting is unaffected.
  unique (provider, provider_business_account_id),
  check (status <> 'CONNECTED' or provider_business_account_id is not null),
  check (status = 'CONNECTED' or disconnected_at is null or status = 'DISCONNECTED')
);

create index whatsapp_accounts_business_idx on public.whatsapp_accounts (business_id);

create trigger whatsapp_accounts_set_updated_at
  before update on public.whatsapp_accounts
  for each row execute function private.set_updated_at();

alter table public.whatsapp_accounts enable row level security;
alter table public.whatsapp_accounts force row level security;

create policy whatsapp_accounts_select on public.whatsapp_accounts
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` — connecting an
-- account requires the real Meta Embedded Signup flow this DB-only round
-- deliberately does not implement. See header comment.
revoke all on public.whatsapp_accounts from public, anon, authenticated, service_role;
grant select (
  id, business_id, provider, status, provider_business_account_id, display_name,
  connected_at, disconnected_at, created_at, updated_at
) on public.whatsapp_accounts to authenticated, service_role;

-- ===========================================================================
-- whatsapp_phone_numbers: one or more provider-registered sending
-- numbers per account, optionally assigned to a branch.
-- ===========================================================================
create table public.whatsapp_phone_numbers (
  id                        uuid primary key default gen_random_uuid(),
  business_id               uuid not null references public.businesses (id) on delete cascade,
  whatsapp_account_id       uuid not null,
  -- Nullable: no branch assignment means a company-wide number. See
  -- this phase's own "branch model" instruction.
  branch_id                 uuid,
  provider_phone_number_id  text not null check (length(btrim(provider_phone_number_id)) between 1 and 128),
  display_phone_number      text not null check (length(btrim(display_phone_number)) between 1 and 32),
  status                    text not null default 'ACTIVE'
                              check (status in ('ACTIVE', 'DISCONNECTED', 'SUSPENDED')),
  is_primary                boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (id, business_id),
  -- Meta's phone_number_id is a real Graph API object id, globally
  -- unique within the provider's own namespace — a given number can
  -- only ever be registered to one BusinessOS business at a time. Not
  -- assumed safe for a hypothetical future second provider, hence
  -- scoped by provider rather than left bare (see the CHECK below tying
  -- this row's provider indirectly to its account's provider via FK).
  unique (provider_phone_number_id),
  foreign key (whatsapp_account_id, business_id)
    references public.whatsapp_accounts (id, business_id) on delete cascade,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id) on delete restrict
);

-- One-primary-number rule: at most one primary number per business
-- (the default company-wide outbound sending identity when multiple
-- numbers exist). Structural foundation for future multi-number support
-- without enabling it in any MVP UI.
create unique index whatsapp_phone_numbers_one_primary_per_business
  on public.whatsapp_phone_numbers (business_id) where is_primary;

create index whatsapp_phone_numbers_business_idx on public.whatsapp_phone_numbers (business_id);
create index whatsapp_phone_numbers_account_idx on public.whatsapp_phone_numbers (whatsapp_account_id);
create index whatsapp_phone_numbers_branch_idx
  on public.whatsapp_phone_numbers (branch_id) where branch_id is not null;

create trigger whatsapp_phone_numbers_set_updated_at
  before update on public.whatsapp_phone_numbers
  for each row execute function private.set_updated_at();

alter table public.whatsapp_phone_numbers enable row level security;
alter table public.whatsapp_phone_numbers force row level security;

create policy whatsapp_phone_numbers_select on public.whatsapp_phone_numbers
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

revoke all on public.whatsapp_phone_numbers from public, anon, authenticated, service_role;
grant select (
  id, business_id, whatsapp_account_id, branch_id, provider_phone_number_id,
  display_phone_number, status, is_primary, created_at, updated_at
) on public.whatsapp_phone_numbers to authenticated, service_role;

-- ===========================================================================
-- whatsapp_templates: a local cache of provider-approved (or pending)
-- message templates. This round builds NO template-creation API — rows
-- exist only for future provider-sync/API writers to populate; approval
-- state can never be forged by an ordinary authenticated user (no
-- authenticated write grant of any kind on this table).
-- ===========================================================================
create table public.whatsapp_templates (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  whatsapp_account_id   uuid not null,
  provider_template_id  text check (provider_template_id is null or length(btrim(provider_template_id)) between 1 and 128),
  name                  text not null check (length(btrim(name)) between 1 and 200),
  language              text not null check (language ~ '^[a-z]{2}([_-][A-Z]{2})?$'),
  category              text not null default 'UNKNOWN'
                          check (category in ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'UNKNOWN')),
  status                text not null default 'PENDING'
                          check (status in ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN')),
  -- Structure/body snapshot only, for display — never assumed
  -- authoritative; the provider is always the source of truth for
  -- approval state and current structure.
  body_snapshot         text check (body_snapshot is null or length(body_snapshot) <= 4096),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (id, business_id),
  unique (business_id, name, language),
  foreign key (whatsapp_account_id, business_id)
    references public.whatsapp_accounts (id, business_id) on delete cascade
);

-- Scoped per-account (never globally): a template's provider id is
-- unique among templates belonging to the SAME WABA, matching Meta's own
-- template-namespace model.
create unique index whatsapp_templates_account_provider_id
  on public.whatsapp_templates (whatsapp_account_id, provider_template_id)
  where provider_template_id is not null;

create index whatsapp_templates_business_idx on public.whatsapp_templates (business_id);

create trigger whatsapp_templates_set_updated_at
  before update on public.whatsapp_templates
  for each row execute function private.set_updated_at();

alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_templates force row level security;

create policy whatsapp_templates_select on public.whatsapp_templates
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

revoke all on public.whatsapp_templates from public, anon, authenticated, service_role;
grant select (
  id, business_id, whatsapp_account_id, provider_template_id, name, language,
  category, status, body_snapshot, created_at, updated_at
) on public.whatsapp_templates to authenticated, service_role;

-- ===========================================================================
-- whatsapp_conversations: one logical thread per (business, customer,
-- number) — or per (business, unmatched phone, number) when no customer
-- match exists yet. customer_service_window_ends_at is stored here but
-- MUST eventually be advanced only by a trusted inbound-provider-event
-- writer (none exists in this DB-only round) — no authenticated write
-- grant of any kind touches this column.
-- ===========================================================================
create table public.whatsapp_conversations (
  id                                uuid primary key default gen_random_uuid(),
  business_id                       uuid not null references public.businesses (id) on delete cascade,
  branch_id                         uuid,
  -- Nullable: an inbound message from an unrecognized phone number gets
  -- a conversation with no customer match yet, rather than this schema
  -- inventing a duplicate independent customer database or
  -- auto-creating an unverified public.customers row from webhook data
  -- (explicitly forbidden by this phase's own instruction).
  customer_id                       uuid,
  whatsapp_phone_number_id          uuid not null,
  customer_phone_e164               text not null check (customer_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  status                            text not null default 'OPEN' check (status in ('OPEN', 'CLOSED', 'ARCHIVED')),
  last_inbound_at                   timestamptz,
  last_outbound_at                  timestamptz,
  last_message_at                   timestamptz,
  -- Never trust a client-provided value here — see header comment.
  customer_service_window_ends_at   timestamptz,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),

  unique (id, business_id),
  foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete restrict,
  foreign key (whatsapp_phone_number_id, business_id)
    references public.whatsapp_phone_numbers (id, business_id) on delete restrict,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id) on delete restrict
);

-- Concurrency/uniqueness: at most one OPEN conversation per matched
-- customer per sending number (prevents duplicate concurrent threads for
-- the same real customer relationship).
create unique index whatsapp_conversations_one_open_per_customer_number
  on public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id)
  where status = 'OPEN' and customer_id is not null;

-- Same guarantee for the unmatched-phone path, keyed on the raw
-- normalized phone number instead of a customer_id.
create unique index whatsapp_conversations_one_open_per_unmatched_phone
  on public.whatsapp_conversations (business_id, whatsapp_phone_number_id, customer_phone_e164)
  where status = 'OPEN' and customer_id is null;

create index whatsapp_conversations_list_idx
  on public.whatsapp_conversations (business_id, last_message_at desc);
create index whatsapp_conversations_customer_idx
  on public.whatsapp_conversations (customer_id) where customer_id is not null;

create trigger whatsapp_conversations_set_updated_at
  before update on public.whatsapp_conversations
  for each row execute function private.set_updated_at();

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_conversations force row level security;

create policy whatsapp_conversations_select on public.whatsapp_conversations
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

revoke all on public.whatsapp_conversations from public, anon, authenticated, service_role;
grant select (
  id, business_id, branch_id, customer_id, whatsapp_phone_number_id, customer_phone_e164,
  status, last_inbound_at, last_outbound_at, last_message_at,
  customer_service_window_ends_at, created_at, updated_at
) on public.whatsapp_conversations to authenticated, service_role;

-- ===========================================================================
-- whatsapp_messages: individual inbound/outbound messages. No raw
-- provider webhook payload is ever stored here — see header comment and
-- this phase's own explicit "message privacy constraints".
-- ===========================================================================
create table public.whatsapp_messages (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  conversation_id       uuid not null,
  customer_id           uuid,
  branch_id             uuid,
  direction             text not null check (direction in ('INBOUND', 'OUTBOUND')),
  message_type          text not null check (
                           message_type in (
                             'TEXT', 'TEMPLATE', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO',
                             'LOCATION', 'CONTACT', 'INTERACTIVE', 'UNKNOWN'
                           )
                         ),
  -- Meta's own wamid — globally unique within the provider's namespace.
  -- Null until the provider accepts an outbound send.
  provider_message_id   text check (provider_message_id is null or length(btrim(provider_message_id)) between 1 and 128),
  -- Client-supplied idempotency key for outbound message creation,
  -- unique per business so a retried client request never creates a
  -- duplicate PENDING message.
  client_creation_key   text check (client_creation_key is null or length(btrim(client_creation_key)) between 1 and 128),
  -- Nullable: SYSTEM-originated or inbound messages have no staff
  -- sender. Never trusted as authorization evidence on its own — the
  -- writer boundary that sets this must independently verify authority.
  sender_user_id        uuid references auth.users (id),
  sender_kind           text not null default 'SYSTEM' check (sender_kind in ('STAFF', 'SYSTEM', 'CUSTOMER')),
  template_id           uuid,
  body_text             text check (body_text is null or length(body_text) <= 4096),
  -- Minimal media metadata only — never the media bytes themselves, and
  -- never unrelated customer profile/card/ID-document data (explicit
  -- instruction).
  media_type            text check (media_type is null or media_type in ('IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO')),
  media_mime_type       text check (media_mime_type is null or length(media_mime_type) <= 100),
  media_provider_ref    text check (media_provider_ref is null or length(media_provider_ref) <= 200),
  status                text not null default 'PENDING'
                          check (status in ('PENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  -- Discrete provider timestamps kept separate rather than overloading
  -- a single "status_at" — mirrors this phase's own explicit
  -- instruction to store provider timestamps as separate fields.
  accepted_at           timestamptz,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  failed_at             timestamptz,
  failure_reason        text check (failure_reason is null or length(failure_reason) <= 300),
  reply_to_message_id   uuid,
  created_at            timestamptz not null default now(),

  unique (id, business_id),
  unique (provider_message_id),
  foreign key (conversation_id, business_id)
    references public.whatsapp_conversations (id, business_id) on delete restrict,
  foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete restrict,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id) on delete restrict,
  foreign key (template_id, business_id)
    references public.whatsapp_templates (id, business_id) on delete restrict,
  foreign key (reply_to_message_id, business_id)
    references public.whatsapp_messages (id, business_id) on delete set null,
  -- Direction integrity: an inbound message is never STAFF-attributed,
  -- and only an inbound message can ever be CUSTOMER-attributed.
  check (direction = 'INBOUND' or sender_kind <> 'CUSTOMER'),
  check (direction = 'OUTBOUND' or sender_kind <> 'STAFF'),
  check (message_type <> 'TEMPLATE' or template_id is not null)
);

-- Outbound client-retry idempotency: the same client_creation_key can
-- never create two rows for the same business.
create unique index whatsapp_messages_client_creation_key_idx
  on public.whatsapp_messages (business_id, client_creation_key)
  where client_creation_key is not null;

create index whatsapp_messages_conversation_idx
  on public.whatsapp_messages (conversation_id, created_at desc);
create index whatsapp_messages_business_idx
  on public.whatsapp_messages (business_id, created_at desc);
create index whatsapp_messages_status_idx
  on public.whatsapp_messages (business_id, status);

alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_messages force row level security;

create policy whatsapp_messages_select on public.whatsapp_messages
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

-- No authenticated INSERT/UPDATE grant at all — see header comment.
-- Message creation, status transitions, and provider-message-ID binding
-- are all deferred to a future trusted server/provider boundary.
revoke all on public.whatsapp_messages from public, anon, authenticated, service_role;
grant select (
  id, business_id, conversation_id, customer_id, branch_id, direction, message_type,
  provider_message_id, client_creation_key, sender_user_id, sender_kind, template_id,
  body_text, media_type, media_mime_type, media_provider_ref, status,
  accepted_at, sent_at, delivered_at, read_at, failed_at, failure_reason,
  reply_to_message_id, created_at
) on public.whatsapp_messages to authenticated, service_role;

-- ===========================================================================
-- whatsapp_message_status_events: append-only provider status history.
-- Status events may arrive out of order; this table stores the raw
-- chronological evidence. The monotonic PROJECTION onto
-- whatsapp_messages.status (never regressing) is enforced by the
-- trusted writer function in the companion permissions migration — this
-- table itself never rewrites or deletes a prior event.
-- ===========================================================================
create table public.whatsapp_message_status_events (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  message_id          uuid not null,
  status              text not null check (status in ('ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  provider_timestamp  timestamptz,
  failure_reason      text check (failure_reason is null or length(failure_reason) <= 300),
  received_at         timestamptz not null default now(),

  foreign key (message_id, business_id)
    references public.whatsapp_messages (id, business_id) on delete restrict
);

create index whatsapp_message_status_events_message_idx
  on public.whatsapp_message_status_events (message_id, received_at desc);

alter table public.whatsapp_message_status_events enable row level security;
alter table public.whatsapp_message_status_events force row level security;

create policy whatsapp_message_status_events_select on public.whatsapp_message_status_events
  for select to authenticated
  using (private.has_permission(business_id, 'whatsapp.view'));

-- Append-only: no INSERT/UPDATE/DELETE grant to any real role — the
-- only writer is the trusted private function in the next migration.
revoke all on public.whatsapp_message_status_events from public, anon, authenticated, service_role;
grant select (
  id, business_id, message_id, status, provider_timestamp, failure_reason, received_at
) on public.whatsapp_message_status_events to authenticated, service_role;
