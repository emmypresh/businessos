-- Phase 1O-D remediation — Billing action entry-point.
--
-- QA finding: BILLING holds platform.subscriptions.extend_trial (granted in
-- 20261001080000) but does NOT hold platform.businesses.view. The only
-- existing Platform Actions surface is the "?tab=actions" tab on
-- /internal/admin/businesses/[businessId], whose PAGE SHELL requires
-- platform.businesses.view (app/internal/admin/businesses/[businessId]/page.tsx).
-- BILLING can therefore never reach a mutation permission it legitimately
-- holds. The fix is NOT to grant platform.businesses.view to BILLING — that
-- would additionally expose Members/Branches/Activity/Diagnostics, none of
-- which BILLING has ever been granted visibility into (1O-A's own role
-- matrix). Instead this migration adds exactly one new, narrow read path —
-- get_platform_business_action_context — gated on "caller holds at least
-- one of the three controlled-action permissions", never on
-- platform.businesses.view. It returns only the fields a mutation dialog
-- needs (id, name, status, trial state) — never members, branches,
-- activity, audit, diagnostics, or owner/member emails.
--
-- No mutation RPC changes here. platform_suspend_business/
-- platform_reactivate_business/platform_extend_trial (20261001080000) are
-- untouched and remain each mutation's own independent authorization
-- boundary — this migration's new function is a READ path only, feeding
-- the dedicated /internal/admin/businesses/[businessId]/actions route.
--
-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1 — private_platform_action_writer needs SELECT on
-- businesses.name to render "which business is this" on the dedicated
-- actions route (it already has select(id, status) from 20261001080000).
-- Column-level grant only, exactly matching that migration's own posture
-- — never a blanket table grant.
-- ═══════════════════════════════════════════════════════════════════════
grant select (name) on public.businesses to private_platform_action_writer;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2 — get_platform_business_action_context: the minimal read the
-- dedicated actions route needs. Gate is "at least one of the three
-- controlled-action permissions" (an OR, unlike every existing platform
-- RPC's single-permission check) — private.has_platform_permission already
-- independently re-verifies active-admin + AAL2 for EACH call, so ORing
-- three calls to it is still fully fail-closed and never trusts anything
-- from the caller.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.get_platform_business_action_context(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business      record;
  v_subscription  record;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not (
    private.has_platform_permission('platform.businesses.suspend')
    or private.has_platform_permission('platform.businesses.reactivate')
    or private.has_platform_permission('platform.subscriptions.extend_trial')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;

  select b.id, b.name, b.status
  into v_business
  from public.businesses b
  where b.id = p_business_id;

  if v_business.id is null then
    return null;
  end if;

  select bs.status, bs.trial_ends_at
  into v_subscription
  from public.business_subscriptions bs
  where bs.business_id = p_business_id;

  return jsonb_build_object(
    'business_id', v_business.id,
    'business_name', v_business.name,
    'status', v_business.status,
    'subscription', case
      when v_subscription.status is null then null
      else jsonb_build_object('status', v_subscription.status, 'trial_ends_at', v_subscription.trial_ends_at)
    end
  );
end;
$$;

grant create on schema public to private_platform_action_writer;
alter function public.get_platform_business_action_context(uuid) owner to private_platform_action_writer;
revoke create on schema public from private_platform_action_writer;
revoke all on function public.get_platform_business_action_context(uuid) from public, anon;
grant execute on function public.get_platform_business_action_context(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 3 — list_platform_action_eligible_businesses: the smallest safe
-- navigation mechanism for a BILLING admin (who holds no
-- platform.businesses.view and therefore cannot use the 1O-B business
-- directory at /internal/admin/businesses) to find a business by name and
-- reach its dedicated actions route. NOT a Subscriptions console: search by
-- name only, returns only id/name/status/trial fields — the same minimal
-- shape as get_platform_business_action_context above, never member/
-- branch/activity/audit data. Gated identically (any of the three
-- controlled-action permissions), reusing private_platform_action_writer —
-- no new database role.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.list_platform_action_eligible_businesses(
  p_search    text default null,
  p_page      integer default 1,
  p_page_size integer default 25
)
returns table (
  business_id          uuid,
  business_name        text,
  business_status      text,
  subscription_status  text,
  trial_ends_at        timestamptz,
  total_count          bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search    text;
  v_page      integer;
  v_page_size integer;
  v_offset    integer;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not (
    private.has_platform_permission('platform.businesses.suspend')
    or private.has_platform_permission('platform.businesses.reactivate')
    or private.has_platform_permission('platform.subscriptions.extend_trial')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is not null and length(v_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  return query
  with base as (
    select b.id as business_id, b.name as business_name, b.status as business_status,
           bs.status as subscription_status, bs.trial_ends_at
    from public.businesses b
    left join public.business_subscriptions bs on bs.business_id = b.id
    where v_search is null or b.name ilike '%' || v_search || '%'
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.business_id, counted.business_name, counted.business_status,
         counted.subscription_status, counted.trial_ends_at, counted.total_count
  from counted
  order by counted.business_name asc, counted.business_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_action_writer;
alter function public.list_platform_action_eligible_businesses(text, integer, integer)
  owner to private_platform_action_writer;
revoke create on schema public from private_platform_action_writer;
revoke all on function public.list_platform_action_eligible_businesses(text, integer, integer) from public, anon;
grant execute on function public.list_platform_action_eligible_businesses(text, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 4 — explicitly NOT done, per phase instructions §9: no grant of
-- platform.businesses.view to BILLING exists in this migration or any
-- other. Confirmed by inspection: 20261001080000's own
-- platform_role_permissions insert (section 1) grants BILLING only
-- platform.subscriptions.extend_trial; this migration adds no row to
-- platform_role_permissions at all.
-- ═══════════════════════════════════════════════════════════════════════
