-- Phase 1Q-0C hydration root-cause fix.
--
-- get_management_reporting_aggregate's sales_trend day series
-- (20260916090000_management_reporting_aggregates.sql) built its daily
-- buckets with:
--
--   generate_series(p_from::date, (p_to - interval '1 microsecond')::date, interval '1 day') d(day)
--
-- Postgres has no generate_series(date, date, interval) overload, so this
-- resolves via implicit cast to generate_series(timestamptz, timestamptz,
-- interval) — confirmed locally with pg_typeof(d.day) = 'timestamp with
-- time zone'. Two separate casts in that expression are session-TimeZone
-- dependent, not just the final ::text read out by the app:
--
--   1. p_from::date (timestamptz -> date) reads the calendar day in the
--      session's TimeZone GUC, not UTC.
--   2. date -> timestamptz (the implicit cast generate_series performs to
--      resolve the overload) reinterprets that date as midnight in the
--      session's TimeZone GUC, not UTC midnight.
--
-- Reproduced locally: under `set timezone to 'America/New_York'` the exact
-- previous expression for the fixed window [2026-08-26T00:00:00Z,
-- 2026-08-29T00:00:00Z) returned FOUR rows including a spurious
-- "2026-08-25 00:00:00-04" (an extra day, not merely a different string
-- for the same day), where a UTC session returned the correct three UTC
-- days. A prior app-layer patch (lib/reports/sales-trend-chart.ts's
-- normalizeDayKey/formatUtcDayLabel) extracted a YYYY-MM-DD prefix from
-- whatever string the RPC returned, which fixed the *formatting* of a
-- given value but could not fix an RPC call that had already computed the
-- wrong calendar day, or an extra/missing day, for a non-UTC session —
-- that is the real reason it did not fully resolve the intermittent
-- SalesTrendChart hydration mismatch on the range's oldest-day tick.
--
-- The local database's own TimeZone GUC is UTC (configuration file), so
-- this did not reproduce against the local stack directly; the drift
-- requires an actual session with a non-UTC TimeZone GUC, e.g. a pooled
-- Postgres backend whose session TimeZone was left set by a prior
-- transaction-pooled client. Whatever the trigger, the correct fix is to
-- make the day series construction immune to the session TimeZone GUC
-- entirely, not to identify why a given connection had it set.
--
-- Fix: anchor both bounds to UTC explicitly with `at time zone 'UTC'`
-- (timestamptz -> timestamp, no further TZ conversion) before truncating
-- to a plain date, then feed generate_series two explicit `timestamp`
-- values so there is no date/timestamptz overload ambiguity left to
-- resolve. Verified locally: identical
-- ["2026-08-26","2026-08-27","2026-08-28"] output under UTC,
-- America/New_York, and Asia/Kolkata sessions. UTC [from, to) semantics
-- and bucket boundaries are unchanged — this is a determinism/
-- representation fix only, matching the pattern this same function
-- already uses for completed_at on the line directly below (`(completed_at
-- at time zone 'UTC')::date`).

create or replace function public.get_management_reporting_aggregate(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_previous_from timestamptz;
  v_days integer;
  v_daily_sales jsonb;
  v_branch_performance jsonb;
  v_inventory jsonb;
  v_customer jsonb;
  v_whatsapp_follow_up_count bigint := null;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_business_id is null or p_from is null or p_to is null or p_from >= p_to then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'INVALID_REPORT_RANGE' using errcode = '22023';
  end if;
  if not private.has_permission(p_business_id, 'reports.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_previous_from := p_from - (p_to - p_from);
  v_days := greatest(1, least(366, ceil(extract(epoch from (p_to - p_from)) / 86400.0)::integer));

  -- One row per UTC day; zero-activity days are intentionally represented.
  -- Both series bounds are anchored to UTC via `at time zone 'UTC'` before
  -- truncation to `date`, then cast to plain `timestamp` so
  -- generate_series resolves unambiguously to its (timestamp, timestamp,
  -- interval) overload — never the session-TimeZone-dependent
  -- (timestamptz, timestamptz, interval) one a bare `date` argument
  -- resolves to. See this migration's header comment for the reproduced
  -- failure this replaces.
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', d.day::date::text,
    'revenue', coalesce(s.revenue, 0),
    'order_count', coalesce(s.order_count, 0),
    'average_order_value', case when coalesce(s.order_count, 0) = 0 then 0 else round(s.revenue / s.order_count, 2) end
  ) order by d.day), '[]'::jsonb)
  into v_daily_sales
  from generate_series(
    (p_from at time zone 'UTC')::date::timestamp,
    ((p_to - interval '1 microsecond') at time zone 'UTC')::date::timestamp,
    interval '1 day'
  ) d(day)
  left join (
    select (completed_at at time zone 'UTC')::date as day, sum(total) as revenue, count(*)::bigint as order_count
    from public.sales
    where business_id = p_business_id and status = 'COMPLETED' and completed_at >= p_from and completed_at < p_to
    group by 1
  ) s on s.day = d.day::date;

  -- A customer is new when their customer record was created in the period.
  -- Returning is a distinct customer with a completed current-period sale
  -- and any completed sale before p_from. Repeat counts customers with >=2
  -- completed current-period sales. Anonymous sales are excluded.
  select jsonb_build_object(
    'new_customers', (select count(*) from public.customers where business_id = p_business_id and created_at >= p_from and created_at < p_to),
    'returning_customers', (select count(*) from (
      select s.customer_id from public.sales s
      where s.business_id = p_business_id and s.status = 'COMPLETED' and s.customer_id is not null and s.completed_at >= p_from and s.completed_at < p_to
      and exists (select 1 from public.sales earlier where earlier.business_id = p_business_id and earlier.customer_id = s.customer_id and earlier.status = 'COMPLETED' and earlier.completed_at < p_from)
      group by s.customer_id
    ) x),
    'repeat_customers', (select count(*) from (
      select customer_id from public.sales where business_id = p_business_id and status = 'COMPLETED' and customer_id is not null and completed_at >= p_from and completed_at < p_to group by customer_id having count(*) >= 2
    ) x)
  ) into v_customer;

  -- Current stock is not period-based. Low stock requires an explicit
  -- threshold and 0 < quantity <= threshold; out of stock is quantity = 0.
  select jsonb_build_object(
    'low_stock_products', count(*) filter (where quantity > 0 and low_stock_threshold is not null and quantity <= low_stock_threshold),
    'out_of_stock_products', count(*) filter (where quantity = 0),
    'slow_moving_products', count(*) filter (where quantity > 0 and not sold_in_period)
  ) into v_inventory
  from (
    select p.id, p.low_stock_threshold, coalesce(sum(ib.quantity) filter (where il.status = 'active'), 0) as quantity,
      exists (select 1 from public.sales s where s.business_id = p_business_id and s.status = 'COMPLETED' and s.completed_at >= p_from and s.completed_at < p_to and s.id in (select si.sale_id from public.sale_items si where si.business_id = p_business_id and si.product_id = p.id)) as sold_in_period
    from public.products p
    left join public.inventory_balances ib on ib.business_id = p.business_id and ib.product_id = p.id
    left join public.inventory_locations il on il.id = ib.inventory_location_id and il.business_id = ib.business_id
    where p.business_id = p_business_id and p.status = 'active' and p.track_inventory = true
    group by p.id, p.low_stock_threshold
  ) inventory;

  -- Branch detail is intentionally narrower than business-wide summary:
  -- only branches for which the caller currently has trusted assignment
  -- access are emitted. No role name is inspected. Inactive branches are
  -- omitted because private.has_branch_access correctly revokes operational
  -- branch scope when a branch is deactivated.
  select coalesce(jsonb_agg(jsonb_build_object('branch_id', id, 'branch_name', name, 'revenue', revenue, 'order_count', order_count) order by name), '[]'::jsonb)
  into v_branch_performance
  from (
    select b.id, b.name, coalesce(sum(s.total), 0) as revenue, count(s.id)::bigint as order_count
    from public.business_branches b
    left join public.sales s on s.business_id = b.business_id and s.branch_id = b.id and s.status = 'COMPLETED' and s.completed_at >= p_from and s.completed_at < p_to
    where b.business_id = p_business_id and b.status = 'ACTIVE' and private.has_branch_access(p_business_id, b.id)
    group by b.id, b.name
  ) branches;

  -- "Needs follow-up" is deliberately only an observable queue state:
  -- OPEN conversation with an inbound message newer than its last outbound
  -- message (or no outbound message). No engagement/priority score exists.
  if private.has_permission(p_business_id, 'whatsapp.view') then
    select count(*) into v_whatsapp_follow_up_count
    from public.whatsapp_conversations
    where business_id = p_business_id and status = 'OPEN' and last_inbound_at is not null
      and (last_outbound_at is null or last_inbound_at > last_outbound_at);
  end if;

  return jsonb_build_object(
    'current_period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days),
    'previous_period', jsonb_build_object('from', v_previous_from, 'to', p_from, 'days', v_days),
    'sales_trend', v_daily_sales,
    'customer_summary', v_customer,
    'inventory_risk', v_inventory,
    'branch_performance', v_branch_performance,
    'whatsapp_follow_up_count', v_whatsapp_follow_up_count
  );
end;
$$;
