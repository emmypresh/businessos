-- Phase 1Q-0B remediation (post-Codex review). The application Server
-- Action (lib/business/actions.ts createBusiness) already enforces the
-- supported-country catalog, the server-derived currency, the
-- country/timezone pairing, and the NG-only activation gate — but
-- public.create_business is a SECURITY DEFINER function granted directly
-- to `authenticated`, so any authenticated caller invoking the RPC
-- directly (bypassing the Server Action entirely) previously reached the
-- database with none of those product rules enforced. This migration
-- moves the same rules onto the durable RPC boundary itself, and adds a
-- table-level CHECK so a direct PostgREST UPDATE of businesses.timezone
-- can't desynchronize a business's timezone from its own country either.
-- The Server Action's checks are NOT removed — this is defense in depth,
-- not a replacement (see the phase brief's own explicit instruction).

-- ---------------------------------------------------------------------
-- 1. Durable helpers, mirroring the TypeScript catalogs exactly
--    (lib/business/country-currency.ts, lib/business/timezone-catalog.ts).
--    Pure logic, no table access: SECURITY INVOKER (the default) is
--    correct, exactly like the sibling helpers beside them.
-- ---------------------------------------------------------------------

-- Mirrors SUPPORTED_COUNTRY_CODES exactly.
create or replace function private.is_supported_country(p_country_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_country_code in ('NG', 'GH', 'KE', 'ZA', 'GB', 'US');
$$;

revoke all on function private.is_supported_country(text) from public, anon, authenticated;
grant execute on function private.is_supported_country(text) to private_business_creator;

-- Mirrors isFullyOperationalCountry exactly: only NG may actually create
-- an operational business until Phase 1Q-0C completes. A single, narrow,
-- named predicate for the same reason the TS version is one — never
-- inlined at each call site, so the one product rule it expresses can be
-- found, reasoned about, and later relaxed in exactly one place.
create or replace function private.is_fully_operational_country(p_country_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_country_code = 'NG';
$$;

revoke all on function private.is_fully_operational_country(text) from public, anon, authenticated;
grant execute on function private.is_fully_operational_country(text) to private_business_creator;

-- Mirrors isTimezoneValidForCountry exactly (COUNTRY_TIMEZONE_OPTIONS in
-- lib/business/timezone-catalog.ts) — a per-country allow-list, not just
-- "is this timezone in the global nine-zone list" (private.
-- is_supported_timezone already does that, and is not enough on its own:
-- it would still let a GB business hold America/Chicago). Used both
-- inside create_business AND as a table CHECK
-- (businesses_timezone_country_check below), so unlike the other helpers
-- in this migration it is also granted to `authenticated` — that role
-- performs the one other write path onto this column
-- (lib/business/actions.ts updateBusinessTimezone, a direct table
-- UPDATE), and CHECK constraints run under the writing role's own
-- privileges, not the table owner's.
create or replace function private.is_timezone_valid_for_country(p_country_code text, p_timezone text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_country_code
    when 'NG' then p_timezone = 'Africa/Lagos'
    when 'GH' then p_timezone = 'Africa/Accra'
    when 'KE' then p_timezone = 'Africa/Nairobi'
    when 'ZA' then p_timezone = 'Africa/Johannesburg'
    when 'GB' then p_timezone = 'Europe/London'
    when 'US' then p_timezone in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles')
    else false
  end;
$$;

revoke all on function private.is_timezone_valid_for_country(text, text) from public, anon;
grant execute on function private.is_timezone_valid_for_country(text, text) to private_business_creator, authenticated;

-- ---------------------------------------------------------------------
-- 2. DB-level country/timezone integrity — protects the Server Action,
--    any direct PostgREST UPDATE, and any future write path alike. Not a
--    trigger: a CHECK is sufficient because the predicate is pure and
--    depends only on the row's own two columns, not on other tables or
--    mutable state. businesses_timezone_check (20260923090000_business_
--    timezone.sql) still stands beside this — that one guarantees shape
--    (a real launch timezone at all); this one guarantees the pairing
--    (the right timezone for THIS row's own country).
-- ---------------------------------------------------------------------
alter table public.businesses
  add constraint businesses_timezone_country_check
    check (private.is_timezone_valid_for_country(country_code, timezone));

-- ---------------------------------------------------------------------
-- 3. create_business RPC — layer the same rules onto the durable
--    boundary. Dropped and recreated (not CREATE OR REPLACE), same
--    reasoning as the two prior migrations that extended this function's
--    signature: this one does NOT change the signature, so a bare CREATE
--    OR REPLACE would normally suffice, but the drop keeps this
--    migration's intent explicit and matches the file's own established
--    pattern. IMPORTANT: every existing behavior (uid derivation, name/
--    slug validation, slug collision handling, trial issuance, audit
--    event, notification, rollback-on-exception, return type, SECURITY
--    DEFINER, empty search_path, ownership, narrow execute grants) is
--    carried forward verbatim from 20260923090100_create_business_
--    timezone.sql — only the country/currency/timezone validation is
--    tightened.
-- ---------------------------------------------------------------------
drop function if exists public.create_business(text, text, text, text, text);

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
  v_expected_currency text;
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
  -- the RPC boundary, not just via the table's shape-only CHECK.
  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BUSINESS_COUNTRY_CODE' using errcode = '22023';
  end if;

  -- NEW (Codex remediation, HIGH finding #1/#2 root cause): a well-formed
  -- but non-catalog country code (e.g. FR) must fail closed here, before
  -- any currency/timezone default lookup or insert is attempted — mirrors
  -- isSupportedCountryCode in lib/business/country-currency.ts.
  if not private.is_supported_country(v_country_code) then
    raise exception 'UNSUPPORTED_BUSINESS_COUNTRY' using errcode = '22023';
  end if;

  -- v_expected_currency is never null past this point: v_country_code
  -- just passed is_supported_country, and default_currency_for_country
  -- returns non-null for every country in that same catalog.
  v_expected_currency := private.default_currency_for_country(v_country_code);

  if p_currency_code is null or length(btrim(p_currency_code)) = 0 then
    v_currency_code := v_expected_currency;
  else
    v_currency_code := upper(btrim(p_currency_code));
  end if;

  if v_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'INVALID_BUSINESS_CURRENCY_CODE' using errcode = '22023';
  end if;

  -- NEW (Codex remediation, HIGH finding #2): currency is not merely
  -- well-formed, it must be the ONE deterministic currency for this
  -- country (NG->NGN, GH->GHS, ...) — a direct caller can no longer pass
  -- e.g. p_country_code=NG, p_currency_code=USD.
  if v_currency_code <> v_expected_currency then
    raise exception 'CURRENCY_COUNTRY_MISMATCH' using errcode = '22023';
  end if;

  -- Timezone is case-sensitive by IANA convention — no upper() applied.
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

  -- NEW (Codex remediation, HIGH finding #2): the timezone must be one of
  -- THIS country's own selectable options, not merely a member of the
  -- global nine-zone list — a direct caller can no longer pass e.g.
  -- p_country_code=NG, p_timezone=America/Chicago, or
  -- p_country_code=GB, p_timezone=Europe/London mismatched against some
  -- other country. Mirrors isTimezoneValidForCountry exactly, and the
  -- same predicate the businesses_timezone_country_check table CHECK
  -- enforces below every future write.
  if not private.is_timezone_valid_for_country(v_country_code, v_timezone) then
    raise exception 'TIMEZONE_COUNTRY_MISMATCH' using errcode = '22023';
  end if;

  -- NEW (Codex remediation, HIGH finding #1): the Phase 1 operational
  -- activation gate, previously enforced ONLY by the Server Action
  -- (lib/business/actions.ts, isFullyOperationalCountry) and therefore
  -- bypassable by any direct authenticated RPC call. Checked last, after
  -- every other validation has already fully resolved the country/
  -- currency/timezone combination, so a request that is ALSO malformed
  -- fails with the more specific error above rather than this one — and
  -- checked strictly before the insert, so no business row, subscription,
  -- audit event, notification, or branch/membership side effect is ever
  -- created for a country that is not yet operational.
  if not private.is_fully_operational_country(v_country_code) then
    raise exception 'COUNTRY_NOT_YET_OPERATIONAL' using errcode = '22023';
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

  -- Phase 1L — automatic 14-day Growth trial, carried forward unchanged.
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

grant create on schema public to private_business_creator;
alter function public.create_business(text, text, text, text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

revoke all on function public.create_business(text, text, text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text, text, text) to authenticated;
