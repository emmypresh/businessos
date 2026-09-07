-- Phase 1L — APPLICATION. Integrates automatic 14-day Growth trial
-- issuance into new-business onboarding.
--
-- This migration NEVER edits any frozen Phase 1A-1L migration file —
-- public.create_business is reproduced via CREATE OR REPLACE with its
-- EXACT existing signature (text, text) -> public.businesses, so
-- PostgREST's own resolution, every existing grant, and every existing
-- caller (lib/business/actions.ts's own createBusiness Server Action)
-- are all unaffected. Every line that is not new is a byte-for-byte
-- copy of the frozen version in
-- supabase/migrations/20260825205357_create_business_rpc.sql.
--
-- TRANSACTIONAL: private.create_initial_trial(v_business.id) is called
-- from INSIDE this same PL/pgSQL function body, after the business row
-- (and its AFTER INSERT owner-membership trigger) has already run but
-- BEFORE this function returns — a single Postgres function invocation
-- is always one transaction, so a business is never left without its
-- trial: if create_initial_trial ever raised (structurally unreachable
-- for a brand-new business — business_subscriptions.business_id's own
-- UNIQUE constraint cannot yet be violated for an id that did not exist
-- a moment ago), the entire business creation would roll back with it,
-- exactly matching this round's own "trial issuance must be
-- transactional where practical" instruction. No two-step client
-- sequence, no follow-up Server Action, no window where a business
-- exists with no subscription row at all.
--
-- AUDIT + NOTIFICATION: both fire in the SAME transaction, immediately
-- after the trial is created — a subscription.trial_started audit event
-- (private.record_audit_event, already the frozen Phase 1J writer) and a
-- single in-app notification to the business's own new OWNER (private.
-- create_notification, already the frozen Phase 1K writer). Neither
-- grant is widened beyond this ONE additional caller
-- (private_business_creator, create_business's own existing owner) —
-- see the narrow, function-by-function EXECUTE grants below.

-- Narrow, one-at-a-time EXECUTE grants — exactly what this phase's own
-- Phase 1L DB-foundation round anticipated ("A future Phase 1L
-- APPLICATION round grants EXECUTE to whichever specific, narrowly-
-- scoped server-side integration boundary actually needs each one, one
-- at a time"). private_business_creator already exists (frozen); this
-- migration only adds to its EXECUTE surface, never to its table grants.
grant execute on function private.create_initial_trial(uuid) to private_business_creator;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_business_creator;
grant execute on function private.current_verified_email() to private_business_creator;
grant execute on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) to private_business_creator;

create or replace function public.create_business(p_name text, p_slug text)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid          uuid;
  v_name         text;
  v_slug         text;
  v_business     public.businesses;
  v_constraint   text;
  v_trial_id     uuid;
  v_actor_email  text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000'; -- invalid_authorization_specification
  end if;

  -- Surrounding whitespace only, per businesses.name's own CHECK
  -- constraint (length(name) <= 150 and length(btrim(name)) >= 2) —
  -- normalizing here keeps the common case from ever reaching that
  -- constraint, but the constraint itself is the actual backstop, since
  -- it also covers writers that don't go through this RPC (e.g.
  -- service_role).
  v_name := btrim(p_name);
  if v_name is null or length(v_name) = 0 then
    raise exception 'business name is required'
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  if length(v_name) < 2 then
    raise exception 'business name is too short'
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  if length(v_name) > 150 then
    raise exception 'business name is too long'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  v_slug := private.normalize_slug(p_slug);
  if v_slug is null or length(v_slug) > 63 then
    raise exception 'business slug is invalid'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  -- No RETURNING here on purpose, though it's no longer an RLS-timing
  -- workaround now that this runs as private_business_creator
  -- (BYPASSRLS): it's kept because it makes the sequencing explicit and
  -- auditable — this INSERT fires the AFTER INSERT trigger
  -- (private.create_owner_membership) before control returns here, so by
  -- the time the SELECT below runs, the OWNER membership row already
  -- exists or the trigger has already raised and this whole function call
  -- (and the INSERT with it) has already been rolled back.
  --
  -- Slug collisions are caught explicitly and replaced with a generic,
  -- controlled error: the raw unique_violation carries a DETAIL naming
  -- the conflicting key/value, which would otherwise hand an unrelated
  -- caller confirmation that a specific slug (and therefore a specific
  -- tenant name) already exists elsewhere in the system. Scoped to
  -- businesses_slug_key specifically via GET STACKED DIAGNOSTICS, so an
  -- unrelated/unexpected unique_violation (should one ever exist) still
  -- surfaces normally instead of being masked.
  begin
    insert into public.businesses (name, slug, created_by)
    values (v_name, v_slug, v_uid);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'businesses_slug_key' then
        raise exception 'SLUG_UNAVAILABLE'
          using errcode = '23505'; -- unique_violation (keeps PostgREST's 409 mapping)
      end if;
      raise;
  end;

  -- slug is globally unique (businesses_slug_key), so this unambiguously
  -- identifies the row just inserted.
  select * into v_business
  from public.businesses
  where slug = v_slug;

  if v_business.id is null then
    raise exception 'business creation failed';
  end if;

  -- Phase 1L — automatic 14-day Growth trial. create_initial_trial is
  -- itself the ONLY way a business_subscriptions row is ever created; it
  -- derives trial_started_at/trial_ends_at from ITS OWN now() call (the
  -- database's own trusted clock) — no caller of any kind, including
  -- this one, can supply a backdated or extended trial window.
  v_trial_id := private.create_initial_trial(v_business.id);

  v_actor_email := private.current_verified_email();

  perform private.record_audit_event(
    p_business_id             => v_business.id,
    p_actor_type              => 'USER',
    p_actor_user_id           => v_uid,
    p_action                  => 'subscription.trial_started',
    p_category                => 'FINANCE',
    p_actor_email_snapshot    => v_actor_email,
    p_resource_type           => 'business_subscription',
    p_resource_id             => v_trial_id,
    p_metadata                => jsonb_build_object('plan_code', 'GROWTH', 'trial_days', 14)
  );

  -- The new business has exactly one member (the OWNER who just created
  -- it) at this point in the transaction — no billing.view-permission
  -- resolution is needed the way later lifecycle notifications require
  -- (see 20260905080200_billing_provider_writer.sql), so this notifies
  -- v_uid directly.
  perform private.create_notification(
    p_business_id        => v_business.id,
    p_category            => 'FINANCE',
    p_notification_type   => 'subscription.trial_started',
    p_title                => 'Your 14-day Growth trial has started',
    p_recipient_user_ids  => array[v_uid],
    p_body                 => 'Explore BusinessOS Growth features free for 14 days. No payment method required.',
    p_severity             => 'INFO',
    p_resource_type        => 'business_subscription',
    p_resource_id          => v_trial_id,
    p_dedup_key            => 'trial_started:' || v_business.id::text
  );

  return v_business;
end;
$$;

-- Ownership/ACL are UNCHANGED from the frozen migration — CREATE OR
-- REPLACE preserves the existing function's owner and grants; the
-- statements below are included only for explicitness and are no-ops if
-- nothing has drifted.
grant create on schema public to private_business_creator;
alter function public.create_business(text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

revoke all on function public.create_business(text, text) from public, anon;
grant execute on function public.create_business(text, text) to authenticated;
