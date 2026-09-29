-- Phase 1O-E (completion pass) — Platform Audit, Subscriptions, and Support
-- pages. Adds four new bounded, read-only platform RPCs plus one small
-- postgres-owned actor-email helper. Every function below is owned by the
-- EXISTING private_platform_directory_reader role (1O-B) — no new role is
-- created — and every column read is already granted to that role by
-- 20260929080000_platform_business_directory.sql /
-- 20260930080000_platform_business_operational_intelligence.sql /
-- 20261001080000_platform_controlled_actions.sql, except the one small
-- additive EXECUTE grant in section 0.
--
-- Nothing in this migration alters an existing table's schema, RLS policy,
-- or grant to `authenticated`/`anon`. Nothing here changes any *.view
-- permission's role mapping (public.platform_role_permissions is untouched)
-- — the same five roles keep the exact same permissions the 1O-A matrix
-- already seeded.
--
-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 0 — private.escape_ilike_pattern was introduced in 1O-D
-- (20261002090000_harden_platform_billing_action_lookup.sql) and granted
-- only to private_platform_action_writer. This section additively grants
-- EXECUTE on the SAME function to private_platform_directory_reader — the
-- function's behavior is unchanged; a second, already-narrowly-scoped
-- reader role is simply allowed to call it too, for the search filters in
-- sections 2 and 3 below.
-- ═══════════════════════════════════════════════════════════════════════
grant execute on function private.escape_ilike_pattern(text) to private_platform_directory_reader;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1 — get_platform_dashboard_overview gains one additional,
-- identically-defined counter: canceled_subscriptions (business_subscriptions
-- where status = 'CANCELED'). Purely additive to the returned jsonb object —
-- every existing key keeps its exact prior value and meaning, so this is
-- backward compatible with the Overview page and with
-- tests/integration/platform-dashboard-overview.test.ts (which asserts a
-- fixed set of keys are present and numeric; it does not assert the FULL
-- key set is closed, and gains a fixed 8th key here). Needed so the new
-- Subscriptions page's summary cards (Active/Trialing/Past Due/Canceled)
-- share exactly one authoritative source with the Overview page rather than
-- two RPCs disagreeing on the same number.
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
    'canceled_subscriptions', (select count(*) from public.business_subscriptions where status = 'CANCELED'),
    'new_businesses_7d', (
      select count(*) from public.businesses
      where status <> 'archived' and created_at >= now() - interval '7 days'
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Owner/grants already established by 20261003080000; CREATE OR REPLACE
-- preserves them (privileges attach to the function object, not its body).

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2 — Platform Audit: public.list_platform_audit.
--
-- Gated on platform.audit.view (SUPER_ADMIN only in the frozen 1O-A
-- matrix) — the SAME permission list_platform_business_actions (1O-D,
-- per-business) already requires; this is that same authorized viewer's
-- platform-WIDE equivalent, not a new authorization boundary. Reads
-- ONLY public.platform_action_audit — deliberately NOT the tenant
-- audit_events ledger (see 20261001080000's own header comment on why
-- those are separate trust domains: "what BusinessOS staff did" vs. "what
-- a tenant user did"). This is "Platform Administrative Actions", not a
-- claim to show every event in the product.
--
-- before_state/after_state are NEVER returned as raw jsonb — a small,
-- deterministic plain-text change_summary is computed server-side instead
-- (phase instruction: "No raw JSON payload... safe before/after summary"),
-- since every action_type's shape is fixed and known (SUSPEND_BUSINESS/
-- REACTIVATE_BUSINESS carry {"status":...}, EXTEND_TRIAL carries
-- {"trial_ends_at":...} — see 20261001080000's own mutation RPCs).
--
-- actor_email is resolved platform-wide here (unlike the Overview's
-- Recent Platform Actions panel, which deliberately omits it — see
-- 20261003080000's own header comment on that narrower decision). This
-- page's entire purpose, gated on platform.audit.view, is exactly "who on
-- staff did what" — resolving the actor's email here does not broaden
-- what an audit.view holder can already see (every actor is already
-- readable, one business at a time, via the existing
-- get_platform_action_actor_emails(business_id)); it only removes the
-- need to open every business individually.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function private.get_platform_action_actor_emails_all()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct paa.actor_user_id, lower(btrim(u.email))
  from public.platform_action_audit paa
  join auth.users u on u.id = paa.actor_user_id;
$$;

revoke all on function private.get_platform_action_actor_emails_all() from public, anon, authenticated;
grant execute on function private.get_platform_action_actor_emails_all() to private_platform_directory_reader;

create or replace function public.list_platform_audit(
  p_page            integer default 1,
  p_page_size       integer default 25,
  p_action_type     text default null,
  p_business_search text default null,
  p_date_from       timestamptz default null,
  p_date_to         timestamptz default null
)
returns table (
  action_id            uuid,
  action_type          text,
  actor_email          text,
  target_business_id   uuid,
  target_business_name text,
  reason               text,
  change_summary       text,
  occurred_at          timestamptz,
  total_count          bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page        integer;
  v_page_size   integer;
  v_offset      integer;
  v_action_type text;
  v_search      text;
  v_escaped     text;
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
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  if p_action_type is not null and p_action_type not in
    ('SUSPEND_BUSINESS', 'REACTIVATE_BUSINESS', 'EXTEND_TRIAL') then
    raise exception 'INVALID_ACTION_TYPE' using errcode = '22023';
  end if;
  v_action_type := p_action_type;

  if p_business_search is not null and length(p_business_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_business_search), '');
  v_escaped := case when v_search is null then null else private.escape_ilike_pattern(v_search) end;

  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  return query
  with base as (
    select
      paa.id as action_id,
      paa.action_type,
      ae.email as actor_email,
      paa.target_business_id,
      b.name as target_business_name,
      paa.reason,
      case
        when paa.action_type in ('SUSPEND_BUSINESS', 'REACTIVATE_BUSINESS') then
          format('status: %s -> %s', paa.before_state ->> 'status', paa.after_state ->> 'status')
        when paa.action_type = 'EXTEND_TRIAL' then
          format('trial ends: %s -> %s', paa.before_state ->> 'trial_ends_at', paa.after_state ->> 'trial_ends_at')
        else 'updated'
      end as change_summary,
      paa.created_at as occurred_at
    from public.platform_action_audit paa
    join public.businesses b on b.id = paa.target_business_id
    left join private.get_platform_action_actor_emails_all() ae on ae.user_id = paa.actor_user_id
    where (v_action_type is null or paa.action_type = v_action_type)
      and (v_escaped is null or b.name ilike '%' || v_escaped || '%' escape '\')
      and (p_date_from is null or paa.created_at >= p_date_from)
      and (p_date_to is null or paa.created_at <= p_date_to)
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.action_id, counted.action_type, counted.actor_email, counted.target_business_id,
         counted.target_business_name, counted.reason, counted.change_summary, counted.occurred_at,
         counted.total_count
  from counted
  order by counted.occurred_at desc, counted.action_id desc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_audit(integer, integer, text, text, timestamptz, timestamptz)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_audit(integer, integer, text, text, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.list_platform_audit(integer, integer, text, text, timestamptz, timestamptz)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 3 — Subscriptions: public.list_platform_subscriptions.
--
-- Gated on platform.subscriptions.view. Read-only — no mutation surface is
-- added here; the only existing subscription mutation remains
-- platform_extend_trial (1O-D), reached from the frozen
-- /internal/admin/businesses/[businessId]/actions route, never duplicated
-- here. Fields returned are exactly the same subset 1O-B's own
-- list_platform_businesses already exposes for subscriptions (plan, status,
-- trial/period dates, cancel flag) — no provider reference, no payment
-- token, no webhook payload column exists on business_subscriptions for
-- this role to read in the first place.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.list_platform_subscriptions(
  p_page      integer default 1,
  p_page_size integer default 25,
  p_search    text default null,
  p_status    text default null
)
returns table (
  business_id             uuid,
  business_name           text,
  plan_code               text,
  plan_name               text,
  status                  text,
  trial_ends_at           timestamptz,
  current_period_ends_at  timestamptz,
  cancel_at_period_end    boolean,
  total_count             bigint
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
  v_search    text;
  v_escaped   text;
  v_status    text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.subscriptions.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  if p_status is not null and p_status not in
    ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'INCOMPLETE') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  v_status := p_status;

  if p_search is not null and length(p_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');
  v_escaped := case when v_search is null then null else private.escape_ilike_pattern(v_search) end;

  return query
  with base as (
    select
      b.id as business_id,
      b.name as business_name,
      sp.code as plan_code,
      sp.name as plan_name,
      bs.status,
      bs.trial_ends_at,
      bs.current_period_ends_at,
      bs.cancel_at_period_end
    from public.business_subscriptions bs
    join public.businesses b on b.id = bs.business_id
    left join public.subscription_plans sp on sp.id = bs.plan_id
    where b.status <> 'archived'
      and (v_status is null or bs.status = v_status)
      and (v_escaped is null or b.name ilike '%' || v_escaped || '%' escape '\')
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.business_id, counted.business_name, counted.plan_code, counted.plan_name,
         counted.status, counted.trial_ends_at, counted.current_period_ends_at,
         counted.cancel_at_period_end, counted.total_count
  from counted
  order by counted.business_name asc, counted.business_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_subscriptions(integer, integer, text, text)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_subscriptions(integer, integer, text, text) from public, anon;
grant execute on function public.list_platform_subscriptions(integer, integer, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 4 — Support / "Businesses Requiring Attention":
-- public.list_platform_business_diagnostics + public.get_platform_support_summary.
--
-- Gated on platform.businesses.view — reusing the existing permission
-- rather than minting a new platform.support.view for UI convenience
-- (phase instruction §13). Reuses the EXACT SAME seven diagnostic rules
-- get_platform_business_overview (1O-C) already computes per business —
-- copied verbatim here as a set-based query across every business in ONE
-- bounded pass (a single CTE with per-business scalar subqueries, then a
-- UNION ALL of the seven flag conditions), never one RPC call per business
-- (phase instruction §16 — "avoid N+1 across all businesses"). No health
-- score, no AI recommendation, no diagnostic invented beyond the frozen
-- seven codes.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.list_platform_business_diagnostics(
  p_page      integer default 1,
  p_page_size integer default 25,
  p_severity  text default null,
  p_search    text default null
)
returns table (
  business_id   uuid,
  business_name text,
  code          text,
  severity      text,
  message       text,
  total_count   bigint
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
  v_severity  text;
  v_search    text;
  v_escaped   text;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  if p_severity is not null and p_severity not in ('WARNING', 'INFO') then
    raise exception 'INVALID_SEVERITY' using errcode = '22023';
  end if;
  v_severity := p_severity;

  if p_search is not null and length(p_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');
  v_escaped := case when v_search is null then null else private.escape_ilike_pattern(v_search) end;

  return query
  with stats as (
    select
      b.id as business_id,
      b.name as business_name,
      exists (
        select 1 from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = b.id and r.name = 'OWNER' and bm.status = 'active'
      ) as has_owner,
      (select count(*) from public.business_branches bb
        where bb.business_id = b.id and bb.status = 'ACTIVE') as active_branch_count,
      (select count(*) from public.business_members bm2
        where bm2.business_id = b.id and bm2.status = 'active') as active_member_count,
      bs.status as sub_status,
      bs.trial_ends_at,
      sp.code as plan_code,
      (select count(*) from public.whatsapp_messages wm
        where wm.business_id = b.id and wm.status = 'FAILED'
          and wm.failed_at > now() - interval '7 days') as recent_whatsapp_failures
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    left join public.subscription_plans sp on sp.id = bs.plan_id
    where b.status <> 'archived'
      and (v_escaped is null or b.name ilike '%' || v_escaped || '%' escape '\')
  ),
  flagged as (
    select stats.business_id, stats.business_name, 'NO_ACTIVE_OWNER' as code, 'WARNING' as severity,
           'No active OWNER membership.' as message
    from stats where not stats.has_owner
    union all
    select stats.business_id, stats.business_name, 'NO_ACTIVE_BRANCH', 'WARNING', 'No active branch.'
    from stats where stats.active_branch_count = 0
    union all
    select stats.business_id, stats.business_name, 'ZERO_ACTIVE_MEMBERS', 'WARNING', 'No active members.'
    from stats where stats.active_member_count = 0
    union all
    select stats.business_id, stats.business_name, 'SUBSCRIPTION_MISSING', 'WARNING', 'No subscription record.'
    from stats where stats.sub_status is null
    union all
    select stats.business_id, stats.business_name, 'SUBSCRIPTION_PLAN_MISSING', 'WARNING',
           'Subscription exists but has no resolvable plan.'
    from stats where stats.sub_status is not null and stats.plan_code is null
    union all
    select stats.business_id, stats.business_name, 'EXPIRED_TRIAL', 'WARNING',
           'Trial period has ended but subscription is still TRIALING.'
    from stats where stats.sub_status = 'TRIALING' and stats.trial_ends_at < now()
    union all
    select stats.business_id, stats.business_name, 'RECENT_WHATSAPP_FAILURES', 'INFO',
           format('%s WhatsApp delivery failure(s) in the last 7 days.', stats.recent_whatsapp_failures)
    from stats where stats.recent_whatsapp_failures > 0
  ),
  filtered as (
    select flagged.* from flagged where v_severity is null or flagged.severity = v_severity
  ),
  counted as (
    select filtered.*, count(*) over () as total_count from filtered
  )
  select counted.business_id, counted.business_name, counted.code, counted.severity,
         counted.message, counted.total_count
  from counted
  order by (counted.severity = 'WARNING') desc, counted.business_name asc, counted.code asc, counted.business_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_business_diagnostics(integer, integer, text, text)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_business_diagnostics(integer, integer, text, text)
  from public, anon;
grant execute on function public.list_platform_business_diagnostics(integer, integer, text, text)
  to authenticated;

-- Unfiltered summary counts for the Support page's KPI cards — computed
-- once via the same set-based logic as above, never per-row on the client.
create or replace function public.get_platform_support_summary()
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
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  with stats as (
    select
      b.id as business_id,
      exists (
        select 1 from public.business_members bm
        join public.roles r on r.id = bm.role_id
        where bm.business_id = b.id and r.name = 'OWNER' and bm.status = 'active'
      ) as has_owner,
      (select count(*) from public.business_branches bb
        where bb.business_id = b.id and bb.status = 'ACTIVE') as active_branch_count,
      (select count(*) from public.business_members bm2
        where bm2.business_id = b.id and bm2.status = 'active') as active_member_count,
      bs.status as sub_status,
      bs.trial_ends_at,
      sp.code as plan_code,
      (select count(*) from public.whatsapp_messages wm
        where wm.business_id = b.id and wm.status = 'FAILED'
          and wm.failed_at > now() - interval '7 days') as recent_whatsapp_failures
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    left join public.subscription_plans sp on sp.id = bs.plan_id
    where b.status <> 'archived'
  ),
  flags as (
    select business_id, 'WARNING'::text as severity, 0 as whatsapp from stats where not has_owner
    union all
    select business_id, 'WARNING', 0 from stats where active_branch_count = 0
    union all
    select business_id, 'WARNING', 0 from stats where active_member_count = 0
    union all
    select business_id, 'WARNING', 0 from stats where sub_status is null
    union all
    select business_id, 'WARNING', 0 from stats where sub_status is not null and plan_code is null
    union all
    select business_id, 'WARNING', 0 from stats where sub_status = 'TRIALING' and trial_ends_at < now()
    union all
    select business_id, 'INFO', 1 from stats where recent_whatsapp_failures > 0
  )
  select jsonb_build_object(
    'businesses_requiring_attention', (select count(distinct business_id) from flags),
    'warnings', (select count(*) from flags where severity = 'WARNING'),
    'info', (select count(*) from flags where severity = 'INFO'),
    'recent_whatsapp_failures', (select count(*) from flags where whatsapp = 1)
  ) into v_result;

  return v_result;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.get_platform_support_summary() owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.get_platform_support_summary() from public, anon;
grant execute on function public.get_platform_support_summary() to authenticated;
