-- Phase 1N: read-only management reporting contract.
--
-- This function deliberately returns one bounded JSON aggregate rather than
-- dashboard callers querying sales, customers, inventory, branches, or
-- WhatsApp rows. It is authorized by reports.view, then applies an
-- additional whatsapp.view check before exposing the optional follow-up
-- count. All periods are [from, to) UTC instants; the previous comparison
-- period is the immediately preceding equal-duration interval.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_management_reports_reader') then
    create role private_management_reports_reader noinherit nologin bypassrls;
  end if;
end
$$;

grant private_management_reports_reader to postgres;
grant usage on schema public, private to private_management_reports_reader;
grant select (id, business_id, customer_id, branch_id, status, total, completed_at) on public.sales to private_management_reports_reader;
grant select (business_id, sale_id, product_id) on public.sale_items to private_management_reports_reader;
grant select (id, business_id, created_at) on public.customers to private_management_reports_reader;
grant select (id, business_id, track_inventory, low_stock_threshold, status) on public.products to private_management_reports_reader;
grant select (business_id, product_id, inventory_location_id, quantity) on public.inventory_balances to private_management_reports_reader;
grant select (id, business_id, branch_id, status) on public.inventory_locations to private_management_reports_reader;
grant select (id, business_id, name, status) on public.business_branches to private_management_reports_reader;
grant select (business_id, branch_id, status, last_inbound_at, last_outbound_at) on public.whatsapp_conversations to private_management_reports_reader;
grant execute on function private.current_uid() to private_management_reports_reader;
grant execute on function private.has_permission(uuid, text) to private_management_reports_reader;
grant execute on function private.has_branch_access(uuid, uuid) to private_management_reports_reader;

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
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', d.day::text,
    'revenue', coalesce(s.revenue, 0),
    'order_count', coalesce(s.order_count, 0),
    'average_order_value', case when coalesce(s.order_count, 0) = 0 then 0 else round(s.revenue / s.order_count, 2) end
  ) order by d.day), '[]'::jsonb)
  into v_daily_sales
  from generate_series(p_from::date, (p_to - interval '1 microsecond')::date, interval '1 day') d(day)
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

grant create on schema public to private_management_reports_reader;
alter function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz) owner to private_management_reports_reader;
revoke create on schema public from private_management_reports_reader;
revoke all on function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz) from public, anon, service_role;
grant execute on function public.get_management_reporting_aggregate(uuid, timestamptz, timestamptz) to authenticated;
