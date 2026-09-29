-- Phase 1O-E — Internal Admin Dashboard / Final UX & Security.
--
-- Adds exactly two new READ-ONLY platform RPCs to back the redesigned
-- /internal/admin overview screen with truthful, bounded data. This
-- migration mutates nothing and creates no new authorization role: both
-- functions are owned by the existing private_platform_directory_reader
-- role (1O-B) and read only columns that role was already granted in
-- 20260929080000_platform_business_directory.sql and
-- 20261001080000_platform_controlled_actions.sql. No new GRANT of any
-- table column, and no new access to auth.users, is introduced here.
--
-- Every metric below has a single, explicit, documented definition —
-- repeated in the 1O-E build brief — and no number here is invented or
-- inferred: each is a direct count/aggregate over an existing column this
-- role can already read.
--
-- ═══════════════════════════════════════════════════════════════════════
-- 1. get_platform_dashboard_overview — a single bounded aggregate call
--    (phase instructions §49: "prefer one coherent bounded dashboard
--    aggregate rather than many client round trips"). Gated on
--    platform.dashboard.view (existing 1O-A permission, held by every
--    platform role) + AAL2, matching every other platform RPC in this
--    schema.
--
--    Metric definitions (identical wording in the build brief):
--      total_businesses      — count(*) from businesses where status <>
--                               'archived'. Archived businesses are
--                               excluded as a matter of definition: they
--                               are a soft-deleted lifecycle state, not an
--                               operating tenant.
--      active_businesses     — count(*) where status = 'active'.
--      suspended_businesses  — count(*) where status = 'suspended'.
--      trialing_subscriptions — count(*) from business_subscriptions
--                               where status = 'TRIALING'.
--      active_subscriptions   — count(*) where status = 'ACTIVE'.
--      past_due_subscriptions — count(*) where status = 'PAST_DUE'.
--      new_businesses_7d      — count(*) from businesses where
--                               created_at >= now() - interval '7 days'
--                               (bounded window for the Platform Activity
--                               panel; never an unbounded scan result).
--
--    Deliberately NOT included, and why (phase instructions §14/§16/§22,
--    repeated verbatim in the build brief so the omission is never
--    silently reintroduced):
--      Monthly Revenue   — no provider-confirmed platform SaaS billing
--                          ledger exists in this schema. Deriving it from
--                          subscription_plans.name/code or from tenant
--                          sales data would be a fabricated number, which
--                          the phase brief explicitly forbids.
--      Open Support Cases — no support-ticket entity exists in this
--                          schema (1O-C's diagnostics are operational
--                          signals, not tickets). Labeling a diagnostic
--                          count "support cases" would misrepresent it.
--      Critical Alerts / System Health — no monitoring/uptime/latency
--                          backend exists; a seeded or hardcoded figure
--                          here would be exactly the fake metric phase
--                          instructions §52 forbids.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.get_platform_dashboard_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.dashboard.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_businesses', (select count(*) from public.businesses where status <> 'archived'),
    'active_businesses', (select count(*) from public.businesses where status = 'active'),
    'suspended_businesses', (select count(*) from public.businesses where status = 'suspended'),
    'trialing_subscriptions', (select count(*) from public.business_subscriptions where status = 'TRIALING'),
    'active_subscriptions', (select count(*) from public.business_subscriptions where status = 'ACTIVE'),
    'past_due_subscriptions', (select count(*) from public.business_subscriptions where status = 'PAST_DUE'),
    'new_businesses_7d', (
      select count(*) from public.businesses
      where status <> 'archived' and created_at >= now() - interval '7 days'
    )
  ) into v_result;

  return v_result;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.get_platform_dashboard_overview() owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.get_platform_dashboard_overview() from public, anon;
grant execute on function public.get_platform_dashboard_overview() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. list_platform_recent_actions — a platform-WIDE (not single-business)
--    bounded read of platform_action_audit for the Overview's "Recent
--    Platform Actions" panel. Gated on platform.audit.view — the same
--    narrow permission list_platform_business_actions already requires
--    (1O-D), so this does not broaden who can see platform action
--    history; it only broadens the SCOPE of what an already-authorized
--    audit viewer can see in one call (across businesses, not one at a
--    time).
--
--    Deliberately omits actor email: 1O-D's own
--    private.get_platform_action_actor_emails(business_id) is
--    intentionally scoped to actors who acted on ONE requested business,
--    specifically to avoid a generic cross-business auth.users lookup
--    (see that function's own header comment). A platform-wide panel
--    reusing or widening that lookup would reverse a deliberate prior
--    security decision this phase does not have standing to make
--    unilaterally; the existing per-business Actions tab still shows
--    actor email once a specific business is opened. actor_user_id is
--    returned so the UI can render a stable (if anonymous) identifier
--    without a new auth.users access path.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.list_platform_recent_actions(
  p_page      integer default 1,
  p_page_size integer default 10
)
returns table (
  action_id           uuid,
  action_type         text,
  target_business_id  uuid,
  target_business_name text,
  reason              text,
  actor_user_id       uuid,
  occurred_at         timestamptz,
  total_count         bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page      integer;
  v_page_size integer;
  v_offset    integer;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.audit.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 10);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  return query
  with base as (
    select paa.id as action_id, paa.action_type, paa.target_business_id,
           b.name as target_business_name, paa.reason, paa.actor_user_id,
           paa.created_at as occurred_at
    from public.platform_action_audit paa
    join public.businesses b on b.id = paa.target_business_id
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.action_id, counted.action_type, counted.target_business_id,
         counted.target_business_name, counted.reason, counted.actor_user_id,
         counted.occurred_at, counted.total_count
  from counted
  order by counted.occurred_at desc, counted.action_id desc
  limit v_page_size
  offset v_offset;
end;
$$;

-- businesses.name is already granted to private_platform_directory_reader
-- (20260929080000); no new table grant is required for the join above.
grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_recent_actions(integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_recent_actions(integer, integer) from public, anon;
grant execute on function public.list_platform_recent_actions(integer, integer) to authenticated;
