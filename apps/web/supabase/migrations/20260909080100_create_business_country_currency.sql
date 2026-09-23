-- Phase 1Q-0A: extend create_business to accept an optional country/currency
-- for the business it creates, instead of every business being implicitly
-- Nigerian. See docs/phase-1q-0a-country-currency-foundation-build-brief.md
-- for the full design rationale.
--
-- TRANSITIONAL DEFAULTS — READ BEFORE REMOVING:
-- p_country_code defaults to 'NG' and p_currency_code, when omitted,
-- is derived from the country. This is intentional debt, not an
-- oversight: the only caller today (lib/business/actions.ts,
-- createBusiness) still only collects name+slug from the signup form, so
-- it cannot yet supply a real country. Defaulting here (in the one RPC
-- that is the sole write path onto businesses) is the safest place to
-- carry that gap — never widen it into a bare column DEFAULT, which would
-- let every future direct writer reapply the same silent assumption. Once
-- Phase 1Q-0B's onboarding redesign collects and passes a real country,
-- remove these defaults (or make the parameters required) so a caller can
-- no longer create a business without deciding its country/currency.

-- Small, centrally-located lookup mirroring the six-country TS catalog
-- (lib/business/country-currency.ts) — not a giant hardcoded CHECK list on
-- the table (see businesses_currency_code_check, which only enforces
-- shape). Pure logic, no table access: SECURITY INVOKER (the default) is
-- correct, exactly like private.normalize_slug beside it. Unknown/
-- unsupported country codes return null; the caller (create_business)
-- decides how to handle that.
create or replace function private.default_currency_for_country(p_country_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_country_code
    when 'NG' then 'NGN'
    when 'GH' then 'GHS'
    when 'KE' then 'KES'
    when 'ZA' then 'ZAR'
    when 'GB' then 'GBP'
    when 'US' then 'USD'
    else null
  end;
$$;

revoke all on function private.default_currency_for_country(text) from public, anon, authenticated;
grant execute on function private.default_currency_for_country(text) to private_business_creator;

-- Dropped and recreated (not CREATE OR REPLACE) so there is exactly one
-- create_business overload afterward, not two (a bare CREATE OR REPLACE
-- with a different parameter list creates a second, separately-privileged
-- overload rather than replacing the first — see the phase brief's
-- Technical Design §02). The two new parameters are trailing and
-- optional, so every existing 2-argument call
-- (rpc("create_business", { p_name, p_slug })) keeps resolving to this
-- same function with the transitional defaults applied.
--
-- IMPORTANT — this function has been patched in place by TWO later
-- migrations since it was first created, and this replacement must carry
-- both forward or silently regress them:
--   - 20260905080000_trial_issuance.sql: every new business gets an
--     automatic 14-day Growth trial (private.create_initial_trial),
--     transactionally, plus a subscription.trial_started audit event and
--     an in-app notification to the new OWNER. Losing this silently would
--     leave every business created after this migration with NO trial
--     subscription row at all — exactly the kind of change a bare
--     "reproduce the original 2-arg body" DROP+CREATE would cause, which
--     is what happened in this migration's own first draft (caught by
--     tests/integration/subscription-billing-application.test.ts's
--     APP-1L-02-R1 suite failing SUBSCRIPTION_NOT_FOUND after this
--     migration — see docs/phase-1q-0a-country-currency-foundation-build-brief.md
--     for the full incident note). The body below is trial_issuance.sql's
--     version, unchanged, with only the country/currency additions
--     layered on top.
--   - The default-branch-per-business behavior (business-branches.test.ts)
--     is NOT part of this function — it is a separate AFTER INSERT
--     trigger on public.businesses (private.create_default_branch or
--     equivalent), which stays attached to the table regardless of which
--     function performs the INSERT, so it needs no action here.
drop function if exists public.create_business(text, text);

create or replace function public.create_business(
  p_name          text,
  p_slug          text,
  p_country_code  text default 'NG',
  p_currency_code text default null
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
  -- (20260828080300_business_branch_rpcs.sql).
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

  begin
    insert into public.businesses (name, slug, created_by, country_code, currency_code)
    values (v_name, v_slug, v_uid, v_country_code, v_currency_code);
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
  -- from trial_issuance.sql (see the IMPORTANT note above). create_initial_trial
  -- is itself the ONLY way a business_subscriptions row is ever created;
  -- it derives trial_started_at/trial_ends_at from ITS OWN now() call (the
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

grant create on schema public to private_business_creator;
alter function public.create_business(text, text, text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

revoke all on function public.create_business(text, text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text, text) to authenticated;
