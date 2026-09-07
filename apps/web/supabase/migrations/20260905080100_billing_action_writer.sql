-- Phase 1L — APPLICATION. Owner-facing billing action surface: the ONE
-- way an authenticated client can ever request a subscription
-- cancellation. No other public RPC in this migration set ever calls
-- private.schedule_subscription_cancel — that frozen trusted transition
-- function (20260904080300_billing_permissions_and_private_writer.sql)
-- still has ZERO EXECUTE grants of its own; this migration adds exactly
-- one narrowly-scoped caller of it, never widens its own grant.
--
-- WHY A NEW ROLE, NOT private_billing_writer ITSELF: private_billing_writer
-- is the frozen DB-foundation's own dedicated writer for the eight
-- trusted transition functions — this migration deliberately does not
-- touch its grants or add a ninth function to its ownership. A NEW,
-- separate BYPASSRLS role owns this application-layer wrapper instead,
-- holding EXECUTE only on the specific frozen functions it needs to call
-- (schedule_subscription_cancel, has_permission, current_uid,
-- record_audit_event, create_notification,
-- resolve_active_members_with_permission) — mirrors this codebase's own
-- established "give a new function its own dedicated minimal role
-- instead of widening an existing one" convention (see
-- 20260831080400_record_invoice_payment_rpc.sql's own header comment).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_billing_action_writer') then
    create role private_billing_action_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_billing_action_writer to postgres;

grant usage on schema public to private_billing_action_writer;
grant usage on schema private to private_billing_action_writer;

grant execute on function private.current_uid() to private_billing_action_writer;
grant execute on function private.current_verified_email() to private_billing_action_writer;
grant execute on function private.has_permission(uuid, text) to private_billing_action_writer;
grant execute on function private.schedule_subscription_cancel(uuid) to private_billing_action_writer;
grant execute on function private.resolve_active_members_with_permission(uuid, text) to private_billing_action_writer;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_billing_action_writer;
grant execute on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) to private_billing_action_writer;

-- request_subscription_cancellation: authenticates, then requires
-- billing.manage (OWNER only, per the frozen billing.manage matrix
-- seeded in 20260904080300_billing_permissions_and_private_writer.sql) —
-- an ADMIN/ACCOUNTANT holding billing.view alone can see this page but
-- can never reach this far. Schedules ONLY (never ends a valid paid
-- period early — see business_subscriptions' own "CRITICAL DISTINCTION"
-- header comment): current access continues exactly through whatever
-- trial_ends_at/current_period_ends_at already says, unaffected. Any
-- provider-side (Paystack) cancellation attempt happens in the
-- application layer BEFORE this is called (see lib/billing/actions.ts) —
-- this function only ever records the LOCAL, authoritative intent.
create or replace function public.request_subscription_cancellation(p_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid;
  v_id    uuid;
  v_email text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'billing.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_id := private.schedule_subscription_cancel(p_business_id);

  v_email := private.current_verified_email();

  perform private.record_audit_event(
    p_business_id          => p_business_id,
    p_actor_type           => 'USER',
    p_actor_user_id        => v_uid,
    p_action               => 'subscription.cancellation_scheduled',
    p_category             => 'FINANCE',
    p_actor_email_snapshot => v_email,
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id
  );

  -- Every billing.view holder (OWNER/ADMIN/ACCOUNTANT — the frozen
  -- matrix), never merely the requesting OWNER — a scheduled
  -- cancellation is business-wide financial-oversight information, same
  -- posture as business_subscriptions' own SELECT policy. A fixed,
  -- per-subscription dedup_key (never time-based) means a repeated
  -- cancellation request against the SAME still-schedulable subscription
  -- generation notifies once, not on every click.
  perform private.create_notification(
    p_business_id        => p_business_id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.cancellation_scheduled',
    p_title                => 'Subscription cancellation scheduled',
    p_recipient_user_ids  => private.resolve_active_members_with_permission(p_business_id, 'billing.view'),
    p_body                 => 'Access continues until the end of the current billing/trial period.',
    p_severity             => 'INFO',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_id,
    p_dedup_key            => 'cancellation_scheduled:' || v_id::text
  );

  return v_id;
end;
$$;

-- record_subscription_checkout_started: audit-only (no notification —
-- an owner starting checkout is not, by itself, business-wide-relevant
-- information the way an actual state change is). Requires
-- billing.manage — the identical authority checkout-init itself
-- requires (lib/billing/actions.ts) — so this can never be used to probe
-- whether a business exists/has billing.manage-eligible staff from an
-- unauthorized caller.
create or replace function public.record_subscription_checkout_started(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid;
  v_email text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'billing.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_email := private.current_verified_email();

  perform private.record_audit_event(
    p_business_id          => p_business_id,
    p_actor_type           => 'USER',
    p_actor_user_id        => v_uid,
    p_action               => 'subscription.checkout_started',
    p_category             => 'FINANCE',
    p_actor_email_snapshot => v_email
  );
end;
$$;

grant create on schema public to private_billing_action_writer;
alter function public.request_subscription_cancellation(uuid) owner to private_billing_action_writer;
alter function public.record_subscription_checkout_started(uuid) owner to private_billing_action_writer;
revoke create on schema public from private_billing_action_writer;

revoke all on function public.request_subscription_cancellation(uuid) from public, anon, service_role;
grant execute on function public.request_subscription_cancellation(uuid) to authenticated;

revoke all on function public.record_subscription_checkout_started(uuid) from public, anon, service_role;
grant execute on function public.record_subscription_checkout_started(uuid) to authenticated;
