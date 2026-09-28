-- Phase 1O-C — Support & Operational Intelligence.
--
-- Adds four new read-only RPCs alongside the frozen 1O-B
-- get_platform_business_detail (never altered by this migration):
-- public.get_platform_business_overview, public.list_platform_business_members,
-- public.list_platform_business_activity, and public.list_platform_business_audit.
--
-- TWO-PERMISSION MODEL (approved architecture, non-negotiable): Overview/
-- Members/Branches/Subscription/Activity/Diagnostics all require
-- platform.businesses.view (already seeded in 1O-A). The Audit tab and its
-- RPC require the SEPARATE platform.audit.view permission (also already
-- seeded in 1O-A, held only by SUPER_ADMIN per that phase's frozen role
-- matrix) — platform.businesses.view never implies platform.audit.view,
-- and this migration adds no row to platform_role_permissions widening
-- that frozen mapping. Every RPC below independently re-verifies its own
-- permission requirement via private.has_platform_permission, exactly like
-- every existing platform RPC — never relying on UI-layer hiding alone.
--
-- READER ROLE: reuses private_platform_directory_reader (1O-B) with
-- additive, narrow, column-level SELECT grants on the handful of tables
-- this phase's overview/members/activity/diagnostics reads actually need
-- (expenses, sales, sale_returns, invoice_payments, invoices,
-- whatsapp_messages, audit_events, business_subscriptions/plans already
-- granted). No new BYPASSRLS role is created.
--
-- AUTH.USERS: no new direct access. Member/activity/audit actor emails are
-- resolved via a NEW narrowly-scoped helper,
-- private.get_business_actor_emails(business_id), which mirrors 1O-B's own
-- private.get_business_owner_email/private.get_business_member_emails
-- pattern exactly (owned by `postgres`, joins auth.users only through
-- business_members rows already scoped to the one requested business_id —
-- never a generic auth.users search/list primitive).

-- ---------------------------------------------------------------------
-- 1. Additive reader-role grants.
-- ---------------------------------------------------------------------
grant select (id, business_id, branch_id, branch_name_snapshot, expense_number,
  category_name_snapshot, amount, currency_code, payment_method, status, incurred_at,
  created_by, created_at)
  on public.expenses to private_platform_directory_reader;
grant select (id, business_id, branch_id, branch_name_snapshot, sale_number, status,
  payment_status, total, currency_code, created_by, created_at, completed_at)
  on public.sales to private_platform_directory_reader;
grant select (id, business_id, branch_id, branch_name_snapshot, return_number, refund_amount,
  refund_method, created_by, created_at)
  on public.sale_returns to private_platform_directory_reader;
grant select (id, business_id, invoice_id, branch_id, amount, payment_method, recorded_by, paid_at)
  on public.invoice_payments to private_platform_directory_reader;
grant select (id, business_id, invoice_number) on public.invoices to private_platform_directory_reader;
grant select (id, business_id, branch_id, direction, status, failed_at, created_at, sender_kind)
  on public.whatsapp_messages to private_platform_directory_reader;
grant select (id, business_id, branch_id, actor_type, actor_user_id, actor_email_snapshot,
  action, category, resource_type, resource_id, resource_label_snapshot, outcome, created_at)
  on public.audit_events to private_platform_directory_reader;

-- ---------------------------------------------------------------------
-- 2. Actor-email lookup — scoped to a single business's own members only,
--    exactly mirroring 1O-B's owner/member email helpers. Never a bare
--    "look up any user_id" primitive: the join is always through
--    business_members WHERE business_id = p_business_id, so this can only
--    ever resolve emails for users who are (or were) members of the
--    requested business.
-- ---------------------------------------------------------------------
create or replace function private.get_business_actor_emails(p_business_id uuid)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct bm.user_id, lower(btrim(u.email))
  from public.business_members bm
  join auth.users u on u.id = bm.user_id
  where bm.business_id = p_business_id;
$$;

revoke all on function private.get_business_actor_emails(uuid) from public, anon, authenticated;
grant execute on function private.get_business_actor_emails(uuid) to private_platform_directory_reader;

-- ---------------------------------------------------------------------
-- 3. get_platform_business_overview — bounded overview + branch summary +
--    deterministic diagnostics, in one call. Same jsonb-return shape
--    convention as the frozen 1O-B detail RPC, extended with owner
--    membership status and diagnostics (neither of which 1O-B returns).
-- ---------------------------------------------------------------------
create or replace function public.get_platform_business_overview(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business record;
  v_result   jsonb;
  v_diagnostics jsonb := '[]'::jsonb;
  v_has_owner boolean;
  v_active_branch_count bigint;
  v_active_member_count bigint;
  v_subscription record;
  v_recent_whatsapp_failures bigint;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;

  select b.id, b.name, b.slug, b.status, b.country_code, b.currency_code, b.timezone, b.created_at
  into v_business
  from public.businesses b
  where b.id = p_business_id;

  if v_business.id is null then
    return null;
  end if;

  select exists (
    select 1 from public.business_members bm
    join public.roles r on r.id = bm.role_id
    where bm.business_id = p_business_id and r.name = 'OWNER' and bm.status = 'active'
  ) into v_has_owner;

  select count(*) into v_active_branch_count
  from public.business_branches where business_id = p_business_id and status = 'ACTIVE';

  select count(*) into v_active_member_count
  from public.business_members where business_id = p_business_id and status = 'active';

  select bs.status, bs.trial_ends_at, bs.current_period_ends_at, bs.cancel_at_period_end,
         sp.code as plan_code, sp.name as plan_name
  into v_subscription
  from public.business_subscriptions bs
  left join public.subscription_plans sp on sp.id = bs.plan_id
  where bs.business_id = p_business_id;

  select count(*) into v_recent_whatsapp_failures
  from public.whatsapp_messages
  where business_id = p_business_id
    and status = 'FAILED'
    and failed_at > now() - interval '7 days';

  -- Deterministic diagnostics — restrained severity values only (OK/INFO/
  -- WARNING), each rule objectively testable against real schema state.
  -- No health/AI/risk/engagement score of any kind.
  if not v_has_owner then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'NO_ACTIVE_OWNER', 'severity', 'WARNING',
      'message', 'No active OWNER membership.'));
  end if;
  if v_active_branch_count = 0 then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'NO_ACTIVE_BRANCH', 'severity', 'WARNING',
      'message', 'No active branch.'));
  end if;
  if v_active_member_count = 0 then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'ZERO_ACTIVE_MEMBERS', 'severity', 'WARNING',
      'message', 'No active members.'));
  end if;
  if v_subscription.status is null then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'SUBSCRIPTION_MISSING', 'severity', 'WARNING',
      'message', 'No subscription record.'));
  elsif v_subscription.plan_code is null then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'SUBSCRIPTION_PLAN_MISSING', 'severity', 'WARNING',
      'message', 'Subscription exists but has no resolvable plan.'));
  elsif v_subscription.status = 'TRIALING' and v_subscription.trial_ends_at < now() then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'EXPIRED_TRIAL', 'severity', 'WARNING',
      'message', 'Trial period has ended but subscription is still TRIALING.'));
  end if;
  if v_recent_whatsapp_failures > 0 then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'RECENT_WHATSAPP_FAILURES', 'severity', 'INFO',
      'message', format('%s WhatsApp delivery failure(s) in the last 7 days.', v_recent_whatsapp_failures)));
  end if;
  if jsonb_array_length(v_diagnostics) = 0 then
    v_diagnostics := jsonb_build_array(jsonb_build_object(
      'code', 'OK', 'severity', 'OK', 'message', 'No issues detected.'));
  end if;

  select jsonb_build_object(
    'business_id', v_business.id,
    'business_name', v_business.name,
    'slug', v_business.slug,
    'status', v_business.status,
    'country_code', v_business.country_code,
    'currency_code', v_business.currency_code,
    'timezone', v_business.timezone,
    'created_at', v_business.created_at,
    'owner_email', private.get_business_owner_email(v_business.id),
    'has_active_owner', v_has_owner,
    'member_count', v_active_member_count,
    'branch_count', (select count(*) from public.business_branches where business_id = v_business.id),
    'active_branch_count', v_active_branch_count,
    'subscription', case when v_subscription.status is null then null else jsonb_build_object(
      'plan_code', v_subscription.plan_code,
      'plan_name', v_subscription.plan_name,
      'status', v_subscription.status,
      'trial_ends_at', v_subscription.trial_ends_at,
      'current_period_ends_at', v_subscription.current_period_ends_at,
      'cancel_at_period_end', v_subscription.cancel_at_period_end
    ) end,
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'branch_id', br.id, 'name', br.name, 'code', br.code, 'status', br.status,
        'created_at', br.created_at,
        'member_count', (
          select count(*) from public.business_member_branches mbr
          join public.business_members bm on bm.id = mbr.member_id and bm.status = 'active'
          where mbr.branch_id = br.id
        )
      ) order by br.created_at asc), '[]'::jsonb)
      from public.business_branches br
      where br.business_id = v_business.id
    ),
    'diagnostics', v_diagnostics
  ) into v_result;

  return v_result;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.get_platform_business_overview(uuid) owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.get_platform_business_overview(uuid) from public, anon;
grant execute on function public.get_platform_business_overview(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. list_platform_business_members — paginated/searchable/filterable/
--    sortable, scoped to one business only.
-- ---------------------------------------------------------------------
create or replace function public.list_platform_business_members(
  p_business_id uuid,
  p_search      text default null,
  p_role        text default null,
  p_status      text default null,
  p_branch_id   uuid default null,
  p_sort        text default 'created_at',
  p_dir         text default 'desc',
  p_page        integer default 1,
  p_page_size   integer default 25
)
returns table (
  member_id           uuid,
  email               text,
  role                text,
  status              text,
  primary_branch_id   uuid,
  primary_branch_name text,
  created_at          timestamptz,
  total_count         bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search    text;
  v_sort      text;
  v_dir       text;
  v_page      integer;
  v_page_size integer;
  v_offset    integer;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;

  if p_search is not null and length(p_search) > 200 then
    raise exception 'INVALID_SEARCH' using errcode = '22023';
  end if;
  v_search := nullif(btrim(p_search), '');

  if p_role is not null and p_role not in
     ('OWNER', 'ADMIN', 'MANAGER', 'SALES', 'INVENTORY', 'ACCOUNTANT', 'VIEWER') then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('invited', 'active', 'suspended', 'removed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  v_sort := coalesce(p_sort, 'created_at');
  if v_sort not in ('email', 'role', 'status', 'created_at') then
    raise exception 'INVALID_SORT' using errcode = '22023';
  end if;
  v_dir := lower(coalesce(p_dir, 'desc'));
  if v_dir not in ('asc', 'desc') then
    raise exception 'INVALID_SORT_DIRECTION' using errcode = '22023';
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
  with filtered as (
    select
      bm.id as member_id, ae.email, r.name as role, bm.status, bm.created_at,
      bmb.branch_id as primary_branch_id, bb.name as primary_branch_name
    from public.business_members bm
    join public.roles r on r.id = bm.role_id
    left join private.get_business_actor_emails(p_business_id) ae on ae.user_id = bm.user_id
    left join public.business_member_branches bmb on bmb.member_id = bm.id and bmb.is_primary = true
    left join public.business_branches bb on bb.id = bmb.branch_id
    where bm.business_id = p_business_id
      and (v_search is null
        or ae.email ilike ('%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%') escape '\')
      and (p_role is null or r.name = p_role)
      and (p_status is null or bm.status = p_status)
      and (p_branch_id is null or bmb.branch_id = p_branch_id)
  ),
  counted as (
    select filtered.*, count(*) over () as total_count from filtered
  )
  select
    counted.member_id, counted.email, counted.role, counted.status,
    counted.primary_branch_id, counted.primary_branch_name, counted.created_at, counted.total_count
  from counted
  order by
    case when v_sort = 'email' and v_dir = 'asc' then counted.email end asc,
    case when v_sort = 'email' and v_dir = 'desc' then counted.email end desc,
    case when v_sort = 'role' and v_dir = 'asc' then counted.role end asc,
    case when v_sort = 'role' and v_dir = 'desc' then counted.role end desc,
    case when v_sort = 'status' and v_dir = 'asc' then counted.status end asc,
    case when v_sort = 'status' and v_dir = 'desc' then counted.status end desc,
    case when v_sort = 'created_at' and v_dir = 'asc' then counted.created_at end asc,
    case when v_sort = 'created_at' and v_dir = 'desc' then counted.created_at end desc,
    counted.member_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_business_members(uuid, text, text, text, uuid, text, text, integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_business_members(uuid, text, text, text, uuid, text, text, integer, integer)
  from public, anon;
grant execute on function public.list_platform_business_members(uuid, text, text, text, uuid, text, text, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5. list_platform_business_activity — bounded normalized read model
--    across sales/expenses/invoice_payments/sale_returns/WhatsApp,
--    deterministically ordered (occurred_at desc, then source, then id).
-- ---------------------------------------------------------------------
create or replace function public.list_platform_business_activity(
  p_business_id uuid,
  p_page        integer default 1,
  p_page_size   integer default 25
)
returns table (
  occurred_at  timestamptz,
  category     text,
  summary      text,
  reference_id uuid,
  branch_name  text,
  actor_email  text,
  total_count  bigint
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
  if not private.has_platform_permission('platform.businesses.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
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
  with events as (
    select s.completed_at as occurred_at, 'Sale'::text as category,
           format('Sale %s completed (%s %s)', s.sale_number, s.currency_code, s.total) as summary,
           s.id as reference_id, s.branch_name_snapshot as branch_name, s.created_by as actor_user_id,
           'sale'::text as source
    from public.sales s
    where s.business_id = p_business_id and s.status = 'COMPLETED'

    union all

    select e.incurred_at, 'Expense', format('Expense %s posted (%s %s)', e.expense_number, e.currency_code, e.amount),
           e.id, e.branch_name_snapshot, e.created_by, 'expense'
    from public.expenses e
    where e.business_id = p_business_id and e.status = 'POSTED'

    union all

    select ip.paid_at, 'Invoice Payment',
           format('Payment of %s recorded on invoice %s', ip.amount, coalesce(i.invoice_number, ip.invoice_id::text)),
           ip.id, bb.name, ip.recorded_by, 'invoice_payment'
    from public.invoice_payments ip
    left join public.invoices i on i.id = ip.invoice_id
    left join public.business_branches bb on bb.id = ip.branch_id
    where ip.business_id = p_business_id

    union all

    select sr.created_at, 'Return', format('Return %s recorded (refund %s)', sr.return_number, sr.refund_amount),
           sr.id, sr.branch_name_snapshot, sr.created_by, 'return'
    from public.sale_returns sr
    where sr.business_id = p_business_id

    union all

    select wm.created_at, 'WhatsApp',
           format('%s message %s', initcap(wm.direction), lower(wm.status)),
           wm.id, bb.name, null::uuid,
           'whatsapp'
    from public.whatsapp_messages wm
    left join public.business_branches bb on bb.id = wm.branch_id
    where wm.business_id = p_business_id
  ),
  resolved as (
    select ev.occurred_at, ev.category, ev.summary, ev.reference_id, ev.branch_name,
           ae.email as actor_email, ev.source, ev.reference_id as tiebreak_id
    from events ev
    left join private.get_business_actor_emails(p_business_id) ae on ae.user_id = ev.actor_user_id
  ),
  counted as (
    select resolved.*, count(*) over () as total_count from resolved
  )
  select counted.occurred_at, counted.category, counted.summary, counted.reference_id,
         counted.branch_name, counted.actor_email, counted.total_count
  from counted
  order by counted.occurred_at desc nulls last, counted.source asc, counted.tiebreak_id asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_business_activity(uuid, integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_business_activity(uuid, integer, integer) from public, anon;
grant execute on function public.list_platform_business_activity(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 6. list_platform_business_audit — requires platform.audit.view
--    INDEPENDENTLY of platform.businesses.view (the two-permission split
--    — see this migration's own header comment). Returns bounded
--    summarized audit data; the underlying audit_events table already
--    carries no raw before/after JSON (it is a summary event ledger, not
--    a diff store — see 20260902090000_create_audit_events.sql) and this
--    RPC additionally omits its own `metadata` column from the returned
--    shape entirely, so no JSON payload of any kind reaches the client.
-- ---------------------------------------------------------------------
create or replace function public.list_platform_business_audit(
  p_business_id uuid,
  p_page        integer default 1,
  p_page_size   integer default 25
)
returns table (
  occurred_at  timestamptz,
  actor_email  text,
  action       text,
  entity_type  text,
  entity_ref   text,
  summary      text,
  total_count  bigint
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
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
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
    select ae.created_at as occurred_at,
           coalesce(actor.email, ae.actor_email_snapshot) as actor_email,
           ae.action, ae.category, ae.resource_type as entity_type,
           coalesce(ae.resource_label_snapshot, ae.resource_id::text) as entity_ref,
           format('[%s] %s (%s)', ae.category, ae.action, ae.outcome) as summary,
           ae.id as tiebreak_id
    from public.audit_events ae
    left join private.get_business_actor_emails(p_business_id) actor on actor.user_id = ae.actor_user_id
    where ae.business_id = p_business_id
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.occurred_at, counted.actor_email, counted.action, counted.entity_type,
         counted.entity_ref, counted.summary, counted.total_count
  from counted
  order by counted.occurred_at desc, counted.tiebreak_id desc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_business_audit(uuid, integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_business_audit(uuid, integer, integer) from public, anon;
grant execute on function public.list_platform_business_audit(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Index review (reasoned, not blind — per phase instructions).
--
-- audit_events already carries (business_id, created_at desc, id desc) —
-- exactly what list_platform_business_audit's own ordering needs, no new
-- index required. sales/expenses/sale_returns/invoice_payments each
-- already carry a (business_id, created_at-ish desc) index from their own
-- phases; the activity RPC UNIONs a handful of small, business-scoped,
-- already-indexed sets (bounded further by LIMIT 100) rather than a single
-- huge scan, so no new composite index is added speculatively. The one
-- genuinely new access pattern this phase introduces —
-- "whatsapp_messages FAILED within the last 7 days for one business" (the
-- overview RPC's diagnostics query) — is added below; it is scoped to a
-- single low-cardinality status value over a short recent window, so a
-- partial index keeps it cheap even as the table grows.
-- ---------------------------------------------------------------------
create index if not exists whatsapp_messages_business_failed_idx
  on public.whatsapp_messages (business_id, failed_at desc)
  where status = 'FAILED';
