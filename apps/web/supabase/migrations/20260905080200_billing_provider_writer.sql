-- Phase 1L — APPLICATION. Backend-only (service_role) provider-event
-- processing surface: the webhook route (app/api/webhooks/paystack/
-- route.ts) is the ONLY caller, and it never has an authenticated user
-- session (a Paystack webhook carries no BusinessOS session at all) — so
-- every function below is a narrow, single-purpose SECURITY DEFINER
-- wrapper around one frozen private_billing_writer-owned trusted
-- transition function, with EXECUTE granted ONLY to `service_role`,
-- never to `authenticated`/`anon`/PUBLIC. This is the identical
-- "narrowly-scoped server-side integration boundary" the frozen Phase 1L
-- DB-foundation round's own header comment anticipated
-- (20260904080300_billing_permissions_and_private_writer.sql: "A future
-- Phase 1L APPLICATION round grants EXECUTE to whichever specific,
-- narrowly-scoped server-side integration boundary actually needs each
-- one, one at a time").
--
-- WHY service_role AND NOT A NEW LOGIN ROLE: PostgREST/supabase-js's
-- .rpc() can only ever reach the `public` schema, never `private`
-- directly (config.toml's own api.exposed_schemas — the same structural
-- guarantee private.billing_provider_events itself already relies on).
-- service_role is this codebase's own established "trusted backend,
-- no user session" identity (see lib/auth/recovery-grant-admin-client.ts's
-- own identical precedent) — the webhook route authenticates itself to
-- Postgres AS service_role using SUPABASE_SECRET_KEY (server-only,
-- verified never to reach client code — see lib/billing/admin-client.ts),
-- and each function below does no privileged work beyond forwarding to
-- its one already-narrow, already-tested frozen private function, plus a
-- FINANCE audit event and (where a state actually changed) a
-- billing.view notification.
--
-- NO GENERIC "APPLY ARBITRARY WEBHOOK STATE" FUNCTION: exactly like the
-- frozen private layer's own eight functions, there are exactly SIX
-- narrow wrappers below, one per real provider-driven event, each with
-- its own fixed parameter set — never a single function accepting an
-- arbitrary target status.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_billing_provider_writer') then
    create role private_billing_provider_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_billing_provider_writer to postgres;

grant usage on schema public to private_billing_provider_writer;
grant usage on schema private to private_billing_provider_writer;

grant execute on function private.record_provider_event(text, text, text, text, uuid, uuid)
  to private_billing_provider_writer;
grant execute on function private.activate_subscription_from_verified_payment(
  uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text
) to private_billing_provider_writer;
grant execute on function private.record_subscription_renewal(uuid, timestamptz, timestamptz)
  to private_billing_provider_writer;
grant execute on function private.record_subscription_payment_failed(uuid)
  to private_billing_provider_writer;
grant execute on function private.record_billing_transaction(
  uuid, uuid, text, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) to private_billing_provider_writer;
grant execute on function private.mark_subscription_expired(uuid) to private_billing_provider_writer;
grant execute on function private.resolve_active_members_with_permission(uuid, text)
  to private_billing_provider_writer;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_billing_provider_writer;
grant execute on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) to private_billing_provider_writer;

-- Only ever read to decide an audit action LABEL after a state change
-- this same transaction already performed via mark_subscription_expired
-- — never used to branch authorization logic. current_period_started_at
-- additionally backs the webhook route's own stale-invoice.payment_failed
-- guard (lib/billing/webhook-handlers.ts) — comparing a LATE failure
-- notification's own timestamp against the CURRENT period's start, never
-- branching authorization.
grant select (business_id, provider, provider_customer_code, status, current_period_started_at)
  on public.business_subscriptions to private_billing_provider_writer;

-- find_paystack_business_by_customer_code: resolves which business a
-- RECURRING provider event (invoice.payment_failed, subscription.create,
-- subscription.disable — none of which carry this application's own
-- checkout-time metadata, unlike the FIRST charge.success) belongs to.
-- provider_customer_code is unique per (provider, provider_environment)
-- — SEC-1L-03's own NULLS NOT DISTINCT partial unique index
-- (business_subscriptions_provider_customer_code_unique_idx) — so this
-- can never resolve to more than one business. Returns null (never
-- raises) for an unrecognized code — the webhook route treats that as
-- "cannot safely act on this event yet" and ingests it without mutating
-- any subscription state, exactly like an unrecognized event.
create or replace function public.find_paystack_business_by_customer_code(p_provider_customer_code text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select business_id
  from public.business_subscriptions
  where provider = 'PAYSTACK' and provider_customer_code = p_provider_customer_code
  limit 1;
$$;

-- ingest_paystack_provider_event: the FIRST thing the webhook route calls
-- after signature verification succeeds — see
-- app/api/webhooks/paystack/route.ts. Provider is hardcoded 'PAYSTACK'
-- (this application's only configured provider; the frozen catalog CHECK
-- constraints already close off any other value at the table level).
create or replace function public.ingest_paystack_provider_event(
  p_provider_event_key  text,
  p_event_type          text,
  p_payload_hash        text,
  p_business_id         uuid default null,
  p_subscription_id     uuid default null
)
returns table (id uuid, is_new boolean)
language sql
security definer
set search_path = ''
as $$
  select * from private.record_provider_event(
    'PAYSTACK', p_provider_event_key, p_event_type, p_payload_hash, p_business_id, p_subscription_id
  );
$$;

-- activate_paystack_subscription: TRIALING/PAST_DUE/INCOMPLETE -> ACTIVE,
-- from a webhook-verified charge/subscription event only — see
-- lib/billing/webhook-handlers.ts. Forwards straight to the frozen
-- trusted transition function (which itself validates price/plan/
-- provider/environment consistency — SEC-1L-03) and, only once that
-- succeeds, records one FINANCE audit event and one billing.view
-- notification.
create or replace function public.activate_paystack_subscription(
  p_business_id                 uuid,
  p_plan_id                     uuid,
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
  v_id uuid;
begin
  v_id := private.activate_subscription_from_verified_payment(
    p_business_id, p_plan_id, 'PAYSTACK', p_period_start, p_period_end,
    p_price_id, p_provider_environment, p_provider_customer_code, p_provider_subscription_code
  );

  perform private.record_audit_event(
    p_business_id   => p_business_id,
    p_actor_type    => 'SYSTEM',
    p_actor_user_id => null,
    p_action        => 'subscription.activated',
    p_category      => 'FINANCE',
    p_resource_type => 'business_subscription',
    p_resource_id   => v_id,
    p_metadata      => jsonb_build_object('provider', 'PAYSTACK')
  );

  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.activated',
    p_title                => 'Subscription activated',
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'Your subscription is now active.',
    p_severity             => 'SUCCESS',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    -- Distinct per resulting paid-through date: a genuinely new
    -- activation/renewal-via-activation notifies once; an exact-replay
    -- webhook redelivery (same period end) does not renotify. Provider
    -- event idempotency (ingest_paystack_provider_event, called BEFORE
    -- this function in every real call site) already prevents this
    -- function from even being reached twice for the identical event, so
    -- this dedup_key is defense in depth, not the primary guarantee.
    p_dedup_key            => 'activated:' || v_id::text || ':' || p_period_end::text
  );

  return v_id;
end;
$$;

-- renew_paystack_subscription: ACTIVE/PAST_DUE -> ACTIVE with an
-- extended (never shortened — SEC-1L-02(A), enforced inside the frozen
-- function itself) paid-through period.
create or replace function public.renew_paystack_subscription(
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
  v_id uuid;
begin
  v_id := private.record_subscription_renewal(p_business_id, p_period_start, p_period_end);

  perform private.record_audit_event(
    p_business_id   => p_business_id,
    p_actor_type    => 'SYSTEM',
    p_actor_user_id => null,
    p_action        => 'subscription.renewed',
    p_category      => 'FINANCE',
    p_resource_type => 'business_subscription',
    p_resource_id   => v_id,
    p_metadata      => jsonb_build_object('provider', 'PAYSTACK')
  );

  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.renewed',
    p_title                => 'Subscription renewed',
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'Your subscription has been renewed.',
    p_severity             => 'SUCCESS',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    p_dedup_key            => 'renewed:' || v_id::text || ':' || p_period_end::text
  );

  return v_id;
end;
$$;

-- mark_paystack_subscription_payment_failed: ACTIVE -> PAST_DUE, grace
-- ALWAYS NULL (SEC-1L-02(B) — this application layer never invents a
-- grace duration either; it inherits the frozen function's own contract
-- unchanged).
create or replace function public.mark_paystack_subscription_payment_failed(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := private.record_subscription_payment_failed(p_business_id);

  perform private.record_audit_event(
    p_business_id   => p_business_id,
    p_actor_type    => 'SYSTEM',
    p_actor_user_id => null,
    p_action        => 'subscription.payment_failed',
    p_category      => 'FINANCE',
    p_resource_type => 'business_subscription',
    p_resource_id   => v_id,
    p_metadata      => jsonb_build_object('provider', 'PAYSTACK')
  );

  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.payment_failed',
    p_title                => 'Payment failed — action required',
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'A subscription payment failed. Update your billing details to restore access.',
    p_severity             => 'CRITICAL',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    p_dedup_key            => 'payment_failed:' || v_id::text
  );

  return v_id;
end;
$$;

-- expire_paystack_subscription: the natural-end-of-period / provider-
-- confirmed-disable path -> EXPIRED or CANCELED (the frozen function's
-- own choice — see its header comment). SEC-1L-01's own boundary check
-- lives entirely inside private.mark_subscription_expired: if the
-- authoritative window has not actually elapsed yet, THIS call raises
-- SUBSCRIPTION_NOT_YET_EXPIRABLE exactly like any other caller would —
-- the webhook route treats that specific, expected rejection as a safe
-- no-op (see lib/billing/webhook-handlers.ts), never as a processing
-- failure.
create or replace function public.expire_paystack_subscription(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_status text;
begin
  v_id := private.mark_subscription_expired(p_business_id);

  select status into v_status from public.business_subscriptions where id = v_id;

  perform private.record_audit_event(
    p_business_id   => p_business_id,
    p_actor_type    => 'SYSTEM',
    p_actor_user_id => null,
    p_action        => case when v_status = 'CANCELED' then 'subscription.canceled' else 'subscription.expired' end,
    p_category      => 'FINANCE',
    p_resource_type => 'business_subscription',
    p_resource_id   => v_id
  );

  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => case when v_status = 'CANCELED' then 'subscription.canceled' else 'subscription.expired' end,
    p_title                => case when v_status = 'CANCELED' then 'Subscription canceled' else 'Subscription expired' end,
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'Your business no longer has an active subscription. Data is preserved — visit billing to resubscribe.',
    p_severity             => 'WARNING',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    p_dedup_key            => 'ended:' || v_id::text
  );

  return v_id;
end;
$$;

-- record_paystack_billing_transaction: append-only payment-history
-- evidence — no audit/notification of its own; activation/renewal (the
-- functions above, always called alongside it for a successful charge)
-- already notify on the resulting entitlement change. Provider is
-- hardcoded 'PAYSTACK', matching every other wrapper in this migration.
create or replace function public.record_paystack_billing_transaction(
  p_business_id                uuid,
  p_subscription_id            uuid,
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
language sql
security definer
set search_path = ''
as $$
  select private.record_billing_transaction(
    p_business_id, p_subscription_id, 'PAYSTACK', p_provider_reference, p_amount_minor, p_currency, p_status,
    p_provider_transaction_code, p_paid_at, p_failed_at, p_failure_code, p_failure_message, p_provider_channel
  );
$$;

grant create on schema public to private_billing_provider_writer;
alter function public.find_paystack_business_by_customer_code(text)
  owner to private_billing_provider_writer;
alter function public.ingest_paystack_provider_event(text, text, text, uuid, uuid)
  owner to private_billing_provider_writer;
alter function public.activate_paystack_subscription(
  uuid, uuid, timestamptz, timestamptz, uuid, text, text, text
) owner to private_billing_provider_writer;
alter function public.renew_paystack_subscription(uuid, timestamptz, timestamptz)
  owner to private_billing_provider_writer;
alter function public.mark_paystack_subscription_payment_failed(uuid)
  owner to private_billing_provider_writer;
alter function public.expire_paystack_subscription(uuid) owner to private_billing_provider_writer;
alter function public.record_paystack_billing_transaction(
  uuid, uuid, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) owner to private_billing_provider_writer;
revoke create on schema public from private_billing_provider_writer;

-- EXECUTE granted ONLY to service_role — never authenticated/anon/PUBLIC.
-- No ordinary user session (reachable only via the anon/publishable key
-- and a user's own JWT) can ever call any of these; only server-side
-- code holding SUPABASE_SECRET_KEY (the webhook route, exclusively) can.
revoke all on function public.find_paystack_business_by_customer_code(text) from public, anon, authenticated;
grant execute on function public.find_paystack_business_by_customer_code(text) to service_role;

revoke all on function public.ingest_paystack_provider_event(text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ingest_paystack_provider_event(text, text, text, uuid, uuid) to service_role;

revoke all on function public.activate_paystack_subscription(
  uuid, uuid, timestamptz, timestamptz, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.activate_paystack_subscription(
  uuid, uuid, timestamptz, timestamptz, uuid, text, text, text
) to service_role;

revoke all on function public.renew_paystack_subscription(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.renew_paystack_subscription(uuid, timestamptz, timestamptz) to service_role;

revoke all on function public.mark_paystack_subscription_payment_failed(uuid) from public, anon, authenticated;
grant execute on function public.mark_paystack_subscription_payment_failed(uuid) to service_role;

revoke all on function public.expire_paystack_subscription(uuid) from public, anon, authenticated;
grant execute on function public.expire_paystack_subscription(uuid) to service_role;

revoke all on function public.record_paystack_billing_transaction(
  uuid, uuid, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_paystack_billing_transaction(
  uuid, uuid, text, bigint, text, text, text, timestamptz, timestamptz, text, text, text
) to service_role;
