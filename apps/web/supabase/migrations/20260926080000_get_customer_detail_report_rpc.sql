-- Phase 1N-C3: Customer Detailed Report.
--
-- public.get_customer_detail_report gives a reports.view-only caller
-- (no customers.view, no sales.view required) per-customer historical
-- performance for a [p_from, p_to) window: total orders, revenue, average
-- order value, first/last COMPLETED purchase, and new/returning
-- classification — mirroring get_financial_summary's exact precedent
-- (supabase/migrations/20260827080600_get_financial_summary_rpc.sql,
-- 20260923090700_financial_summary_currency_from_business.sql): a
-- dedicated BYPASSRLS reader role, narrow column grants, [from,to)
-- half-open range validation, reports.view-ONLY authorization (never
-- customers.view/sales.view), business currency derived from
-- public.businesses.currency_code, and an optional p_branch_id that only
-- ever NARROWS which sales count (customers themselves are not
-- branch-scoped — see 20260826090000_create_customers.sql; no
-- has_branch_access check is added, matching get_financial_summary's own
-- "a branch filter never widens what reports.view already grants"
-- reasoning).
--
-- Historical value only, per the approved plan: no predictive LTV is
-- computed or returned.
--
-- New customer: first-ever COMPLETED sale (all time, not just the
-- selected window) falls inside [p_from, p_to).
-- Returning customer: at least one COMPLETED sale strictly before
-- p_from AND at least one COMPLETED sale inside [p_from, p_to).
-- Active customer: at least one COMPLETED sale inside [p_from, p_to).
-- DRAFT/CANCELLED sales are never counted anywhere in this function.
--
-- Sorting is allowlisted in plpgsql (revenue | orders | last_purchase |
-- name), never a raw column name or direction taken from the caller and
-- concatenated into SQL — see the v_sort_col/v_dir assignment below.
-- Pagination is bounded: p_page_size is clamped to [1, 100].
--
-- Phase 1N-C3 remediation (Codex review): the detail TABLE (tmp_customer_
-- report / v_rows / v_total_count) is scoped to customers with >= 1
-- COMPLETED sale inside [p_from, p_to) — i.e. tmp_customer_period.
-- customer_id is not null — so the table represents period activity, not
-- the full customer directory. A customer with zero period sales (even if
-- they purchased before the window) never appears in this table and is
-- never counted in total_count, so "no customer activity in this period"
-- is a reachable state and pagination can never produce a phantom page.
-- This does NOT touch v_total_customers (still every customer on the
-- business, for the "Total customers" KPI), v_active_customers/
-- v_new_customers/v_returning_customers (already period-derived, already
-- exclude zero-activity customers), the customer directory itself, or any
-- other route — it narrows only what this one detail report renders.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_reports_reader') then
    create role private_reports_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant usage on schema public to private_reports_reader;

grant select (id, business_id, name, phone, email, created_at)
  on public.customers to private_reports_reader;
grant select (business_id, customer_id, branch_id, status, total, completed_at)
  on public.sales to private_reports_reader;
grant select (id, currency_code)
  on public.businesses to private_reports_reader;

create or replace function public.get_customer_detail_report(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_branch_id   uuid default null,
  p_search      text default null,
  p_sort        text default 'revenue',
  p_direction   text default 'desc',
  p_page        integer default 1,
  p_page_size   integer default 25
)
returns jsonb
language plpgsql

security definer
set search_path = ''
as $$
declare
  v_branch_found_id   uuid;
  v_business_currency text;
  v_sort_col          text;
  v_dir               text;
  v_page              integer;
  v_page_size         integer;
  v_offset            integer;
  v_search            text;
  v_total_customers   bigint;
  v_active_customers  bigint;
  v_new_customers     bigint;
  v_returning_customers bigint;
  v_period_revenue    numeric;
  v_avg_revenue_active numeric;
  v_total_count       bigint;
  v_rows              jsonb;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_from is null or p_to is null then
    raise exception 'p_business_id, p_from, and p_to are required' using errcode = '22023';
  end if;
  if p_from >= p_to then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'reports.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_branch_id is not null then
    select id into v_branch_found_id
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_found_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

  -- Allowlist — the ONLY four values v_sort_col can ever take, never the
  -- raw p_sort text itself.
  v_sort_col := case p_sort
    when 'orders' then 'total_orders'
    when 'last_purchase' then 'last_purchase'
    when 'name' then 'name'
    else 'revenue'
  end;
  v_dir := case lower(coalesce(p_direction, 'desc')) when 'asc' then 'asc' else 'desc' end;

  v_page := greatest(coalesce(p_page, 1), 1);
  v_page_size := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_offset := (v_page - 1) * v_page_size;

  -- Bounded so a pathological search string can never blow up planning
  -- time or be used to smuggle an oversized payload through this RPC.
  v_search := nullif(left(btrim(coalesce(p_search, '')), 200), '');

  -- All-time first/last COMPLETED purchase per customer, for new/returning
  -- classification and the "last purchase" column (deliberately NOT
  -- windowed to [p_from, p_to) — answering "who hasn't purchased
  -- recently" requires the true all-time last purchase, not one clipped
  -- to the report range).
  create temporary table tmp_customer_lifetime on commit drop as
  select
    s.customer_id,
    min(s.completed_at) as first_purchase,
    max(s.completed_at) as last_purchase
  from public.sales s
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.customer_id is not null
  group by s.customer_id;

  -- Period-scoped performance (revenue, orders, AOV, active flag),
  -- optionally narrowed to one branch.
  create temporary table tmp_customer_period on commit drop as
  select
    s.customer_id,
    count(*) as total_orders,
    coalesce(sum(s.total), 0) as revenue
  from public.sales s
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.customer_id is not null
    and s.completed_at >= p_from
    and s.completed_at < p_to
    and (p_branch_id is null or s.branch_id = p_branch_id)
  group by s.customer_id;

  select count(*) into v_total_customers
  from public.customers c
  where c.business_id = p_business_id;

  select count(*) into v_active_customers from tmp_customer_period;

  select count(*) into v_new_customers
  from tmp_customer_lifetime l
  where l.first_purchase >= p_from and l.first_purchase < p_to;

  select count(*) into v_returning_customers
  from tmp_customer_lifetime l
  join tmp_customer_period p on p.customer_id = l.customer_id
  where l.first_purchase < p_from;

  select coalesce(sum(revenue), 0) into v_period_revenue from tmp_customer_period;
  v_avg_revenue_active := case when v_active_customers = 0 then 0 else v_period_revenue / v_active_customers end;

  create temporary table tmp_customer_report on commit drop as
  select
    c.id as customer_id,
    c.name,
    c.phone,
    c.email,
    coalesce(p.total_orders, 0) as total_orders,
    coalesce(p.revenue, 0) as revenue,
    case when coalesce(p.total_orders, 0) = 0 then 0 else p.revenue / p.total_orders end as average_order_value,
    l.first_purchase,
    l.last_purchase,
    (l.first_purchase is not null and l.first_purchase >= p_from and l.first_purchase < p_to) as is_new,
    (l.first_purchase is not null and l.first_purchase < p_from and p.customer_id is not null) as is_returning
  from public.customers c
  join tmp_customer_period p on p.customer_id = c.id
  left join tmp_customer_lifetime l on l.customer_id = c.id
  where c.business_id = p_business_id
    and (
      v_search is null
      or c.name ilike '%' || v_search || '%'
      or c.phone ilike '%' || v_search || '%'
      or c.email ilike '%' || v_search || '%'
    );

  select count(*) into v_total_count from tmp_customer_report;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from ' ||
    '(select * from tmp_customer_report order by %I %s nulls last, customer_id asc limit %L offset %L) t',
    v_sort_col, v_dir, v_page_size, v_offset
  ) into v_rows;

  return jsonb_build_object(
    'currency_code', v_business_currency,
    'kpis', jsonb_build_object(
      'total_customers', v_total_customers,
      'active_customers', v_active_customers,
      'new_customers', v_new_customers,
      'returning_customers', v_returning_customers,
      'revenue', v_period_revenue,
      'average_revenue_per_active_customer', v_avg_revenue_active
    ),
    'rows', v_rows,
    'total_count', v_total_count,
    'page', v_page,
    'page_size', v_page_size
  );
end;
$$;

grant create on schema public to private_reports_reader;
alter function public.get_customer_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  owner to private_reports_reader;
revoke create on schema public from private_reports_reader;

revoke all on function public.get_customer_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  from public, anon, service_role;
grant execute on function public.get_customer_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  to authenticated;
