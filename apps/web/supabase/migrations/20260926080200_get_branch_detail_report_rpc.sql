-- Phase 1N-C4: Branch Detailed Report.
--
-- public.get_branch_detail_report gives a reports.view-only caller (no
-- branches.view required) a comparative, per-branch performance table plus
-- an optional single-branch drilldown for a [p_from, p_to) window — same
-- precedent as get_customer_detail_report/get_inventory_detail_report: the
-- dedicated BYPASSRLS private_reports_reader role, narrow column grants,
-- [from,to) half-open range validation, reports.view-ONLY authorization,
-- business currency derived from public.businesses.currency_code.
--
-- Authorization decision (documented, not merely assumed): unlike
-- components/dashboard/branch-performance.tsx's own dashboard widget
-- (Phase 1N-B4), which additionally narrows to private.has_branch_access
-- per branch, this report applies NO has_branch_access check anywhere.
-- reports.view is a broad, business-wide financial-oversight permission —
-- get_financial_summary, get_customer_detail_report, and
-- get_inventory_detail_report all already treat an optional p_branch_id as
-- a pure NARROWING filter under reports.view alone, never widened or
-- restricted by the caller's own operational branch assignment. This
-- report is scoped exactly the same way as those three, and as
-- lib/branches/dal.ts's own listReportBranchOptions ("reports" scope:
-- business-wide, includes INACTIVE branches for historical drilldown).
-- The dashboard widget's has_branch_access narrowing is that ONE widget's
-- own deliberate choice (a narrower "your assigned branches" summary), not
-- the general reports.view convention — reusing it here would be inventing
-- a NEW restriction reports.view has never had anywhere else in this
-- codebase, which the approved plan explicitly warns against.
--
-- Row membership (documented decision): the comparison TABLE lists every
-- ACTIVE business_branches row for the business, with zero-activity
-- branches explicit (coalesce to 0, never omitted) — mirroring
-- branch-performance.tsx's own "all ACTIVE branches, left join, coalesce"
-- shape exactly, just without its has_branch_access narrowing (see above).
-- INACTIVE branches are omitted from the comparison table (consistent with
-- the widget) but remain selectable for p_branch_id drilldown — a
-- since-deactivated branch's own selected-branch history must stay
-- reachable, exactly like get_customer_detail_report's own branch-filter
-- treatment.
--
-- Active Branch (KPI + row status, not a table filter): a branch with
-- >= 1 COMPLETED sale inside [p_from, p_to). Never derived from branch
-- creation/login metadata.
--
-- Active customers (KPI): distinct customers with >= 1 COMPLETED sale at
-- ANY reported branch in the period — counted ONCE even if they purchased
-- at multiple branches, so this KPI is never the naive sum of each row's
-- own per-branch active-customer count (which double-counts a
-- multi-branch customer). Each row's own active_customers column IS
-- scoped to that one branch, by design.
--
-- Units sold: sum of sale_items.quantity for COMPLETED sales at the branch
-- in the period. Gross, matching get_inventory_detail_report's own
-- treatment — no net-of-returns computation exists anywhere in this repo's
-- frozen reporting layer yet.
--
-- Inventory movements: count of inventory_ledger rows whose location
-- belongs to the branch, created in the period. This is raw ledger event
-- volume, never "units sold" and never inventory valuation.
--
-- Expense total: sum of POSTED (never VOIDED) expenses.amount whose OWN
-- branch_id (never a creator/user inference) equals the branch, incurred
-- in the period. Company-wide (NULL branch_id) expenses are correctly
-- excluded from every branch's own total.
--
-- No profit/margin/ROI/forecast/score/health metric is computed anywhere
-- in this function, per the approved plan.
--
-- Selected-branch drilldown (p_branch_id given): adds one extra object —
-- the same six headline numbers as that branch's own table row, a daily
-- revenue trend (UTC day-series, zero-activity days explicit, mirroring
-- get_management_reporting_aggregate's own generate_series pattern
-- exactly — see 20260916090000_management_reporting_aggregates.sql), and
-- up to 10 top products by units sold (COMPLETED sale_items only, no
-- revenue-by-product to avoid price/refund ambiguity, per the approved
-- plan).
--
-- Sorting is allowlisted in plpgsql (name | revenue | sales_count |
-- average_order_value | active_customers | units_sold | last_sale), never
-- a raw column name/direction taken from the caller. Pagination is
-- bounded: p_page_size clamped to [1, 100]. Search matches branch name or
-- code (both already user-facing columns per lib/branches/dal.ts).

grant select (name, code, status) on public.business_branches to private_reports_reader;
grant select (business_id, branch_id, amount, status, incurred_at) on public.expenses to private_reports_reader;

create or replace function public.get_branch_detail_report(
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
  v_branch_found_id      uuid;
  v_business_currency    text;
  v_sort_col             text;
  v_dir                  text;
  v_page                 integer;
  v_page_size            integer;
  v_offset               integer;
  v_search               text;
  v_total_branches       bigint;
  v_active_branches      bigint;
  v_completed_sales      bigint;
  v_revenue              numeric;
  v_avg_order_value      numeric;
  v_units_sold           numeric;
  v_active_customers     bigint;
  v_expense_total        numeric;
  v_total_count          bigint;
  v_rows                 jsonb;
  v_selected             jsonb;
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

  -- Same-business validation for the selected-branch drilldown — a branch
  -- id from another business (or a nonexistent one) is rejected outright,
  -- never silently ignored. INACTIVE branches ARE a valid selection here
  -- (see this function's own header comment).
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

  -- Allowlist — the ONLY seven values v_sort_col can ever take.
  v_sort_col := case p_sort
    when 'name' then 'name'
    when 'sales_count' then 'completed_sales'
    when 'average_order_value' then 'average_order_value'
    when 'active_customers' then 'active_customers'
    when 'units_sold' then 'units_sold'
    when 'last_sale' then 'last_sale'
    else 'revenue'
  end;
  v_dir := case lower(coalesce(p_direction, 'desc')) when 'asc' then 'asc' else 'desc' end;

  v_page := greatest(coalesce(p_page, 1), 1);
  v_page_size := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_offset := (v_page - 1) * v_page_size;

  v_search := nullif(left(btrim(coalesce(p_search, '')), 200), '');

  -- Period completed-sale performance per ACTIVE branch.
  create temporary table tmp_branch_sales on commit drop as
  select
    s.branch_id,
    count(*) as completed_sales,
    coalesce(sum(s.total), 0) as revenue,
    count(distinct s.customer_id) as active_customers,
    max(s.completed_at) as last_sale_in_period
  from public.sales s
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.branch_id is not null
    and s.completed_at >= p_from
    and s.completed_at < p_to
  group by s.branch_id;

  -- All-time last COMPLETED sale per branch (never windowed — "how
  -- recently has this branch had activity at all" needs the true all-time
  -- value, matching get_customer_detail_report's identical last_purchase
  -- treatment).
  create temporary table tmp_branch_last_sale on commit drop as
  select s.branch_id, max(s.completed_at) as last_sale
  from public.sales s
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.branch_id is not null
  group by s.branch_id;

  -- Units sold per branch in the period (COMPLETED sale_items only).
  create temporary table tmp_branch_units on commit drop as
  select s.branch_id, coalesce(sum(si.quantity), 0) as units_sold
  from public.sale_items si
  join public.sales s
    on s.id = si.sale_id and s.business_id = p_business_id
  where si.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.branch_id is not null
    and s.completed_at >= p_from
    and s.completed_at < p_to
  group by s.branch_id;

  -- Inventory ledger event volume per branch in the period.
  create temporary table tmp_branch_movements on commit drop as
  select loc.branch_id, count(*) as movement_count
  from public.inventory_ledger l
  join public.inventory_locations loc
    on loc.id = l.inventory_location_id and loc.business_id = p_business_id
  where l.business_id = p_business_id
    and loc.branch_id is not null
    and l.created_at >= p_from
    and l.created_at < p_to
  group by loc.branch_id;

  -- POSTED expense total per branch in the period. Company-wide
  -- (branch_id is null) expenses are excluded from every branch's total by
  -- construction (the join key itself is branch_id).
  create temporary table tmp_branch_expenses on commit drop as
  select e.branch_id, coalesce(sum(e.amount), 0) as expense_total
  from public.expenses e
  where e.business_id = p_business_id
    and e.status = 'POSTED'
    and e.branch_id is not null
    and e.incurred_at >= p_from
    and e.incurred_at < p_to
  group by e.branch_id;

  create temporary table tmp_branch_report on commit drop as
  select
    b.id as branch_id,
    b.name,
    b.code,
    coalesce(bs.completed_sales, 0) as completed_sales,
    coalesce(bs.revenue, 0) as revenue,
    case when coalesce(bs.completed_sales, 0) = 0 then 0 else bs.revenue / bs.completed_sales end as average_order_value,
    coalesce(bs.active_customers, 0) as active_customers,
    coalesce(bu.units_sold, 0) as units_sold,
    coalesce(bm.movement_count, 0) as movement_count,
    coalesce(be.expense_total, 0) as expense_total,
    bl.last_sale,
    (coalesce(bs.completed_sales, 0) > 0) as is_active_in_period
  from public.business_branches b
  left join tmp_branch_sales bs on bs.branch_id = b.id
  left join tmp_branch_last_sale bl on bl.branch_id = b.id
  left join tmp_branch_units bu on bu.branch_id = b.id
  left join tmp_branch_movements bm on bm.branch_id = b.id
  left join tmp_branch_expenses be on be.branch_id = b.id
  where b.business_id = p_business_id
    and b.status = 'ACTIVE'
    and (
      v_search is null
      or b.name ilike '%' || v_search || '%'
      or b.code ilike '%' || v_search || '%'
    );

  select count(*) into v_total_branches from tmp_branch_report;
  select count(*) filter (where is_active_in_period) into v_active_branches from tmp_branch_report;
  select coalesce(sum(completed_sales), 0) into v_completed_sales from tmp_branch_report;
  select coalesce(sum(revenue), 0) into v_revenue from tmp_branch_report;
  select coalesce(sum(units_sold), 0) into v_units_sold from tmp_branch_report;
  select coalesce(sum(expense_total), 0) into v_expense_total from tmp_branch_report;
  v_avg_order_value := case when v_completed_sales = 0 then 0 else v_revenue / v_completed_sales end;

  -- Distinct-customer KPI, counted once per customer across ALL reported
  -- branches — deliberately NOT sum(active_customers) from the per-branch
  -- table above, which would double-count a customer active at more than
  -- one branch (see this function's own header comment).
  select count(distinct s.customer_id) into v_active_customers
  from public.sales s
  join public.business_branches b on b.id = s.branch_id and b.business_id = p_business_id
  where s.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.branch_id is not null
    and s.customer_id is not null
    and b.status = 'ACTIVE'
    and s.completed_at >= p_from
    and s.completed_at < p_to;

  select count(*) into v_total_count from tmp_branch_report;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from ' ||
    '(select * from tmp_branch_report order by %I %s nulls last, branch_id asc limit %L offset %L) t',
    v_sort_col, v_dir, v_page_size, v_offset
  ) into v_rows;

  -- Optional single-branch drilldown. Deliberately allowed for an
  -- INACTIVE branch too (see this function's own header comment) — so it
  -- is computed independently of tmp_branch_report, which is ACTIVE-only.
  v_selected := null;
  if p_branch_id is not null then
    declare
      v_sel_name             text;
      v_sel_code             text;
      v_sel_completed_sales  bigint;
      v_sel_revenue          numeric;
      v_sel_active_customers bigint;
      v_sel_units_sold       numeric;
      v_sel_last_sale        timestamptz;
      v_sel_trend            jsonb;
      v_sel_top_products     jsonb;
    begin
      select name, code into v_sel_name, v_sel_code
      from public.business_branches
      where id = p_branch_id and business_id = p_business_id;

      select count(*), coalesce(sum(s.total), 0), count(distinct s.customer_id)
      into v_sel_completed_sales, v_sel_revenue, v_sel_active_customers
      from public.sales s
      where s.business_id = p_business_id
        and s.branch_id = p_branch_id
        and s.status = 'COMPLETED'
        and s.completed_at >= p_from
        and s.completed_at < p_to;

      select coalesce(sum(si.quantity), 0) into v_sel_units_sold
      from public.sale_items si
      join public.sales s on s.id = si.sale_id and s.business_id = p_business_id
      where si.business_id = p_business_id
        and s.branch_id = p_branch_id
        and s.status = 'COMPLETED'
        and s.completed_at >= p_from
        and s.completed_at < p_to;

      select max(s.completed_at) into v_sel_last_sale
      from public.sales s
      where s.business_id = p_business_id
        and s.branch_id = p_branch_id
        and s.status = 'COMPLETED';

      -- UTC day-series revenue trend, zero-activity days explicit — both
      -- series bounds anchored to UTC via `at time zone 'UTC'` before
      -- truncation to `date`, then cast to plain `timestamp`, exactly like
      -- 20260924090000_management_reporting_utc_day_series_fix.sql's own
      -- fix. A bare `date` bound resolves generate_series to its
      -- session-TimeZone-dependent (timestamptz, timestamptz, interval)
      -- overload, not the intended UTC-anchored one — see that migration's
      -- own header comment for the reproduced failure this avoids
      -- repeating here.
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day::date::text,
        'revenue', coalesce(rev.revenue, 0)
      ) order by d.day), '[]'::jsonb)
      into v_sel_trend
      from generate_series(
        (p_from at time zone 'UTC')::date::timestamp,
        ((p_to - interval '1 microsecond') at time zone 'UTC')::date::timestamp,
        interval '1 day'
      ) d(day)
      left join (
        select (s.completed_at at time zone 'UTC')::date as day, sum(s.total) as revenue
        from public.sales s
        where s.business_id = p_business_id
          and s.branch_id = p_branch_id
          and s.status = 'COMPLETED'
          and s.completed_at >= p_from
          and s.completed_at < p_to
        group by 1
      ) rev on rev.day = d.day::date;

      -- Top 10 products by units sold at this branch in the period. No
      -- revenue-by-product (price/refund ambiguity), per the approved plan.
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', product_id,
        'name', name,
        'units_sold', units_sold
      ) order by units_sold desc), '[]'::jsonb)
      into v_sel_top_products
      from (
        select p.id as product_id, p.name, sum(si.quantity) as units_sold
        from public.sale_items si
        join public.sales s on s.id = si.sale_id and s.business_id = p_business_id
        join public.products p on p.id = si.product_id and p.business_id = p_business_id
        where si.business_id = p_business_id
          and s.branch_id = p_branch_id
          and s.status = 'COMPLETED'
          and s.completed_at >= p_from
          and s.completed_at < p_to
        group by p.id, p.name
        order by sum(si.quantity) desc
        limit 10
      ) top;

      v_selected := jsonb_build_object(
        'branch_id', p_branch_id,
        'name', v_sel_name,
        'code', v_sel_code,
        'completed_sales', v_sel_completed_sales,
        'revenue', v_sel_revenue,
        'average_order_value', case when v_sel_completed_sales = 0 then 0 else v_sel_revenue / v_sel_completed_sales end,
        'active_customers', v_sel_active_customers,
        'units_sold', v_sel_units_sold,
        'last_sale', v_sel_last_sale,
        'trend', v_sel_trend,
        'top_products', v_sel_top_products
      );
    end;
  end if;

  return jsonb_build_object(
    'currency_code', v_business_currency,
    'kpis', jsonb_build_object(
      'total_branches', v_total_branches,
      'active_branches', v_active_branches,
      'completed_sales', v_completed_sales,
      'revenue', v_revenue,
      'average_order_value', v_avg_order_value,
      'units_sold', v_units_sold,
      'active_customers', v_active_customers,
      'expense_total', v_expense_total
    ),
    'rows', v_rows,
    'total_count', v_total_count,
    'page', v_page,
    'page_size', v_page_size,
    'selected_branch', v_selected
  );
end;
$$;

grant create on schema public to private_reports_reader;
alter function public.get_branch_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  owner to private_reports_reader;
revoke create on schema public from private_reports_reader;

revoke all on function public.get_branch_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  from public, anon, service_role;
grant execute on function public.get_branch_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  to authenticated;
