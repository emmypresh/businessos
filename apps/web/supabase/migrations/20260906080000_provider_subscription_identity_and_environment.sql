-- Phase 1L — APPLICATION REMEDIATION (APP-1L-02, APP-1L-03). Adds the
-- ONE genuinely new column this round's findings require
-- (provider_email_token — inspected first: provider_subscription_code
-- already exists, frozen, since 20260904080100_create_business_subscriptions.sql;
-- this migration never duplicates it), plus the trusted, narrowly-scoped
-- functions needed to (a) persist VERIFIED provider subscription
-- identity from a signed subscription.create event, and (b) let the
-- owner-facing cancellation flow load just enough of that identity,
-- server-side only, to call Paystack's own Disable Subscription
-- endpoint — never exposing it anywhere else.
--
-- This migration NEVER alters any frozen Phase 1A-1L migration file, and
-- never touches private_billing_writer's own frozen ownership set (still
-- exactly the 8 DB-foundation functions — see
-- subscription-billing-foundation.test.ts's own "52." test, unchanged by
-- this round). Every new function below is owned by one of the two
-- ALREADY-EXISTING (uncommitted, this-round) application writer roles —
-- private_billing_provider_writer (webhook/service-role-only surface) or
-- private_billing_action_writer (owner-authenticated surface) — with
-- only the exact additional column grants each specific new function
-- needs, never a blanket widening.

-- provider_email_token ---------------------------------------------------
--
-- Paystack's own per-subscription token, required by its Disable
-- Subscription endpoint alongside the subscription code — delivered
-- ONLY in a verified subscription.create webhook payload, never
-- accepted from any browser/client input anywhere in this codebase.
-- Bounded (Paystack tokens are short opaque strings; 500 chars is a
-- generous, structurally-enforced ceiling, not a guess at the real
-- length). Nullable: a subscription may not have received its
-- subscription.create event yet, and MANUAL/enterprise subscriptions
-- never have one at all (same rationale as provider_subscription_code's
-- own nullability).
alter table public.business_subscriptions
  add column provider_email_token text
    check (provider_email_token is null or length(provider_email_token) <= 500);

-- No grant to `authenticated`, `anon`, or `service_role` directly on this
-- column, anywhere in this migration — see this migration's own header
-- comment. The ONLY two grants below are to private_billing_provider_writer,
-- scoped to exactly the two new functions that legitimately touch it.
grant select (id, provider_subscription_code, provider_environment, provider_email_token)
  on public.business_subscriptions to private_billing_provider_writer;
grant update (provider_customer_code, provider_subscription_code, provider_email_token)
  on public.business_subscriptions to private_billing_provider_writer;
-- schedule_paystack_subscription_cancellation (below) needs this to
-- forward to the frozen private.schedule_subscription_cancel.
grant execute on function private.schedule_subscription_cancel(uuid) to private_billing_provider_writer;

-- ══════════════════════════════════════════════════════════════════════
-- APP-1L-01 REMEDIATION — environment-aware provider customer lookup.
-- ══════════════════════════════════════════════════════════════════════
--
-- The frozen DB foundation's own NULLS NOT DISTINCT unique index
-- (business_subscriptions_provider_customer_code_unique_idx) is already
-- scoped to (provider, provider_environment, provider_customer_code) —
-- i.e. it ALREADY intentionally permits the identical customer code to
-- exist once in TEST and once in LIVE. The Phase 1L application round's
-- own find_paystack_business_by_customer_code (20260905080200_billing_
-- provider_writer.sql) never carried that same environment scoping
-- forward into its own lookup — an ambiguous, environment-less `LIMIT 1`
-- over that set. Replaced here (CREATE OR REPLACE — this function is
-- part of this ROUND's own still-uncommitted application-layer work, not
-- a frozen migration) to require and validate p_provider_environment
-- explicitly, exactly like every other provider-facing function in this
-- schema.
create or replace function public.find_paystack_business_by_customer_code(
  p_provider_customer_code text,
  p_provider_environment   text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_provider_environment not in ('TEST', 'LIVE') then
    raise exception 'INVALID_PROVIDER_ENVIRONMENT' using errcode = '22023';
  end if;

  return (
    select business_id
    from public.business_subscriptions
    where provider = 'PAYSTACK'
      and provider_environment = p_provider_environment
      and provider_customer_code = p_provider_customer_code
  );
end;
$$;

-- Old single-argument overload is dropped, not merely left unreferenced
-- — a stale overload with a weaker (environment-less) contract must
-- never remain callable.
drop function if exists public.find_paystack_business_by_customer_code(text);

revoke all on function public.find_paystack_business_by_customer_code(text, text) from public, anon, authenticated;
grant execute on function public.find_paystack_business_by_customer_code(text, text) to service_role;

-- ══════════════════════════════════════════════════════════════════════
-- APP-1L-02 REMEDIATION — persist verified provider subscription
-- identity; reject silent identity replacement.
-- ══════════════════════════════════════════════════════════════════════
--
-- bind_paystack_subscription_identity: the ONE way provider_subscription_code/
-- provider_email_token are ever written, from a webhook-verified
-- subscription.create event exclusively (called from
-- lib/billing/webhook-handlers.ts, service_role only — see the EXECUTE
-- grant below). Never accepts either value from a browser: this
-- function's own caller (the webhook route) only ever reaches here after
-- independently verifying the Paystack HMAC signature over the raw
-- request body.
--
-- CUSTOMER-CODE CROSS-CHECK: the event's own customer code must match
-- what THIS business is already bound to (or the business is not yet
-- bound to any customer code at all) — never trusted merely because an
-- earlier lookup (find_paystack_business_by_customer_code) happened to
-- resolve here; that resolution and this write are two independent
-- checks.
--
-- CONFLICT, NEVER SILENT REPLACEMENT: a business already bound to
-- provider_subscription_code S1 that receives a verified subscription.create
-- for a DIFFERENT code S2 raises PROVIDER_SUBSCRIPTION_CONFLICT rather
-- than silently overwriting S1 with S2 — per this round's own explicit
-- "a provider customer may have more than one historical or concurrent
-- subscription" finding (APP-1L-02). A genuine plan-change/resubscribe
-- flow that intentionally rebinds to a new subscription code is a future,
-- separate, explicitly-reviewed transition — not something this
-- foundation-level identity writer infers on its own from event shape.
create or replace function private.bind_paystack_subscription_identity(
  p_business_id                 uuid,
  p_provider_customer_code      text,
  p_provider_subscription_code  text,
  p_provider_email_token        text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id                         uuid;
  v_current_customer_code      text;
  v_current_subscription_code  text;
begin
  if p_business_id is null or p_provider_customer_code is null or p_provider_subscription_code is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;

  select id, provider_customer_code, provider_subscription_code
  into v_id, v_current_customer_code, v_current_subscription_code
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_id is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;

  if v_current_customer_code is not null and v_current_customer_code <> p_provider_customer_code then
    raise exception 'PROVIDER_CUSTOMER_MISMATCH' using errcode = '23514';
  end if;

  if v_current_subscription_code is not null and v_current_subscription_code <> p_provider_subscription_code then
    raise exception 'PROVIDER_SUBSCRIPTION_CONFLICT' using errcode = '23514';
  end if;

  update public.business_subscriptions
  set provider_customer_code     = p_provider_customer_code,
      provider_subscription_code = p_provider_subscription_code,
      provider_email_token       = coalesce(p_provider_email_token, provider_email_token)
  where business_id = p_business_id;

  return v_id;
end;
$$;

-- ACL-1L-01 remediation: PostgreSQL grants EXECUTE on every newly
-- created function to PUBLIC by default — every other function in this
-- migration (and its siblings) explicitly revokes that default before
-- granting the one intended role; this PRIVATE function was missed. Both
-- the default PUBLIC grant AND every other role are revoked explicitly
-- here, exactly like this migration's own public.* wrappers already do,
-- so this function's own live ACL never depends on an unstated default.
revoke all on function private.bind_paystack_subscription_identity(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.bind_paystack_subscription_identity(uuid, text, text, text)
  to private_billing_provider_writer;

create or replace function public.bind_paystack_subscription_identity(
  p_business_id                 uuid,
  p_provider_customer_code      text,
  p_provider_subscription_code  text,
  p_provider_email_token        text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.bind_paystack_subscription_identity(
    p_business_id, p_provider_customer_code, p_provider_subscription_code, p_provider_email_token
  );
$$;

revoke all on function public.bind_paystack_subscription_identity(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bind_paystack_subscription_identity(uuid, text, text, text) to service_role;

-- ══════════════════════════════════════════════════════════════════════
-- APP-1L-03 REMEDIATION — real provider-side cancellation support.
-- ══════════════════════════════════════════════════════════════════════
--
-- get_paystack_subscription_disable_context: the ONLY path
-- provider_subscription_code/provider_email_token are ever read back OUT
-- of the database for use outside a webhook — called by
-- lib/billing/actions.ts's own cancelSubscriptionAction, via the SAME
-- service-role admin client the webhook route already uses
-- (lib/billing/admin-client.ts), NEVER via the caller's own authenticated
-- session. EXECUTE is granted to service_role ONLY — an ordinary
-- authenticated session (reachable via the browser's own JWT) can never
-- call this function and can never read provider_email_token through any
-- other path either (no grant on that column exists for `authenticated`
-- anywhere — see this migration's own header comment). Authorization
-- (billing.manage) is verified by the calling Server Action itself,
-- using the USER's own session, BEFORE this function is ever reached —
-- exactly like the webhook route's own established "authorize first with
-- the ordinary session/signature, then switch to the service-role
-- boundary for the sensitive part" pattern.
create or replace function public.get_paystack_subscription_disable_context(p_business_id uuid)
returns table (
  provider                    text,
  provider_environment        text,
  provider_subscription_code  text,
  provider_email_token        text
)
language sql
stable
security definer
set search_path = ''
as $$
  select provider, provider_environment, provider_subscription_code, provider_email_token
  from public.business_subscriptions
  where business_id = p_business_id;
$$;

revoke all on function public.get_paystack_subscription_disable_context(uuid) from public, anon, authenticated;
grant execute on function public.get_paystack_subscription_disable_context(uuid) to service_role;

-- schedule_paystack_subscription_cancellation: the PROVIDER-INITIATED
-- counterpart to the owner-facing public.request_subscription_cancellation
-- (20260905080100_billing_action_writer.sql) — called ONLY from the
-- subscription.disable webhook handler, after it has independently
-- confirmed the event's own environment/customer-code/subscription-code
-- all match the business's CURRENTLY BOUND identity (see
-- lib/billing/webhook-handlers.ts). Forwards to the identical frozen
-- private.schedule_subscription_cancel primitive the owner-facing path
-- uses — flag-only, never ends a valid paid period early (see that
-- frozen function's own header comment) — so an EXTERNAL Paystack-side
-- disable produces the exact same safe, boundary-respecting local state
-- as an owner-initiated one.
create or replace function public.schedule_paystack_subscription_cancellation(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := private.schedule_subscription_cancel(p_business_id);

  perform private.record_audit_event(
    p_business_id   => p_business_id,
    p_actor_type    => 'SYSTEM',
    p_actor_user_id => null,
    p_action        => 'subscription.cancellation_scheduled',
    p_category      => 'FINANCE',
    p_resource_type => 'business_subscription',
    p_resource_id   => v_id,
    p_metadata      => jsonb_build_object('provider', 'PAYSTACK', 'origin', 'provider_disable')
  );

  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.cancellation_scheduled',
    p_title                => 'Subscription cancellation scheduled',
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'Paystack reported this subscription as canceled. Access continues until the end of the current billing period.',
    p_severity             => 'INFO',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    -- Fixed, per-subscription dedup key — SAME key an owner-initiated
    -- cancellation would use (request_subscription_cancellation), so
    -- whichever path reaches this state FIRST (owner click or provider
    -- webhook) is the one that actually notifies; the other is a safe,
    -- silent no-op replay, never a duplicate.
    p_dedup_key            => 'cancellation_scheduled:' || v_id::text
  );

  return v_id;
end;
$$;

revoke all on function public.schedule_paystack_subscription_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.schedule_paystack_subscription_cancellation(uuid) to service_role;

-- ══════════════════════════════════════════════════════════════════════
-- CHECKOUT IDEMPOTENCY / DOUBLE-SUBMIT HARDENING (Codex-identified,
-- directly related to APP-1L-03's own "paid checkout enablement").
-- ══════════════════════════════════════════════════════════════════════
--
-- private.checkout_intents: a short-lived idempotency ledger — the
-- SERVER (never the browser) claims one row here immediately before
-- ever calling Paystack's own Initialize Transaction endpoint. The
-- structural guarantee is the partial unique index below: at most ONE
-- PENDING intent may exist per business at a time, so two rapid/
-- concurrent checkout submissions for the SAME business can never both
-- proceed to create a second payable Paystack session — the second one
-- fails this table's own constraint before any second provider call is
-- ever made. A stale (>15 minutes old) PENDING intent is reaped
-- automatically on the next attempt, so an abandoned checkout never
-- locks a business out of retrying indefinitely.
create table private.checkout_intents (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  price_id            uuid not null references public.subscription_plan_prices (id) on delete restrict,
  provider_reference  text not null,
  status              text not null default 'PENDING' check (status in ('PENDING', 'EXPIRED')),
  created_at          timestamptz not null default now(),

  unique (provider_reference)
);

create unique index checkout_intents_business_pending_unique_idx
  on private.checkout_intents (business_id)
  where status = 'PENDING';

alter table private.checkout_intents enable row level security;
alter table private.checkout_intents force row level security;
revoke all on private.checkout_intents from public, anon, authenticated, service_role;

grant select, insert, update on private.checkout_intents to private_billing_action_writer;

-- begin_paystack_checkout_intent: called by lib/billing/actions.ts's
-- initCheckoutAction, AFTER its own authentication/billing.manage/price-
-- validation checks, BEFORE the actual Paystack Initialize Transaction
-- HTTP call. p_provider_reference is the SAME server-generated reference
-- the caller is about to hand Paystack — the browser never supplies or
-- influences it (see initCheckoutAction's own comment on why).
create or replace function public.begin_paystack_checkout_intent(
  p_business_id        uuid,
  p_price_id           uuid,
  p_provider_reference text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_id  uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null or p_price_id is null or p_provider_reference is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'billing.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Reap abandoned attempts — never an indefinite lockout.
  update private.checkout_intents
  set status = 'EXPIRED'
  where business_id = p_business_id
    and status = 'PENDING'
    and created_at < now() - interval '15 minutes';

  begin
    insert into private.checkout_intents (business_id, price_id, provider_reference)
    values (p_business_id, p_price_id, p_provider_reference)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'CHECKOUT_ALREADY_IN_PROGRESS' using errcode = '23505';
  end;

  return v_id;
end;
$$;

-- fail_paystack_checkout_intent (CHK-1L-01): called by
-- lib/billing/actions.ts's initCheckoutAction IMMEDIATELY after Paystack's
-- own Initialize Transaction call throws — without this, a PENDING
-- intent from a genuinely failed/unreachable provider call would
-- otherwise survive, blocking any retry, until the 15-minute stale
-- reaper inside begin_paystack_checkout_intent next runs. Never an
-- arbitrary status setter: the transition target is hardcoded to
-- 'EXPIRED' (the same terminal status the stale-reaper already uses —
-- no new status value is introduced), and the WHERE clause is scoped to
-- the EXACT (business_id, provider_reference, status = 'PENDING') row —
-- never "every PENDING intent for this business" — so a second, NEWER
-- intent already claimed for a retry (a different reference) can never
-- be accidentally expired by a late-arriving failure callback for the
-- FIRST attempt. Idempotent: a repeated call for an already-EXPIRED (or
-- already-consumed/nonexistent) reference simply matches zero rows and
-- returns normally — never an error, never a second side effect.
create or replace function public.fail_paystack_checkout_intent(
  p_business_id        uuid,
  p_provider_reference text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null or p_provider_reference is null then
    raise exception 'required parameters missing' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'billing.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update private.checkout_intents
  set status = 'EXPIRED'
  where business_id = p_business_id
    and provider_reference = p_provider_reference
    and status = 'PENDING';
end;
$$;

grant create on schema public to private_billing_action_writer;
alter function public.begin_paystack_checkout_intent(uuid, uuid, text) owner to private_billing_action_writer;
alter function public.fail_paystack_checkout_intent(uuid, text) owner to private_billing_action_writer;
revoke create on schema public from private_billing_action_writer;

revoke all on function public.begin_paystack_checkout_intent(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.begin_paystack_checkout_intent(uuid, uuid, text) to authenticated;

revoke all on function public.fail_paystack_checkout_intent(uuid, text) from public, anon, service_role;
grant execute on function public.fail_paystack_checkout_intent(uuid, text) to authenticated;

-- Ownership transfer for the two SEC-DEFINER functions above that read/
-- write business_subscriptions directly (bind_paystack_subscription_identity,
-- schedule_paystack_subscription_cancellation, get_paystack_subscription_disable_context,
-- and the replaced find_paystack_business_by_customer_code) —
-- private_billing_provider_writer, matching every other webhook-facing
-- wrapper in this migration set.
grant create on schema public to private_billing_provider_writer;
alter function public.find_paystack_business_by_customer_code(text, text)
  owner to private_billing_provider_writer;
alter function public.bind_paystack_subscription_identity(uuid, text, text, text)
  owner to private_billing_provider_writer;
alter function public.get_paystack_subscription_disable_context(uuid)
  owner to private_billing_provider_writer;
alter function public.schedule_paystack_subscription_cancellation(uuid)
  owner to private_billing_provider_writer;
revoke create on schema public from private_billing_provider_writer;

grant create on schema private to private_billing_provider_writer;
alter function private.bind_paystack_subscription_identity(uuid, text, text, text)
  owner to private_billing_provider_writer;
revoke create on schema private from private_billing_provider_writer;
