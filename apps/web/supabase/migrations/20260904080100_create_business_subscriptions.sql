-- Phase 1L: the CURRENT, per-business subscription projection.
--
-- ONE ROW PER BUSINESS, EVER — `business_id` is UNIQUE, not merely
-- indexed. This is the "one current subscription authority per
-- business" the product brief requires, resolved as simply as possible:
-- rather than an append-only history of subscription "generations" with
-- a separate "which one is current" pointer, there is exactly one
-- mutable row per business, and every state transition (trial -> active,
-- renewal, plan change, cancellation, expiry) is an UPDATE to that same
-- row by a trusted transition function (next migration). Append-only
-- PAYMENT history (what a renewal or a failed charge actually was) lives
-- separately, in billing_transactions — this table is the CURRENT
-- PROJECTION derived from that history, not the history itself,
-- mirroring exactly how business_members holds a member's current role/
-- status while business_member_branches/audit_events hold historical
-- detail. A plan/provider "migration" (e.g. moving from a Paystack
-- subscription to a negotiated ENTERPRISE contract) is representable as
-- an UPDATE of this same row's own columns — no new row, no ambiguity
-- about which row is authoritative.
--
-- BUSINESS-DELETE DURABILITY: business_id uses `on delete restrict`,
-- mirroring audit_events'/notifications' own identical SEC-01J-informed
-- choice — a business's subscription/billing history is exactly the
-- kind of durable evidence a business-deletion cascade must never
-- silently erase. There is still no business-deletion RPC anywhere in
-- this codebase, so this is a zero-cost structural guarantee today and a
-- real one the moment such a path is ever built.
--
-- STATE MACHINE — six states, chosen because BusinessOS can rigorously
-- define each one's own required fields and entry condition, never
-- copied from an unrelated payment platform's own vocabulary:
--
--   TRIALING  — the business is inside its trial window. Requires
--               trial_started_at and trial_ends_at (trial_ends_at >
--               trial_started_at). Entered exactly once, by
--               private.create_initial_trial, for a brand-new business
--               with no subscription row yet.
--   ACTIVE    — a real billing period is currently paid for. Requires
--               current_period_started_at and current_period_ends_at
--               (period_ends_at > period_started_at). Entered from
--               TRIALING (trial converts to a real subscription), from
--               PAST_DUE (a past-due payment succeeds), or re-entered
--               from ACTIVE itself (a renewal simply extends the same
--               period bounds) via private.activate_subscription_from_
--               verified_payment / private.record_subscription_renewal.
--   PAST_DUE  — the current period's own end has passed without a
--               successful renewal charge. Requires
--               current_period_ends_at (the period that lapsed).
--               grace_ends_at is OPTIONAL — see this migration's own
--               "grace policy" note below. Entered from ACTIVE via
--               private.record_subscription_payment_failed.
--   CANCELED  — the subscription has DEFINITIVELY ENDED, and the reason
--               was a customer-or-admin-initiated cancellation (as
--               opposed to EXPIRED, below, which means it simply lapsed
--               with no explicit cancellation ever requested). Requires
--               canceled_at. Grants NO entitlement — this is the
--               "already ended" event, entered ONLY once the already-
--               paid-for period genuinely completes, via
--               private.mark_subscription_expired.
--   EXPIRED   — access has definitively ended with NO cancellation
--               having been requested: either a TRIALING period ended
--               with no conversion, or a PAST_DUE subscription's own
--               grace window (if any) fully lapsed with no successful
--               renewal. Requires ended_at. This is a TERMINAL state for
--               a given billing relationship — a business that wants to
--               resume must go through checkout again (a future
--               ACTIVATE transition can still target this same row;
--               EXPIRED is not a schema-level dead end, only a product-
--               level "you're not entitled right now" fact). Entered via
--               private.mark_subscription_expired.
--
--               CRITICAL DISTINCTION (per this phase's own explicit
--               instruction: "do not model a user cancellation request
--               as immediate subscription expiration if their paid
--               period remains valid"): requesting cancellation
--               (private.schedule_subscription_cancel) sets ONLY the
--               `cancel_at_period_end` FLAG (plus `canceled_at`, as a
--               timestamp of WHEN the request was made) — it never
--               changes `status` at all. A TRIALING or ACTIVE row with
--               `cancel_at_period_end = true` remains fully entitled by
--               the exact same formula as one without the flag, for
--               exactly as long as its existing trial_ends_at/
--               current_period_ends_at says it should be. The `status`
--               column only ever becomes CANCELED later, when
--               private.mark_subscription_expired is called at the
--               NATURAL end of that already-paid-for period and finds
--               the flag set (choosing CANCELED over EXPIRED specifically
--               because a cancellation was the reason, not a lapsed
--               payment) — never as a side effect of scheduling the
--               cancellation itself.
--   INCOMPLETE — a checkout/subscription attempt has been initiated
--               with the provider but not yet confirmed (e.g.
--               transaction initialized, first charge not yet
--               verified). No time-bound fields are required. This
--               state grants NO entitlement (see the entitlement
--               formula below) — it exists so a pending attempt has
--               somewhere durable to live before it either becomes
--               ACTIVE (payment verified) or is abandoned, rather than
--               being invented ad hoc in application memory. Foundation
--               does not yet define a specific transition function INTO
--               this state (a future private.record_checkout_pending is
--               anticipated, per this phase's own naming suggestions,
--               but is not required to prove this round's own model).
--
-- ALLOWED TRANSITIONS (documented, not exhaustively enforced by a
-- transition table — enforced by which trusted functions exist and what
-- each one's own preconditions check, exactly like every other
-- state-holding table in this schema):
--
--   (no row) -> TRIALING              [create_initial_trial]
--   TRIALING -> ACTIVE                 [activate_subscription_from_verified_payment]
--   TRIALING -> EXPIRED                [mark_subscription_expired, cancel_at_period_end = false]
--   TRIALING -> CANCELED               [mark_subscription_expired, cancel_at_period_end = true]
--   ACTIVE   -> ACTIVE (renewed)       [record_subscription_renewal]
--   ACTIVE   -> PAST_DUE               [record_subscription_payment_failed]
--   ACTIVE   -> EXPIRED                [mark_subscription_expired, cancel_at_period_end = false]
--   ACTIVE   -> CANCELED               [mark_subscription_expired, cancel_at_period_end = true]
--   PAST_DUE -> ACTIVE                 [activate_subscription_from_verified_payment / record_subscription_renewal]
--   PAST_DUE -> EXPIRED                [mark_subscription_expired, cancel_at_period_end = false]
--   PAST_DUE -> CANCELED               [mark_subscription_expired, cancel_at_period_end = true]
--   INCOMPLETE -> ACTIVE               [activate_subscription_from_verified_payment]
--   INCOMPLETE -> EXPIRED              [mark_subscription_expired]
--
--   (any of TRIALING/ACTIVE/PAST_DUE) -> itself, unchanged, with
--     cancel_at_period_end set true  [schedule_subscription_cancel — a
--     FLAG-only transition, never a status change; see the CANCELED
--     entry above for the full rationale]
--
-- No transition function allows an authenticated client to reach ANY of
-- these states directly — see the RLS section below: there is no
-- INSERT/UPDATE/DELETE policy for `authenticated` on this table at all,
-- under any circumstance. Every transition above is reachable ONLY via
-- a SECURITY DEFINER function owned by private_billing_writer.
--
-- GRACE POLICY: grace_ends_at is nullable and DELIBERATELY UNPOPULATED
-- by any function in this round — this phase's own explicit instruction
-- is "do not hard-code 3/7/etc days unless explicitly justified... Actual
-- grace duration can be decided in app/product layer." The column and
-- its role in the entitlement formula both exist; the NUMBER OF DAYS
-- does not, anywhere in this schema.
create table public.business_subscriptions (
  id                         uuid primary key default gen_random_uuid(),
  business_id                uuid not null unique references public.businesses (id) on delete restrict,
  plan_id                    uuid not null references public.subscription_plans (id) on delete restrict,
  -- Nullable "for enterprise/manual cases" (per this phase's own
  -- explicit instruction) — a negotiated ENTERPRISE subscription may
  -- have no matching catalog PRICE row at all.
  price_id                   uuid references public.subscription_plan_prices (id) on delete restrict,
  -- MANUAL: the trusted-admin-controlled, provider-less path this
  -- phase's own instructions require room for (a negotiated ENTERPRISE
  -- contract, a bank transfer, ...) — safe to include as a value NOW
  -- because nothing in this table's own RLS/grants ever lets a client
  -- choose it themselves; the safety boundary is WHO can write this
  -- column at all (nobody but private_billing_writer), never which
  -- values the CHECK happens to allow.
  provider                   text not null check (provider in ('PAYSTACK', 'MANUAL')),
  provider_environment       text check (provider_environment is null or provider_environment in ('TEST', 'LIVE')),
  check (provider <> 'MANUAL' or provider_environment is null),
  provider_customer_code     text check (provider_customer_code is null or length(provider_customer_code) between 1 and 100),
  provider_subscription_code text check (provider_subscription_code is null or length(provider_subscription_code) between 1 and 100),
  -- SEC-1L-03 remediation: MANUAL is the provider-less path (a
  -- negotiated ENTERPRISE contract, a bank transfer) — a provider
  -- identifier only ever means something when there is an actual
  -- payment-provider relationship behind it, so a MANUAL row can never
  -- carry one.
  check (provider <> 'MANUAL' or (provider_customer_code is null and provider_subscription_code is null)),
  status                     text not null check (status in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'INCOMPLETE')),
  billing_interval           text check (billing_interval is null or billing_interval in ('MONTHLY', 'ANNUAL')),
  currency                   text not null check (currency ~ '^[A-Z]{3}$'),
  -- Nullable "for enterprise/manual cases" (per this phase's own
  -- explicit instruction). BIGINT minor units, never floating point —
  -- see subscription_plan_prices' own identical rationale.
  amount_minor               bigint check (amount_minor is null or amount_minor >= 0),
  trial_started_at           timestamptz,
  trial_ends_at              timestamptz,
  current_period_started_at  timestamptz,
  current_period_ends_at     timestamptz,
  cancel_at_period_end       boolean not null default false,
  canceled_at                timestamptz,
  ended_at                   timestamptz,
  grace_ends_at              timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  check (trial_ends_at is null or trial_started_at is null or trial_ends_at > trial_started_at),
  check (current_period_ends_at is null or current_period_started_at is null or current_period_ends_at > current_period_started_at),

  -- Per-status required fields — the exact invariants this phase's own
  -- instructions name explicitly ("TRIALING: trial_started_at required,
  -- trial_ends_at required... ACTIVE: current_period_started_at
  -- required...").
  check (status <> 'TRIALING' or (trial_started_at is not null and trial_ends_at is not null)),
  check (status <> 'ACTIVE' or (current_period_started_at is not null and current_period_ends_at is not null)),
  check (status <> 'PAST_DUE' or current_period_ends_at is not null),
  check (status <> 'CANCELED' or canceled_at is not null),
  check (status <> 'EXPIRED' or ended_at is not null),

  -- Composite key so billing_transactions can FK against (id,
  -- business_id) together, making a cross-tenant subscription/
  -- transaction combination structurally unrepresentable — mirrors every
  -- other Phase 1C-1K parent/child table pair's identical convention.
  -- private.billing_provider_events (next-next migration) FKs against
  -- this SAME composite for the identical reason (SEC-1L-04).
  unique (id, business_id),

  -- SEC-1L-03 remediation: structural defense-in-depth alongside
  -- activate_subscription_from_verified_payment's own explicit
  -- PRICE_PLAN_MISMATCH check — a subscription's own price_id can never
  -- reference a subscription_plan_prices row belonging to a DIFFERENT
  -- plan than this same row's own plan_id, even via a direct privileged
  -- INSERT that bypasses the trusted writer entirely. price_id is
  -- nullable (MANUAL/enterprise), and MATCH SIMPLE (Postgres' only FK
  -- match type here) skips enforcement whenever either referencing
  -- column is null, so this never blocks a null price_id.
  foreign key (price_id, plan_id) references public.subscription_plan_prices (id, plan_id)
);

create index business_subscriptions_status_idx on public.business_subscriptions (status);
create index business_subscriptions_plan_idx on public.business_subscriptions (plan_id);

-- SEC-1L-03 remediation: provider identifier uniqueness, scoped by
-- provider+environment — the SAME Paystack customer/subscription code
-- can never be silently shared by two different business_subscriptions
-- rows within the same provider+environment (a real integration bug, or
-- a spoofed/mismatched activation call). Scoped to non-null values only
-- (MANUAL rows, and any row that has not yet received a provider
-- identifier, are exempt by construction). NULLS NOT DISTINCT (PG17):
-- two rows with the SAME non-null code but both a NULL
-- provider_environment must still collide — plain UNIQUE semantics
-- would otherwise treat those NULLs as distinct and silently defeat the
-- guarantee this index exists for.
create unique index business_subscriptions_provider_customer_code_unique_idx
  on public.business_subscriptions (provider, provider_environment, provider_customer_code)
  nulls not distinct
  where provider_customer_code is not null;

create unique index business_subscriptions_provider_subscription_code_unique_idx
  on public.business_subscriptions (provider, provider_environment, provider_subscription_code)
  nulls not distinct
  where provider_subscription_code is not null;

create trigger business_subscriptions_set_updated_at
  before update on public.business_subscriptions
  for each row
  execute function private.set_updated_at();

-- Row Level Security ---------------------------------------------------
--
-- READ MODEL: gated on billing.view (next migration seeds this
-- permission and its matrix) — business-wide, never branch-scoped
-- (mirrors audit.view's own established "business-wide oversight
-- concern" precedent exactly; a subscription is a whole-business fact,
-- there is no meaningful notion of a "branch's own" subscription).
--
-- APPEND-ONLY FROM THE CLIENT'S PERSPECTIVE: no INSERT/UPDATE/DELETE
-- policy exists for `authenticated` at all — every state transition
-- listed in this migration's own header comment happens exclusively
-- through a SECURITY DEFINER function owned by private_billing_writer
-- (next migration). No browser can activate itself, extend its own
-- trial, change its own plan, fabricate a paid-through date, or reset
-- its own PAST_DUE status, under any circumstance.

alter table public.business_subscriptions enable row level security;
alter table public.business_subscriptions force row level security;

create policy business_subscriptions_select on public.business_subscriptions
  for select
  to authenticated
  using (private.has_permission(business_id, 'billing.view'));

revoke all on public.business_subscriptions from public, anon, authenticated, service_role;
grant select (
  id, business_id, plan_id, price_id, provider, provider_environment,
  provider_customer_code, provider_subscription_code, status, billing_interval,
  currency, amount_minor, trial_started_at, trial_ends_at,
  current_period_started_at, current_period_ends_at, cancel_at_period_end,
  canceled_at, ended_at, grace_ends_at, created_at, updated_at
) on public.business_subscriptions to authenticated, service_role;
revoke references, trigger, truncate on public.business_subscriptions from anon, authenticated;

-- Entitlement formula ----------------------------------------------------
--
-- "subscription is entitled NOW if..." — implemented EXACTLY as this
-- phase's own instructions specify, never trusting status alone (a
-- stale ACTIVE row with an expired paid-through period, or a stale
-- TRIALING row past its own trial end, must never produce indefinite
-- entitlement) and never trusting a client-supplied "now" (this
-- function's own `now()` call is the database's own trusted clock,
-- exactly like every other time-bound check in this schema —
-- record_invoice_payment's own future-date rejection, business_
-- invitations' own expiry check, etc.).
--
-- DELIBERATELY NOT gated on billing.view: unlike the raw subscription
-- ROW (provider codes, exact amounts, cancellation flags — genuinely
-- billing-sensitive detail), the single yes/no fact "is this business
-- currently entitled to use the product, and under which plan" is
-- exactly the kind of fact EVERY active member's own client needs for
-- future feature-gating (an ordinary SALES rep's UI needs to know "can
-- this business still create sales" without ever seeing what the OWNER
-- pays or which card is on file) — mirrors private.has_permission's own
-- precedent exactly: any active member may ask a fact-check question
-- about their OWN business, gated on membership alone, never on a
-- specific operational permission. SECURITY DEFINER is required for the
-- identical structural reason has_permission/is_business_member already
-- document: business_subscriptions FORCES row level security with no
-- SELECT policy that a plain member (without billing.view) could
-- satisfy, so a SECURITY INVOKER function would see nothing for them.
create or replace function private.get_business_entitlement(p_business_id uuid)
returns table (is_entitled boolean, plan_code text, status text, effective_until timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      (bs.status = 'TRIALING' and bs.trial_ends_at > now())
      or (bs.status = 'ACTIVE' and bs.current_period_ends_at > now())
      or (bs.status = 'PAST_DUE' and bs.grace_ends_at is not null and bs.grace_ends_at > now())
    ) as is_entitled,
    p.code as plan_code,
    bs.status,
    case
      when bs.status = 'TRIALING' then bs.trial_ends_at
      when bs.status = 'ACTIVE' then bs.current_period_ends_at
      when bs.status = 'PAST_DUE' then bs.grace_ends_at
      else null
    end as effective_until
  from public.business_subscriptions bs
  join public.subscription_plans p on p.id = bs.plan_id
  where bs.business_id = p_business_id
    and private.is_business_member(p_business_id);
$$;

revoke all on function private.get_business_entitlement(uuid) from public;
grant execute on function private.get_business_entitlement(uuid) to authenticated;

-- Public, server-callable wrapper — mirrors public.has_permission/
-- public.has_branch_access exactly (SECURITY INVOKER: does no privileged
-- work of its own, only forwards to the already-narrowly-scoped
-- DEFINER).
create or replace function public.get_business_entitlement(p_business_id uuid)
returns table (is_entitled boolean, plan_code text, status text, effective_until timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.get_business_entitlement(p_business_id);
$$;

revoke all on function public.get_business_entitlement(uuid) from public, anon;
grant execute on function public.get_business_entitlement(uuid) to authenticated, service_role;
