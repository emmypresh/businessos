-- Phase 1Q-A part 3: layer category selection onto the create_business RPC
-- boundary, and add a dedicated update_business_category RPC for
-- post-creation changes.
--
-- CREATE_BUSINESS: p_category_code is REQUIRED and non-empty at the RPC
-- boundary (Phase 1Q-A pre-Codex completion pass). This supersedes this
-- migration's earlier "optional at the RPC, enforced only at the
-- onboarding form" design: the canonical create_business RPC is the sole
-- entry point for new-business writes (private_business_creator holds the
-- only insert grant on public.businesses — see
-- 20260825205357_create_business_rpc.sql), so a validation rule that lives
-- only in the UI/Zod layer is trivially bypassed by any direct RPC caller
-- and is not a real enforcement boundary. Every call to create_business
-- must now resolve p_category_code against the live, active
-- business_categories registry, exactly like country/currency. This does
-- NOT touch existing rows: legacy businesses created before this
-- migration keep primary_category_id = NULL and remain fully readable and
-- usable (no backfill, no NOT NULL constraint on the column — see this
-- phase's own §1/§4 prohibition on both). Only NEW create_business calls
-- are affected. Every one of the ~30 existing direct-RPC test/fixture call
-- sites across this repo was updated in the same pass to pass a stable
-- seeded category code (GENERAL_TRADING where the category itself is
-- irrelevant to what the test covers). Every other existing side effect
-- (uid derivation, name/slug validation, slug collision handling,
-- country/currency/timezone validation, the operational-country gate,
-- trial issuance, audit event, notification, rollback-on-exception,
-- return type, SECURITY DEFINER, empty search_path, ownership, narrow
-- execute grants) is carried forward verbatim from
-- 20260923090200_create_business_rpc_boundary_hardening.sql — only
-- category validation changed.
--
-- UPDATE_BUSINESS_CATEGORY: a direct client `.update()` (the
-- updateBusinessTimezone precedent) is NOT used here, because category
-- validity depends on a join against business_categories.is_active — not
-- a pure per-row predicate a table CHECK constraint can express (unlike
-- businesses_timezone_country_check, which only ever reads the row's own
-- two columns). This repo's own established convention
-- (private.record_audit_event's header comment,
-- 20260902090100_audit_permissions_and_writer.sql) is that audit events
-- are written by the trusted mutation RPC's own function body, in the
-- same transaction as the mutation — never by a generic trigger layered
-- on a plain client update. So this is a small new SECURITY DEFINER RPC,
-- following create_business's own established shape exactly: its own
-- narrowly-scoped BYPASSRLS role, its own re-derivation of the caller via
-- private.current_uid(), and its own has_permission(business.manage)
-- check (which, because this role bypasses RLS, IS the enforcement
-- boundary for this RPC — not defense-in-depth on top of a policy the way
-- application-layer checks are for direct-table-update paths elsewhere).

-- ---------------------------------------------------------------------
-- 1. create_business — DROP + CREATE (signature change: 5 args -> 7).
-- ---------------------------------------------------------------------
drop function if exists public.create_business(text, text, text, text, text);

create or replace function public.create_business(
  p_name                   text,
  p_slug                   text,
  p_country_code           text default 'NG',
  p_currency_code          text default null,
  p_timezone               text default null,
  p_category_code          text default null,
  p_custom_category_label  text default null
)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                 uuid;
  v_name                text;
  v_slug                text;
  v_country_code        text;
  v_currency_code       text;
  v_timezone            text;
  v_expected_currency   text;
  v_category_id         uuid;
  v_category_code       text;
  v_custom_label        text;
  v_business            public.businesses;
  v_constraint          text;
  v_trial_id            uuid;
  v_actor_email         text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000'; -- invalid_authorization_specification
  end if;

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

  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BUSINESS_COUNTRY_CODE' using errcode = '22023';
  end if;

  if not private.is_supported_country(v_country_code) then
    raise exception 'UNSUPPORTED_BUSINESS_COUNTRY' using errcode = '22023';
  end if;

  v_expected_currency := private.default_currency_for_country(v_country_code);

  if p_currency_code is null or length(btrim(p_currency_code)) = 0 then
    v_currency_code := v_expected_currency;
  else
    v_currency_code := upper(btrim(p_currency_code));
  end if;

  if v_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'INVALID_BUSINESS_CURRENCY_CODE' using errcode = '22023';
  end if;

  if v_currency_code <> v_expected_currency then
    raise exception 'CURRENCY_COUNTRY_MISMATCH' using errcode = '22023';
  end if;

  if p_timezone is null or length(btrim(p_timezone)) = 0 then
    v_timezone := private.default_timezone_for_country(v_country_code);
    if v_timezone is null then
      raise exception 'TIMEZONE_REQUIRED_FOR_COUNTRY' using errcode = '22023';
    end if;
  else
    v_timezone := btrim(p_timezone);
  end if;

  if not private.is_supported_timezone(v_timezone) then
    raise exception 'INVALID_BUSINESS_TIMEZONE' using errcode = '22023';
  end if;

  if not private.is_timezone_valid_for_country(v_country_code, v_timezone) then
    raise exception 'TIMEZONE_COUNTRY_MISMATCH' using errcode = '22023';
  end if;

  if not private.is_fully_operational_country(v_country_code) then
    raise exception 'COUNTRY_NOT_YET_OPERATIONAL' using errcode = '22023';
  end if;

  -- Category is REQUIRED at this RPC boundary: every NEW business must
  -- resolve p_category_code against an ACTIVE registry row (never trusted
  -- by code/label alone — resolved to an id via a server-side lookup, so a
  -- client cannot reference an inactive or nonexistent category id/code by
  -- guessing). Uppercased/trimmed the same way country/currency codes are,
  -- since business_categories.code is stored uppercase. Legacy businesses
  -- created before this migration are unaffected — this check only runs
  -- on new create_business calls, never retroactively.
  v_category_code := upper(btrim(coalesce(p_category_code, '')));
  if v_category_code = '' then
    raise exception 'BUSINESS_CATEGORY_REQUIRED' using errcode = '22023';
  end if;

  select id into v_category_id
  from public.business_categories
  where code = v_category_code and is_active = true;

  if v_category_id is null then
    raise exception 'INVALID_BUSINESS_CATEGORY' using errcode = '22023';
  end if;

  -- OTHER requires a bounded custom label; every other category ignores
  -- (never stores) one, even if a caller supplied it — the chosen
  -- contract per phase instruction §26/§49 ("non-OTHER ignores ...
  -- inappropriate custom label"), so a client cannot smuggle free-form
  -- text onto a category where the product only ever shows the catalog
  -- label.
  if v_category_code = 'OTHER' then
    v_custom_label := nullif(btrim(p_custom_category_label), '');
    if v_custom_label is null or length(v_custom_label) < 2 then
      raise exception 'CUSTOM_CATEGORY_LABEL_REQUIRED' using errcode = '22023';
    end if;
    if length(v_custom_label) > 100 then
      raise exception 'CUSTOM_CATEGORY_LABEL_TOO_LONG' using errcode = '22023';
    end if;
  else
    v_custom_label := null;
  end if;

  begin
    insert into public.businesses (
      name, slug, created_by, country_code, currency_code, timezone,
      primary_category_id, custom_category_label
    )
    values (
      v_name, v_slug, v_uid, v_country_code, v_currency_code, v_timezone,
      v_category_id, v_custom_label
    );
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'businesses_slug_key' then
        raise exception 'SLUG_UNAVAILABLE'
          using errcode = '23505'; -- unique_violation (keeps PostgREST's 409 mapping)
      end if;
      raise;
  end;

  select * into v_business
  from public.businesses
  where slug = v_slug;

  if v_business.id is null then
    raise exception 'business creation failed';
  end if;

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

-- private_business_creator already holds select, insert on public.businesses
-- (whole-table, not column-restricted — 20260825205357_create_business_rpc.sql)
-- so the two new columns need no additional grant for this role. It DOES
-- need read access to the category registry, which it did not need
-- before.
grant select (id, code, is_active) on public.business_categories to private_business_creator;

grant create on schema public to private_business_creator;
alter function public.create_business(text, text, text, text, text, text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

revoke all on function public.create_business(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. update_business_category — new RPC + its own narrowly-scoped role,
--    mirroring private_business_creator's own shape exactly.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_business_category_writer') then
    create role private_business_category_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_business_category_writer to postgres;

grant usage on schema public to private_business_category_writer;
grant usage on schema private to private_business_category_writer;
-- Whole-table SELECT (not column-restricted): `returning *` in the
-- function body below returns every column of the updated row, and
-- Postgres requires SELECT privilege on every column a RETURNING clause
-- returns, not merely the ones actually written — matching
-- private_business_creator's own equally broad `select, insert on
-- businesses` grant (20260825205357_create_business_rpc.sql) for the same
-- reason.
grant select on public.businesses to private_business_category_writer;
grant update (primary_category_id, custom_category_label) on public.businesses to private_business_category_writer;
grant select (id, code, is_active) on public.business_categories to private_business_category_writer;
grant execute on function private.current_uid() to private_business_category_writer;
grant execute on function private.has_permission(uuid, text) to private_business_category_writer;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_business_category_writer;

-- Updates a business's own category. Re-derives the caller's identity and
-- re-checks business.manage itself (this role BYPASSes RLS, so this
-- check — not businesses_update — is the actual enforcement boundary for
-- this RPC), resolves the category by CODE (never trusts a caller-
-- supplied id directly against an is_active check bypass), enforces the
-- same OTHER/custom-label contract as create_business, records
-- business.category_updated atomically in the same transaction, and
-- returns the updated row.
create or replace function public.update_business_category(
  p_business_id            uuid,
  p_category_code          text,
  p_custom_category_label  text default null
)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;
  v_category_code  text;
  v_category_id    uuid;
  v_custom_label   text;
  v_business       public.businesses;
  v_actor_email    text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if p_business_id is null then
    raise exception 'business id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'business.manage') then
    raise exception 'insufficient permission' using errcode = '42501'; -- insufficient_privilege
  end if;

  v_category_code := upper(btrim(coalesce(p_category_code, '')));
  if v_category_code = '' then
    raise exception 'BUSINESS_CATEGORY_REQUIRED' using errcode = '22023';
  end if;

  select id into v_category_id
  from public.business_categories
  where code = v_category_code and is_active = true;

  if v_category_id is null then
    raise exception 'INVALID_BUSINESS_CATEGORY' using errcode = '22023';
  end if;

  if v_category_code = 'OTHER' then
    v_custom_label := nullif(btrim(p_custom_category_label), '');
    if v_custom_label is null or length(v_custom_label) < 2 then
      raise exception 'CUSTOM_CATEGORY_LABEL_REQUIRED' using errcode = '22023';
    end if;
    if length(v_custom_label) > 100 then
      raise exception 'CUSTOM_CATEGORY_LABEL_TOO_LONG' using errcode = '22023';
    end if;
  else
    v_custom_label := null;
  end if;

  update public.businesses
  set primary_category_id = v_category_id,
      custom_category_label = v_custom_label
  where id = p_business_id
  returning * into v_business;

  if v_business.id is null then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = '22023';
  end if;

  v_actor_email := private.current_verified_email();

  perform private.record_audit_event(
    p_business_id             => v_business.id,
    p_actor_type              => 'USER',
    p_actor_user_id           => v_uid,
    p_action                  => 'business.category_updated',
    p_category                => 'ORGANIZATION',
    p_actor_email_snapshot    => v_actor_email,
    p_resource_type           => 'business',
    p_resource_id             => v_business.id,
    p_metadata                => jsonb_build_object('category_code', v_category_code)
  );

  return v_business;
end;
$$;

grant execute on function private.current_verified_email() to private_business_category_writer;

grant create on schema public to private_business_category_writer;
alter function public.update_business_category(uuid, text, text) owner to private_business_category_writer;
revoke create on schema public from private_business_category_writer;

-- Only `authenticated` may call it, matching create_business's own
-- surface (no service_role grant needed — trusted server-side code can
-- already write to businesses directly).
revoke all on function public.update_business_category(uuid, text, text) from public, anon;
grant execute on function public.update_business_category(uuid, text, text) to authenticated;
