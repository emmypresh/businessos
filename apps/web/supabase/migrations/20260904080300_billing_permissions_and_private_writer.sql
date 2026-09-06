-- Phase 1L: billing.view/billing.manage permissions, the trusted
-- private_billing_writer role, and the narrow trusted transition
-- functions that are the ONLY way any business_subscriptions/
-- billing_transactions/private.billing_provider_events row can ever be
-- written.
--
-- ══════════════════════════════════════════════════════════════════════
-- PERMISSION MATRIX — CONSERVATIVE MVP, DOCUMENTED, NOT A DEFAULT.
-- ══════════════════════════════════════════════════════════════════════
--
-- billing.view: OWNER, ADMIN, ACCOUNTANT. Mirrors reports.view's/
-- invoices.view's own established "financial-oversight tier" precedent
-- exactly — ACCOUNTANT already holds the closest analogous permission
-- (reports.view) in this exact seeded matrix, and BusinessOS subscription
-- billing is a financial-oversight concern for the SAME tier of staff who
-- already see the business's own financial reports. MANAGER/SALES/
-- INVENTORY/VIEWER do NOT — none of them hold any existing financial-
-- oversight permission (reports.view/invoices.view/payments.view) either,
-- so extending them billing.view would be a NEW category of access this
-- matrix does not otherwise grant that tier anywhere else.
--
-- billing.manage: OWNER ONLY. This phase's own instructions frame
-- billing.manage as covering "start checkout, change plan, cancel
-- subscription, update billing email" — actions that change how much
-- money the BUSINESS ITSELF pays BusinessOS and its overall subscription
-- commitment, a decision this schema's own established hierarchy already
-- reserves to OWNER alone for comparably weighty decisions (e.g.
-- CANNOT_ASSIGN_OWNER_ROLE — only an OWNER may grant OWNER; LAST_OWNER_
-- REQUIRED — the business must always keep an OWNER). ADMIN is
-- deliberately EXCLUDED from billing.manage in this initial seeding:
-- ADMIN already holds broad staff/branch management authority in this
-- matrix, but has never been given authority over the business's own
-- external financial commitments (that line does not exist anywhere else
-- in this schema either) — widening ADMIN into subscription/payment
-- control is a real product decision with real financial consequence
-- that this phase's own instructions explicitly ask to be conservative
-- about, not a default to assume. If product policy later decides ADMIN
-- should manage billing, that is a normal, reviewable, additive
-- role_permissions INSERT — never a schema change.
insert into public.permissions (key, description) values
  ('billing.view',   'View the business subscription plan and billing/payment history.'),
  ('billing.manage', 'Manage the business subscription — change plan, cancel, update billing details.')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'ACCOUNTANT')
  and p.key = 'billing.view'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'OWNER'
  and p.key = 'billing.manage'
on conflict do nothing;

-- MANAGER, SALES, INVENTORY, and VIEWER deliberately get NEITHER —
-- subscription/billing is a business-financial-oversight concern, never
-- a floor-operations or generic-read-only one, mirroring reports.view's/
-- audit.view's own identical exclusion of those same four roles.

-- ══════════════════════════════════════════════════════════════════════
-- private_billing_writer — NOLOGIN NOINHERIT BYPASSRLS, non-superuser,
-- no CREATEDB, no CREATEROLE (the Postgres role-creation defaults
-- already exclude both unless explicitly granted, and this migration
-- never grants either) — the exact posture this phase's own
-- instructions specify, matching every other Phase 1C-1K private writer
-- role exactly.
-- ══════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_billing_writer') then
    create role private_billing_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_billing_writer to postgres;

grant usage on schema public to private_billing_writer;
grant usage on schema private to private_billing_writer;

-- Minimum privileges only, per column, matching this codebase's own
-- established least-privilege convention throughout.
grant select (id, code) on public.subscription_plans to private_billing_writer;
-- provider/provider_environment: added for SEC-1L-03 remediation —
-- activate_subscription_from_verified_payment now validates a supplied
-- price's own provider/environment against the caller's claimed
-- provider/environment, which requires reading both columns.
grant select (id, plan_id, provider, provider_environment, currency, amount_minor, billing_interval, is_active)
  on public.subscription_plan_prices to private_billing_writer;

-- Every column any trusted function ever READS from an existing row —
-- including columns read only via a `coalesce(p_param, existing_column)`
-- expression inside an UPDATE's own SET clause (e.g.
-- activate_subscription_from_verified_payment preserving an existing
-- provider_customer_code when none is supplied), which requires SELECT
-- privilege exactly like any other read, discovered live via a genuine
-- "permission denied for table business_subscriptions" regression in
-- this round's own test suite and fixed proactively here rather than
-- left as a recurring footgun (the same category of gotcha this
-- codebase has now hit multiple times — RETURNING clauses, ON CONFLICT
-- arbiter columns, and now UPDATE-SET coalesce reads all require SELECT
-- on top of the "obvious" privilege).
-- trial_ends_at/current_period_ends_at/grace_ends_at: added for
-- SEC-1L-01/SEC-1L-02 remediation — mark_subscription_expired now
-- proves the authoritative entitlement window has actually ended before
-- allowing a status transition, and record_subscription_renewal now
-- proves a renewal never moves paid-through time backwards; both
-- require reading these columns, not merely writing them.
grant select (
  id, business_id, status, cancel_at_period_end, provider_customer_code,
  provider_subscription_code, billing_interval, currency, amount_minor, canceled_at,
  trial_ends_at, current_period_ends_at, grace_ends_at
) on public.business_subscriptions to private_billing_writer;
grant insert (
  business_id, plan_id, price_id, provider, provider_environment,
  provider_customer_code, provider_subscription_code, status, billing_interval,
  currency, amount_minor, trial_started_at, trial_ends_at,
  current_period_started_at, current_period_ends_at
) on public.business_subscriptions to private_billing_writer;
grant update (
  plan_id, price_id, provider, provider_environment, provider_customer_code,
  provider_subscription_code, status, billing_interval, currency, amount_minor,
  current_period_started_at, current_period_ends_at, cancel_at_period_end,
  canceled_at, ended_at, grace_ends_at
) on public.business_subscriptions to private_billing_writer;

grant insert on public.billing_transactions to private_billing_writer;
grant select (id, provider, provider_reference) on public.billing_transactions to private_billing_writer;

grant insert on private.billing_provider_events to private_billing_writer;
-- event_type/payload_hash/business_id/subscription_id: added for
-- SEC-1L-04 remediation — record_provider_event now compares these
-- immutable identity fields against an existing row on a (provider,
-- provider_event_key) conflict, to distinguish a legitimate replay from
-- a changed-payload/mismatched-association conflict.
grant select (id, provider, provider_event_key, event_type, payload_hash, business_id, subscription_id)
  on private.billing_provider_events to private_billing_writer;
grant update (processing_status, processed_at, error_code, business_id, subscription_id)
  on private.billing_provider_events to private_billing_writer;

-- ══════════════════════════════════════════════════════════════════════
-- TRUSTED TRANSITION FUNCTIONS.
--
-- CANONICAL LOCKING ORDER for any future writer that touches more than
-- one of these tables in one transaction: businesses -> business_
-- subscriptions -> private.billing_provider_events -> billing_
-- transactions. Every function below that locks a row locks
-- business_subscriptions FIRST (via `for update`), before it ever reads
-- or writes billing_transactions/billing_provider_events — this fixed
-- order is what makes two concurrent transitions on the SAME business
-- (e.g. a renewal and a cancellation racing) serialize safely instead of
-- deadlocking, mirroring this codebase's own established "document the
-- lock order, prove it under test" convention (e.g. create_sale_return's
-- own SEC-01I branch-lifecycle serialization).
--
-- WHY NARROW TRANSITION FUNCTIONS, NEVER ONE GENERIC "set_subscription_
-- status(...)": a single broad setter accepting an arbitrary target
-- status and arbitrary period/provider fields is exactly the kind of
-- surface this phase's own instructions warn a future integration could
-- misuse — it would let ANY future caller move a subscription to ANY
-- state with ANY fields, with no function-level guarantee that the
-- combination is even legitimate (e.g. "ACTIVE with no period bounds").
-- Each function below expresses exactly ONE real business event, with
-- its own preconditions and its own narrow parameter set — the state
-- machine's own invariants are enforced by WHICH function was called,
-- not by trusting every caller to pass a self-consistent status/field
-- combination.
--
-- ZERO EXTERNAL EXECUTE GRANTS (per this phase's own explicit
-- instruction: "At DB-foundation stage, it is acceptable for ingestion
-- functions to have ZERO external EXECUTE callers... preferable to
-- prematurely exposing a generic billing writer"): every function below
-- is owned by private_billing_writer, and EXECUTE is revoked from
-- PUBLIC/anon/authenticated/service_role and granted to NO role at all —
-- identical posture to private.record_audit_event's own DB-foundation-
-- round bootstrapping and private.create_notification's own identical
-- choice. A future Phase 1L APPLICATION round grants EXECUTE to
-- whichever specific, narrowly-scoped server-side integration boundary
-- (e.g. the webhook-ingestion Route Handler's own service-role-adjacent
-- caller) actually needs each one, one at a time, exactly like every
-- other phase's own established instrumentation pattern.
-- ══════════════════════════════════════════════════════════════════════

-- create_initial_trial: the ONE way a business_subscriptions row is ever
-- first created. GROWTH, TRIALING, 14 days, provider MANUAL (there is no
-- real payment relationship yet — no payment method is required merely
-- to start a trial, per this phase's own explicit product direction).
-- "One legitimate initial trial per business" is enforced structurally
-- by business_subscriptions.business_id's own UNIQUE constraint — a
-- second call for the same business converts into a clean, controlled
-- SUBSCRIPTION_ALREADY_EXISTS error, never a raw constraint-violation
-- leak, and never a second row. trial_started_at/trial_ends_at are
-- computed from THIS FUNCTION's own `now()` call — the database's own
-- trusted clock — never accepted as a parameter, so no caller of any
-- kind (however this function is eventually exposed) can ever supply a
-- backdated or extended trial window.
create or replace function private.create_initial_trial(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_id uuid;
  v_id      uuid;
begin
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  select id into v_plan_id from public.subscription_plans where code = 'GROWTH';
  if v_plan_id is null then
    -- Structurally unreachable given this phase's own seed data, but
    -- checked explicitly rather than allowing a raw NOT NULL violation
    -- on the insert below to leak as the public error contract.
    raise exception 'GROWTH_PLAN_NOT_FOUND' using errcode = '22023';
  end if;

  begin
    insert into public.business_subscriptions (
      business_id, plan_id, provider, status, currency,
      trial_started_at, trial_ends_at
    ) values (
      p_business_id, v_plan_id, 'MANUAL', 'TRIALING', 'NGN',
      now(), now() + interval '14 days'
    )
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'SUBSCRIPTION_ALREADY_EXISTS' using errcode = '23505';
  end;

  return v_id;
end;
$$;

-- activate_subscription_from_verified_payment: the ONE way a
-- subscription becomes ACTIVE — called ONLY after the future app-layer
-- webhook/checkout verifier has ALREADY confirmed a real payment with
-- the provider (this function itself trusts every parameter completely;
-- it has no way to independently verify a payment, by design — that
-- verification is exactly the app-layer responsibility this phase's own
-- instructions describe in the "app layer later must..." section, which
-- is deliberately NOT implemented here). If p_price_id is supplied, it
-- MUST be an active price belonging to the SAME plan — never trusted
-- from the caller's own claim, mirroring every other cross-table
-- consistency check in this schema (record_audit_event's own branch-
-- consistency check, etc.).
create or replace function private.activate_subscription_from_verified_payment(
  p_business_id                 uuid,
  p_plan_id                     uuid,
  p_provider                    text,
  p_period_start                timestamptz,
  p_period_end                  timestamptz,
  p_price_id                    uuid default null,
  p_provider_environment        text default null,
  p_provider_customer_code      text default null,
  p_provider_subscription_code  text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id                 uuid;
  v_found              uuid;
  v_price_plan_id      uuid;
  v_price_provider     text;
  v_price_environment  text;
  v_price_currency     text;
  v_price_amount       bigint;
  v_price_interval     text;
begin
  if p_business_id is null or p_plan_id is null or p_provider is null
     or p_period_start is null or p_period_end is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_provider not in ('PAYSTACK', 'MANUAL') then
    raise exception 'INVALID_BILLING_PROVIDER' using errcode = '22023';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'INVALID_BILLING_PERIOD' using errcode = '22023';
  end if;

  -- Lock FIRST, per this migration's own canonical locking order.
  select id into v_found
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_found is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;

  if p_price_id is not null then
    select plan_id, provider, provider_environment, currency, amount_minor, billing_interval
    into v_price_plan_id, v_price_provider, v_price_environment, v_price_currency, v_price_amount, v_price_interval
    from public.subscription_plan_prices
    where id = p_price_id and is_active;

    if v_price_plan_id is null then
      raise exception 'PRICE_NOT_FOUND' using errcode = '22023';
    end if;
    if v_price_plan_id <> p_plan_id then
      raise exception 'PRICE_PLAN_MISMATCH' using errcode = '22023';
    end if;
    -- SEC-1L-03 remediation: a price's own provider/environment must
    -- match what THIS CALL claims — never trusted independently. Without
    -- this, a caller could activate with p_provider = 'PAYSTACK',
    -- p_provider_environment = 'LIVE' while pointing p_price_id at a
    -- TEST (or even a structurally-impossible-for-MANUAL) price, leaving
    -- an authoritative subscription row whose own provider/environment
    -- contradicts the price it claims to be paying. currency/amount_
    -- minor/billing_interval are NOT independently supplied by any
    -- caller (they are always DERIVED from the price itself, below), so
    -- they can never contradict the price by construction and need no
    -- separate equality check here.
    if v_price_provider <> p_provider then
      raise exception 'PRICE_PROVIDER_MISMATCH' using errcode = '22023';
    end if;
    if v_price_environment is distinct from p_provider_environment then
      raise exception 'PRICE_ENVIRONMENT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  update public.business_subscriptions
  set plan_id                    = p_plan_id,
      price_id                   = p_price_id,
      provider                   = p_provider,
      provider_environment       = p_provider_environment,
      provider_customer_code     = coalesce(p_provider_customer_code, provider_customer_code),
      provider_subscription_code = coalesce(p_provider_subscription_code, provider_subscription_code),
      status                     = 'ACTIVE',
      billing_interval           = coalesce(v_price_interval, billing_interval),
      currency                   = coalesce(v_price_currency, currency),
      amount_minor               = coalesce(v_price_amount, amount_minor),
      current_period_started_at  = p_period_start,
      current_period_ends_at     = p_period_end,
      cancel_at_period_end       = false,
      canceled_at                = null,
      grace_ends_at              = null
  where business_id = p_business_id
  returning id into v_id;

  return v_id;
end;
$$;

-- record_subscription_renewal: extends the CURRENT period bounds for an
-- already-ACTIVE or already-PAST_DUE (a late payment that just
-- succeeded) subscription — never creates a row, never changes plan/
-- provider identity.
--
-- SEC-1L-02(A) MONOTONICITY CONTRACT: a renewal can never move
-- already-earned paid-through access backwards. p_period_end must be
-- >= the existing current_period_ends_at — a strictly later end is the
-- ordinary "genuine renewal" case; EQUALITY is deliberately still
-- ACCEPTED and defined as idempotent replay/no-op semantics (a retried
-- renewal call carrying the identical period end is safe to re-apply:
-- it reasserts the exact same entitlement window this row already has,
-- and the rest of this function's own transition — status -> ACTIVE,
-- clearing stale grace_ends_at/ended_at — is itself idempotent, so
-- replaying it changes nothing that matters). A SHORTER new period is
-- rejected outright: RENEWAL_PERIOD_NOT_ADVANCING.
create or replace function private.record_subscription_renewal(
  p_business_id  uuid,
  p_period_start timestamptz,
  p_period_end   timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id                  uuid;
  v_status              text;
  v_existing_period_end timestamptz;
begin
  if p_business_id is null or p_period_start is null or p_period_end is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'INVALID_BILLING_PERIOD' using errcode = '22023';
  end if;

  select id, status, current_period_ends_at into v_id, v_status, v_existing_period_end
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_id is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status not in ('ACTIVE', 'PAST_DUE') then
    raise exception 'SUBSCRIPTION_NOT_RENEWABLE' using errcode = '23514';
  end if;
  if v_existing_period_end is not null and p_period_end < v_existing_period_end then
    raise exception 'RENEWAL_PERIOD_NOT_ADVANCING' using errcode = '23514';
  end if;

  -- cancel_at_period_end/canceled_at are DELIBERATELY left untouched —
  -- only schedule_subscription_cancel/mark_subscription_expired ever
  -- set or clear those fields, preserving each trusted function's own
  -- narrow, single-responsibility contract (see this migration's own
  -- "WHY NARROW TRANSITION FUNCTIONS" header comment). ended_at is
  -- cleared defensively: ACTIVE/PAST_DUE rows never legitimately carry
  -- one (only EXPIRED requires it), but a renewal is exactly the
  -- "access is definitely continuing" event, so any stale value there
  -- must never survive it.
  update public.business_subscriptions
  set status                    = 'ACTIVE',
      current_period_started_at = p_period_start,
      current_period_ends_at    = p_period_end,
      grace_ends_at             = null,
      ended_at                  = null
  where business_id = p_business_id;

  return v_id;
end;
$$;

-- record_subscription_payment_failed: ACTIVE -> PAST_DUE only (a
-- subscription that was never ACTIVE has nothing to fail a RENEWAL
-- charge on).
--
-- SEC-1L-02(B) REMEDIATION (OPTION 1 — the phase's own preferred
-- design): this function NO LONGER accepts a caller-supplied
-- grace_ends_at at all. A caller-controlled absolute grace timestamp
-- would let ANY future caller of this DB-foundation primitive grant an
-- arbitrary, unbounded entitlement window merely by passing a
-- far-future value — this function has no way to validate that value
-- against any commercial policy, because no such policy has been
-- decided yet (see business_subscriptions' own "GRACE POLICY" header
-- comment: "do not hard-code 3/7/etc days... Actual grace duration can
-- be decided in app/product layer"). This function therefore always
-- sets grace_ends_at = NULL on a payment failure: per private.
-- get_business_entitlement's own formula, PAST_DUE with a NULL
-- grace_ends_at is NEVER entitled — a payment failure now ALWAYS ends
-- entitlement immediately, with zero grace, until a future, narrowly
-- reviewed, separate grace-POLICY-setting primitive is deliberately
-- introduced at the app/product layer. current_period_started_at/
-- current_period_ends_at are left untouched (they remain accurate
-- historical/current billing-period context, not entitlement facts, in
-- PAST_DUE).
create or replace function private.record_subscription_payment_failed(
  p_business_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_status text;
begin
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  select id, status into v_id, v_status
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_id is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'SUBSCRIPTION_NOT_ACTIVE' using errcode = '23514';
  end if;

  update public.business_subscriptions
  set status = 'PAST_DUE', grace_ends_at = null
  where business_id = p_business_id;

  return v_id;
end;
$$;

-- schedule_subscription_cancel: sets ONLY the cancel_at_period_end flag
-- (+ canceled_at, a timestamp of the REQUEST, not of ending access) —
-- see business_subscriptions' own "CRITICAL DISTINCTION" header comment
-- for the full rationale on why this never touches `status`.
create or replace function private.schedule_subscription_cancel(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_status text;
begin
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  select id, status into v_id, v_status
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_id is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status not in ('TRIALING', 'ACTIVE', 'PAST_DUE') then
    raise exception 'SUBSCRIPTION_NOT_CANCELABLE' using errcode = '23514';
  end if;

  update public.business_subscriptions
  set cancel_at_period_end = true,
      canceled_at = now()
  where business_id = p_business_id;

  return v_id;
end;
$$;

-- mark_subscription_expired: the ONE way access DEFINITIVELY ends —
-- chooses CANCELED (if a cancellation was previously scheduled) or
-- EXPIRED (otherwise), per business_subscriptions' own "CRITICAL
-- DISTINCTION" comment. Idempotent against being called on an
-- already-ended row (raises a controlled error rather than silently
-- re-setting ended_at/canceled_at to a new, later time on replay).
--
-- SEC-1L-01 REMEDIATION — EXPIRY-BOUNDARY CONTRACT: this function must
-- never terminate access earlier than the authoritative entitlement
-- window this SAME row already promises, regardless of what any future
-- caller (a trusted scheduler, a cron sweep, a webhook-driven wrapper)
-- believes. It proves the window has genuinely elapsed, using this
-- function's own `now()` call — never a caller-supplied time — before
-- allowing ANY transition:
--   TRIALING  — rejected while trial_ends_at > now(); allowed only once
--               trial_ends_at <= now().
--   ACTIVE    — rejected while current_period_ends_at > now(); allowed
--               only once current_period_ends_at <= now().
--   PAST_DUE  — if grace_ends_at IS NOT NULL: rejected while
--               grace_ends_at > now(), allowed once grace_ends_at <=
--               now(). If grace_ends_at IS NULL (the only value
--               record_subscription_payment_failed ever sets per its
--               own SEC-1L-02(B) contract): rejected while the
--               UNDERLYING current_period_ends_at > now(), allowed once
--               it has passed — a PAST_DUE row is never expirable
--               before the paid-through period it fell behind on has
--               itself actually ended, grace or no grace.
--   INCOMPLETE — no time-bound field is required for this state (see
--               business_subscriptions' own state-machine header
--               comment) and it grants NO entitlement at all, so there
--               is no valid entitlement window this transition could
--               ever end prematurely — expiry is unconditional.
-- On rejection, NO row is mutated (the check runs before either UPDATE
-- branch), and the row lock taken by the initial `for update` is simply
-- released at rollback/return — never a partial or silently-corrected
-- write.
create or replace function private.mark_subscription_expired(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id               uuid;
  v_status           text;
  v_cancel_flag      boolean;
  v_trial_ends_at    timestamptz;
  v_period_ends_at   timestamptz;
  v_grace_ends_at    timestamptz;
begin
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  select id, status, cancel_at_period_end, trial_ends_at, current_period_ends_at, grace_ends_at
  into v_id, v_status, v_cancel_flag, v_trial_ends_at, v_period_ends_at, v_grace_ends_at
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_id is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status not in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'INCOMPLETE') then
    raise exception 'SUBSCRIPTION_ALREADY_ENDED' using errcode = '23514';
  end if;

  if v_status = 'TRIALING' then
    if v_trial_ends_at > now() then
      raise exception 'SUBSCRIPTION_NOT_YET_EXPIRABLE' using errcode = '23514';
    end if;
  elsif v_status = 'ACTIVE' then
    if v_period_ends_at > now() then
      raise exception 'SUBSCRIPTION_NOT_YET_EXPIRABLE' using errcode = '23514';
    end if;
  elsif v_status = 'PAST_DUE' then
    if v_grace_ends_at is not null then
      if v_grace_ends_at > now() then
        raise exception 'SUBSCRIPTION_NOT_YET_EXPIRABLE' using errcode = '23514';
      end if;
    elsif v_period_ends_at > now() then
      raise exception 'SUBSCRIPTION_NOT_YET_EXPIRABLE' using errcode = '23514';
    end if;
  end if;
  -- INCOMPLETE: unconditional — see this function's own header comment.

  if v_cancel_flag then
    update public.business_subscriptions
    set status = 'CANCELED', canceled_at = coalesce(canceled_at, now())
    where business_id = p_business_id;
  else
    update public.business_subscriptions
    set status = 'EXPIRED', ended_at = now()
    where business_id = p_business_id;
  end if;

  return v_id;
end;
$$;

-- record_billing_transaction: idempotent, per (provider,
-- provider_reference) — a retried confirmation or a duplicate webhook-
-- driven call for the SAME payment attempt can never produce two rows.
-- Never trusts amount/status/currency from a browser (this function has
-- no browser caller at all; the future app-layer verifier is what
-- derives these from the PROVIDER's own confirmed response, never from
-- client-supplied form data — per this phase's own explicit "never
-- trust amount/status supplied by browser" instruction).
create or replace function private.record_billing_transaction(
  p_business_id                uuid,
  p_subscription_id            uuid,
  p_provider                   text,
  p_provider_reference         text,
  p_amount_minor               bigint,
  p_currency                   text,
  p_status                     text,
  p_provider_transaction_code  text default null,
  p_paid_at                    timestamptz default null,
  p_failed_at                  timestamptz default null,
  p_failure_code               text default null,
  p_failure_message            text default null,
  p_provider_channel           text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id             uuid;
  v_sub_business   uuid;
begin
  if p_business_id is null or p_subscription_id is null or p_provider is null
     or p_provider_reference is null or p_amount_minor is null or p_currency is null
     or p_status is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_provider not in ('PAYSTACK', 'MANUAL') then
    raise exception 'INVALID_BILLING_PROVIDER' using errcode = '22023';
  end if;
  if p_status not in ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED') then
    raise exception 'INVALID_TRANSACTION_STATUS' using errcode = '22023';
  end if;
  if p_amount_minor < 0 then
    raise exception 'INVALID_TRANSACTION_AMOUNT' using errcode = '22023';
  end if;
  if p_status = 'SUCCESS' and p_paid_at is null then
    raise exception 'PAID_AT_REQUIRED' using errcode = '22023';
  end if;
  if p_status = 'FAILED' and p_failed_at is null then
    raise exception 'FAILED_AT_REQUIRED' using errcode = '22023';
  end if;

  -- Tenant-consistency: the subscription must genuinely belong to the
  -- claimed business — never trusted from the caller's own pairing.
  select business_id into v_sub_business
  from public.business_subscriptions
  where id = p_subscription_id;
  if v_sub_business is null or v_sub_business <> p_business_id then
    raise exception 'SUBSCRIPTION_BUSINESS_MISMATCH' using errcode = '22023';
  end if;

  insert into public.billing_transactions (
    business_id, subscription_id, provider, provider_reference, provider_transaction_code,
    amount_minor, currency, status, paid_at, failed_at, failure_code, failure_message, provider_channel
  ) values (
    p_business_id, p_subscription_id, p_provider, p_provider_reference, p_provider_transaction_code,
    p_amount_minor, p_currency, p_status, p_paid_at, p_failed_at, p_failure_code, p_failure_message, p_provider_channel
  )
  on conflict (provider, provider_reference) do nothing
  returning id into v_id;

  if v_id is null then
    -- Replay: return the EXISTING transaction's id, untouched — never
    -- re-recorded, never overwritten with possibly-different replayed
    -- values.
    select id into v_id from public.billing_transactions
    where provider = p_provider and provider_reference = p_provider_reference;
  end if;

  return v_id;
end;
$$;

-- record_provider_event: idempotent provider-event ingestion, per
-- (provider, provider_event_key) — see private.billing_provider_events'
-- own header comment for the full "do not invent a provider event ID"
-- rationale this trusts the CALLER to have already resolved. Returns
-- whether THIS call newly claimed the event (`is_new`) — the future
-- app-layer webhook handler uses this to decide whether to proceed with
-- actually PROCESSING the event or to treat it as an already-handled
-- replay.
--
-- SEC-1L-04(B) REPLAY/CONFLICT CONTRACT: on a (provider,
-- provider_event_key) collision, this function no longer silently
-- treats every collision as a harmless replay. It locks the existing
-- row and compares its immutable identity fields — event_type,
-- payload_hash, business_id, subscription_id — against THIS call's own
-- values, using IS NOT DISTINCT FROM (null-safe: two NULLs compare
-- equal, a NULL against a non-null value does not) for every
-- comparison:
--   EXACT match (including both sides NULL on business_id/
--   subscription_id) -> legitimate idempotent replay: returns the
--   EXISTING row's id, is_new = false, no mutation.
--   ANY mismatch -> PROVIDER_EVENT_CONFLICT, a stable, controlled
--   error — evidence of an event-key collision, a provider-side
--   inconsistency, an incorrect event derivation upstream, or outright
--   tampering/misrouting. Never silently absorbed into either the old
--   or the new value.
create or replace function private.record_provider_event(
  p_provider            text,
  p_provider_event_key  text,
  p_event_type          text,
  p_payload_hash        text,
  p_business_id         uuid default null,
  p_subscription_id     uuid default null
)
returns table (id uuid, is_new boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id                 uuid;
  v_existing_type      text;
  v_existing_hash      text;
  v_existing_business  uuid;
  v_existing_sub       uuid;
begin
  if p_provider is null or p_provider_event_key is null or p_event_type is null or p_payload_hash is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;
  if p_provider not in ('PAYSTACK') then
    raise exception 'INVALID_BILLING_PROVIDER' using errcode = '22023';
  end if;
  if p_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' or length(p_event_type) > 100 then
    raise exception 'INVALID_EVENT_TYPE' using errcode = '22023';
  end if;
  if p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_PAYLOAD_HASH' using errcode = '22023';
  end if;

  insert into private.billing_provider_events (
    provider, provider_event_key, event_type, business_id, subscription_id, payload_hash
  ) values (
    p_provider, p_provider_event_key, p_event_type, p_business_id, p_subscription_id, p_payload_hash
  )
  on conflict (provider, provider_event_key) do nothing
  returning private.billing_provider_events.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  -- Conflict: a row for this (provider, provider_event_key) already
  -- exists. Lock it (the ON CONFLICT DO NOTHING above already took a
  -- lock on it for the duration of this same transaction if a
  -- concurrent inserter is mid-flight, so this blocks until that
  -- transaction resolves rather than racing it — the identical
  -- technique this schema's own record_billing_transaction/
  -- create_initial_trial idempotency primitives already rely on) and
  -- compare immutable identity fields before deciding replay vs.
  -- conflict.
  select private.billing_provider_events.id, event_type, payload_hash, business_id, subscription_id
  into v_id, v_existing_type, v_existing_hash, v_existing_business, v_existing_sub
  from private.billing_provider_events
  where provider = p_provider and provider_event_key = p_provider_event_key
  for update;

  if v_id is null then
    -- Structurally unreachable (the conflict above already proved a row
    -- exists, and no role can ever DELETE from this table), guarded
    -- rather than assumed.
    raise exception 'PROVIDER_EVENT_NOT_FOUND' using errcode = '22023';
  end if;

  if v_existing_type is distinct from p_event_type
     or v_existing_hash is distinct from p_payload_hash
     or v_existing_business is distinct from p_business_id
     or v_existing_sub is distinct from p_subscription_id then
    raise exception 'PROVIDER_EVENT_CONFLICT' using errcode = '23514';
  end if;

  return query select v_id, false;
end;
$$;

-- Ownership transfer — every function above, CREATE on schema private
-- temporarily (to allow the ALTER OWNER), then revoked, matching this
-- codebase's own established ownership-transfer dance exactly.
grant create on schema private to private_billing_writer;
alter function private.create_initial_trial(uuid) owner to private_billing_writer;
alter function private.activate_subscription_from_verified_payment(
  uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text
) owner to private_billing_writer;
alter function private.record_subscription_renewal(uuid, timestamptz, timestamptz) owner to private_billing_writer;
-- Signature narrowed to (uuid) by SEC-1L-02(B) remediation — see this
-- function's own header comment.
alter function private.record_subscription_payment_failed(uuid) owner to private_billing_writer;
alter function private.schedule_subscription_cancel(uuid) owner to private_billing_writer;
alter function private.mark_subscription_expired(uuid) owner to private_billing_writer;
alter function private.record_billing_transaction(
  uuid, uuid, text, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) owner to private_billing_writer;
alter function private.record_provider_event(text, text, text, text, uuid, uuid) owner to private_billing_writer;
revoke create on schema private from private_billing_writer;

-- No EXECUTE grant to ANY role — see this migration's own header
-- comment for the full rationale.
revoke all on function private.create_initial_trial(uuid) from public, anon, authenticated, service_role;
revoke all on function private.activate_subscription_from_verified_payment(
  uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.record_subscription_renewal(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.record_subscription_payment_failed(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.schedule_subscription_cancel(uuid) from public, anon, authenticated, service_role;
revoke all on function private.mark_subscription_expired(uuid) from public, anon, authenticated, service_role;
revoke all on function private.record_billing_transaction(
  uuid, uuid, text, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.record_provider_event(text, text, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
