-- Phase 1Q-0B: extend create_business to accept an optional timezone for
-- the business it creates, atomically alongside country/currency. See
-- docs/phase-1q-0b-country-currency-timezone-onboarding-build-brief.md
-- (if present) and this migration's own comments for the design rationale.
--
-- TRANSITIONAL DEFAULT — READ BEFORE REMOVING: p_timezone defaults to
-- null, and when omitted is derived from p_country_code via
-- private.default_timezone_for_country. This mirrors
-- 20260909080100_create_business_country_currency.sql's own
-- p_currency_code transitional-default pattern exactly, for the same
-- reason: it keeps every existing 2-, 3-, and 4-argument caller
-- (rpc("create_business", { p_name, p_slug, ... })) resolving to this
-- same function without change.

-- Mirrors private.default_currency_for_country
-- (20260909080100_create_business_country_currency.sql) exactly — pure
-- logic, no table access, SECURITY INVOKER (the default). Unknown/
-- unsupported country codes return null; the caller (create_business)
-- decides how to handle that. US intentionally returns America/New_York
-- as an onboarding-UX default only — the phase brief is explicit that
-- this is not "the" correct US timezone, only a starting selection the
-- application layer's onboarding UI must let the user override before
-- submission (see lib/business/timezone-catalog.ts).
create or replace function private.default_timezone_for_country(p_country_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_country_code
    when 'NG' then 'Africa/Lagos'
    when 'GH' then 'Africa/Accra'
    when 'KE' then 'Africa/Nairobi'
    when 'ZA' then 'Africa/Johannesburg'
    when 'GB' then 'Europe/London'
    when 'US' then 'America/New_York'
    else null
  end;
$$;

revoke all on function private.default_timezone_for_country(text) from public, anon, authenticated;
grant execute on function private.default_timezone_for_country(text) to private_business_creator;

-- Fixed allow-list, kept in lockstep with businesses_timezone_check
-- (20260923090000_business_timezone.sql) and the TypeScript catalog in
-- lib/business/timezone-catalog.ts. Not a per-country lookup (unlike
-- default_timezone_for_country) because a supported timezone need not be
-- the DEFAULT for the business's own country — e.g. a US business
-- explicitly choosing America/Chicago.
create or replace function private.is_supported_timezone(p_timezone text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_timezone in (
    'Africa/Lagos',
    'Africa/Accra',
    'Africa/Nairobi',
    'Africa/Johannesburg',
    'Europe/London',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles'
  );
$$;

revoke all on function private.is_supported_timezone(text) from public, anon, authenticated;
grant execute on function private.is_supported_timezone(text) to private_business_creator;

-- Dropped and recreated (not CREATE OR REPLACE), same reasoning as
-- 20260909080100_create_business_country_currency.sql's own identical
-- drop: a bare CREATE OR REPLACE with a different parameter list creates
-- a second, separately-privileged overload rather than replacing the
-- first. The trailing new parameter is optional, so every existing
-- 2-, 3-, and 4-argument call keeps resolving to this same function with
-- the transitional default applied.
--
-- IMPORTANT — carried forward unchanged from the 4-argument version
-- (itself carrying forward trial_issuance.sql's additions): trial
-- issuance, audit event, notification, and country/currency validation
-- are copied verbatim below, with ONLY the timezone parameter and its
-- own validation/insert layered on top. See
-- 20260909080100_create_business_country_currency.sql's own "IMPORTANT"
-- header comment for why a bare "reproduce the body" rewrite is
-- dangerous — the same care applies here.
drop function if exists public.create_business(text, text, text, text);

create or replace function public.create_business(
  p_name          text,
  p_slug          text,
  p_country_code  text default 'NG',
  p_currency_code text default null,
  p_timezone      text default null
)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;
  v_name           text;
  v_slug           text;
  v_country_code   text;
  v_currency_code  text;
  v_timezone       text;
  v_business       public.businesses;
  v_constraint     text;
  v_trial_id       uuid;
  v_actor_email    text;
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

  -- Reject lowercase, symbols ("₦"), and free-form names ("Nigeria") at
  -- the RPC boundary, not just via the table's shape-only CHECK — the
  -- CHECK constraint is the backstop for every writer (including
  -- service_role); this is the friendlier, more specific error for the
  -- one path `authenticated` actually uses. Same upper+regex pattern as
  -- business_branches' p_country_code validation
  -- (20260828080300_business_branch_rpcs.sql). Lowercase input (e.g.
  -- "gh") IS accepted and normalized to uppercase here — it is not
  -- rejected — only genuinely malformed input (wrong length, non-letters,
  -- free-form names) is. Application-layer browser forms submit the
  -- canonical uppercase form regardless (lib/validation/business.ts);
  -- this normalization exists for any other authenticated caller.
  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BUSINESS_COUNTRY_CODE' using errcode = '22023';
  end if;

  if p_currency_code is null or length(btrim(p_currency_code)) = 0 then
    v_currency_code := private.default_currency_for_country(v_country_code);
    if v_currency_code is null then
      -- No catalog default for this country (not one of the six launch
      -- countries) and the caller didn't supply one explicitly — fail
      -- closed rather than silently persist a currency the country wasn't
      -- asked for.
      raise exception 'CURRENCY_CODE_REQUIRED_FOR_COUNTRY' using errcode = '22023';
    end if;
  else
    v_currency_code := upper(btrim(p_currency_code));
  end if;

  if v_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'INVALID_BUSINESS_CURRENCY_CODE' using errcode = '22023';
  end if;

  -- Timezone is case-sensitive by IANA convention ("Africa/Lagos", never
  -- "AFRICA/LAGOS") — unlike country/currency codes, no upper()
  -- normalization is applied here; a caller must supply the canonical
  -- identifier exactly or omit it and receive the country's default.
  if p_timezone is null or length(btrim(p_timezone)) = 0 then
    v_timezone := private.default_timezone_for_country(v_country_code);
    if v_timezone is null then
      -- Same fail-closed posture as the currency branch above: no catalog
      -- default exists for this country and none was supplied — never
      -- silently fall back to Africa/Lagos for a business outside the
      -- launch catalog.
      raise exception 'TIMEZONE_REQUIRED_FOR_COUNTRY' using errcode = '22023';
    end if;
  else
    v_timezone := btrim(p_timezone);
  end if;

  if not private.is_supported_timezone(v_timezone) then
    raise exception 'INVALID_BUSINESS_TIMEZONE' using errcode = '22023';
  end if;

  begin
    insert into public.businesses (name, slug, created_by, country_code, currency_code, timezone)
    values (v_name, v_slug, v_uid, v_country_code, v_currency_code, v_timezone);
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

  -- Phase 1L — automatic 14-day Growth trial, carried forward unchanged
  -- from trial_issuance.sql. create_initial_trial is itself the ONLY way
  -- a business_subscriptions row is ever created; it derives
  -- trial_started_at/trial_ends_at from ITS OWN now() call (the
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
  -- resolution is needed the way later lifecycle notifications require,
  -- so this notifies v_uid directly.
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

grant create on schema public to private_business_creator;
alter function public.create_business(text, text, text, text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

revoke all on function public.create_business(text, text, text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text, text, text) to authenticated;
