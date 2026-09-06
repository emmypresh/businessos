-- Phase 1L: append-only billing payment history + provider-event
-- idempotency ledger.
--
-- billing_transactions is the LOCAL RECORD OF SUBSCRIPTION PAYMENT
-- OUTCOMES — NOT the business's own customer-facing sales/payment ledger
-- (public.invoice_payments, unrelated). It is append-oriented: no
-- UPDATE/DELETE policy or grant exists for `authenticated`, matching
-- every other Phase 1J/1K historical-fact table's identical posture.
--
-- billing_provider_events lives in the `private` schema, not `public` —
-- per this phase's own explicit instruction ("NO authenticated client
-- visibility... backend/private only"), this is the SAME structural
-- choice already established for every idempotency-ledger table in this
-- codebase (private.sale_creation_requests, private.invoice_payment_
-- requests, private.sale_return_creation_requests, ...): living in
-- `private` means it is NEVER reachable via PostgREST at all, regardless
-- of any grant, since config.toml only exposes `public`/`graphql_public`
-- — a stronger, structural guarantee than "public table with zero
-- grants," which still depends on every future grant staying correct.

create table public.billing_transactions (
  id                         uuid primary key default gen_random_uuid(),
  business_id                uuid not null references public.businesses (id) on delete restrict,
  subscription_id            uuid not null,
  provider                   text not null check (provider in ('PAYSTACK', 'MANUAL')),
  -- The provider's own reference for THIS attempt (Paystack's own
  -- transaction reference, generated at initialization) — bounded, never
  -- assumed to be a UUID. Unique PER PROVIDER: this is what makes
  -- recording the SAME provider reference twice (a retried webhook, a
  -- duplicate confirmation call) idempotent at the table level, not only
  -- inside whatever trusted writer eventually calls this.
  provider_reference         text not null check (length(provider_reference) between 1 and 200),
  -- The provider's own transaction id/code, if distinct from the
  -- reference (Paystack exposes both) — nullable, bounded.
  provider_transaction_code text check (provider_transaction_code is null or length(provider_transaction_code) between 1 and 200),
  amount_minor               bigint not null check (amount_minor >= 0),
  currency                   text not null check (currency ~ '^[A-Z]{3}$'),
  -- Only the states this phase's own instructions justify against
  -- CURRENTLY KNOWN Paystack subscription-charging flows (charge.success
  -- / invoice.payment_failed / a pending initialized-but-unconfirmed
  -- transaction / a future refund) — never a speculative superset.
  status                     text not null check (status in ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED')),
  paid_at                    timestamptz,
  failed_at                  timestamptz,
  -- Sanitized/bounded, per this phase's own explicit instruction — a
  -- provider's own failure code (e.g. "insufficient_funds"), never a raw
  -- gateway exception dump.
  failure_code               text check (failure_code is null or length(failure_code) <= 100),
  failure_message            text check (failure_message is null or length(failure_message) <= 500),
  -- The payment channel Paystack itself reports (card / bank / direct
  -- debit) — informational only, bounded.
  provider_channel           text check (provider_channel is null or length(provider_channel) <= 50),
  created_at                 timestamptz not null default now(),

  check (status <> 'SUCCESS' or paid_at is not null),
  check (status <> 'FAILED' or failed_at is not null),

  -- Tenant-consistent composite FK: subscription_id must resolve to a
  -- business_subscriptions row in THIS SAME business_id — a cross-tenant
  -- transaction (a business_subscriptions row from business A with a
  -- billing_transactions row claiming business B) is structurally
  -- unrepresentable, not merely RPC-checked. RESTRICT (never CASCADE):
  -- payment history is durable evidence, exactly like audit_events —
  -- see this migration's own header comment and business_subscriptions'
  -- own identical RESTRICT choice.
  foreign key (subscription_id, business_id)
    references public.business_subscriptions (id, business_id)
    on delete restrict,

  -- Idempotency at the table level: the SAME provider reference recorded
  -- twice (a retried confirmation, a duplicate webhook-driven insert
  -- attempt) can never produce two rows — this is what a future trusted
  -- writer's own `ON CONFLICT (provider, provider_reference) DO NOTHING`
  -- relies on.
  unique (provider, provider_reference)
);

create index billing_transactions_business_created_idx
  on public.billing_transactions (business_id, created_at desc, id desc);
create index billing_transactions_subscription_idx
  on public.billing_transactions (subscription_id, created_at desc);

-- Row Level Security ---------------------------------------------------
--
-- Same read model as business_subscriptions (billing.view, business-
-- wide) — payment HISTORY is at least as sensitive as the current
-- projection, never less. Append-only: no INSERT/UPDATE/DELETE policy
-- for `authenticated` at all.

alter table public.billing_transactions enable row level security;
alter table public.billing_transactions force row level security;

create policy billing_transactions_select on public.billing_transactions
  for select
  to authenticated
  using (private.has_permission(business_id, 'billing.view'));

revoke all on public.billing_transactions from public, anon, authenticated, service_role;
grant select (
  id, business_id, subscription_id, provider, provider_reference, provider_transaction_code,
  amount_minor, currency, status, paid_at, failed_at, failure_code, failure_message,
  provider_channel, created_at
) on public.billing_transactions to authenticated, service_role;
revoke references, trigger, truncate on public.billing_transactions from anon, authenticated;

-- private.billing_provider_events -----------------------------------------
--
-- Idempotent provider webhook/event ingestion history — lives in
-- `private`, per this migration's own header comment. DATA MINIMIZATION,
-- per this phase's own explicit instruction: NO raw provider payload is
-- stored here at all — only event identity, type, a cryptographic hash
-- of the payload (for support/debugging correlation without holding the
-- payment data itself), and the minimal references needed to act on it.
--
-- provider_event_key IS DELIBERATELY NOT ASSUMED TO BE A PROVIDER-
-- SUPPLIED UUID: per this phase's own explicit warning ("Paystack webhook
-- payloads should not be assumed to have a universally trustworthy
-- top-level event UUID... do not invent a provider event ID"), this
-- column is bounded, opaque TEXT — the future app-layer webhook verifier
-- is responsible for DERIVING a deterministic key from whatever
-- authoritative provider data/event semantics actually guarantee
-- uniqueness for a given event_type (e.g. Paystack's own transaction
-- reference for a charge.success event, a subscription code + a
-- provider-reported sequence/timestamp for a subscription lifecycle
-- event) — this foundation only guarantees that WHATEVER key is derived,
-- the SAME (provider, key) can never be recorded twice.
create table private.billing_provider_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null check (provider in ('PAYSTACK')),
  provider_event_key text not null check (length(provider_event_key) between 1 and 300),
  event_type         text not null
                       check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(event_type) <= 100),
  -- Nullable "until safely resolved" (per this phase's own explicit
  -- instruction) — an event may arrive before its business mapping is
  -- confirmed, or (for a genuinely malformed/unrecognized event) never
  -- be resolved at all.
  business_id        uuid references public.businesses (id) on delete restrict,
  -- SEC-1L-04 remediation: subscription_id is deliberately NOT its own
  -- single-column FK here (unlike business_id above) — it is enforced
  -- ONLY as part of the composite (subscription_id, business_id) FK
  -- below, so "Business A + Subscription B" (a subscription that
  -- genuinely exists but belongs to a DIFFERENT business than this same
  -- row's own business_id claims) is structurally unrepresentable, not
  -- merely RPC-checked.
  subscription_id    uuid,
  -- SHA-256 hex digest of the raw payload — bounded, deterministic,
  -- never the payload itself. Used for support/debugging correlation
  -- ("does this stored hash match what the provider claims it sent"),
  -- never treated as trusted authorization evidence on its own (the
  -- app-layer signature verification, using the server-only Paystack
  -- secret, is what actually establishes trust — this hash exists
  -- AFTER that verification has already happened).
  payload_hash       text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  processing_status  text not null default 'RECEIVED'
                       check (processing_status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  processed_at       timestamptz,
  error_code         text check (error_code is null or length(error_code) <= 100),
  received_at        timestamptz not null default now(),

  -- The idempotency guarantee itself: the SAME (provider, event key)
  -- can never be recorded twice, regardless of how many times the
  -- provider (or an attacker replaying a captured request) redelivers
  -- it.
  unique (provider, provider_event_key),

  -- SEC-1L-04 remediation: whenever subscription_id is resolved,
  -- business_id must be resolved too — this is what makes the composite
  -- FK below actually enforce something for every row that carries a
  -- subscription_id (Postgres' MATCH SIMPLE skips FK enforcement
  -- entirely whenever ANY referencing column is null, so a null
  -- business_id alongside a non-null subscription_id would otherwise
  -- silently bypass the consistency check this migration exists to add).
  check (subscription_id is null or business_id is not null),

  -- The consistency guarantee itself: a subscription_id, once resolved,
  -- MUST belong to the claimed business_id — mirrors business_
  -- subscriptions' own (id, business_id) composite key and billing_
  -- transactions' own identical composite-FK pattern exactly.
  -- ON DELETE RESTRICT (never CASCADE/SET NULL): this is durable
  -- evidence, exactly like every other Phase 1L historical-fact FK.
  foreign key (subscription_id, business_id)
    references public.business_subscriptions (id, business_id)
    on delete restrict
);

create index billing_provider_events_business_idx
  on private.billing_provider_events (business_id, received_at desc)
  where business_id is not null;
create index billing_provider_events_status_idx
  on private.billing_provider_events (processing_status, received_at desc);

-- RLS is enabled and forced even though this table lives in `private`
-- (unreachable via PostgREST regardless) — defense in depth, matching
-- every other Phase 1C-1K `private` ledger table's identical posture
-- (e.g. private.sale_creation_requests).
alter table private.billing_provider_events enable row level security;
alter table private.billing_provider_events force row level security;

-- No policy of ANY kind for ANY role — not even service_role — mirrors
-- this phase's own explicit "NO authenticated client visibility...
-- backend/private only" instruction as strictly as this schema's own
-- existing private-ledger convention allows. The only path to this data
-- is a trusted SECURITY DEFINER function (next migration) or a
-- privileged superuser connection (this codebase's own established
-- test/ops convention).
revoke all on private.billing_provider_events from public, anon, authenticated, service_role;
