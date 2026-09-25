-- Phase 1N-C3: Inventory Detailed Report.
--
-- public.get_inventory_detail_report gives a reports.view-only caller
-- (no inventory.view, no products.view required) per-product stock
-- position plus period movement/sales detail for a [p_from, p_to) window —
-- same precedent as get_customer_detail_report and get_financial_summary:
-- a dedicated BYPASSRLS reader role, narrow column grants, [from,to)
-- half-open range validation, reports.view-ONLY authorization, business
-- currency derived from public.businesses.currency_code, and an optional
-- p_branch_id that narrows which inventory_locations/sales count (never
-- widens what reports.view already grants; no has_branch_access check).
--
-- Only tracked, active products (products.track_inventory = true,
-- products.status = 'active') are reported — matching
-- lib/inventory/dal.ts's getInventoryOverview's own filter.
--
-- Stock status:
--   Out of Stock — current quantity <= 0.
--   Low Stock     — products.low_stock_threshold is not null and
--                    0 < quantity <= low_stock_threshold. A product with
--                    no configured threshold is NEVER classified low
--                    stock from a magic number (per the approved plan,
--                    §16 — no manufactured threshold).
--   In Stock      — everything else.
--
-- No inventory valuation (cost * quantity) is computed anywhere in this
-- function — deferred, per the approved plan §13.
--
-- Sorting is allowlisted in plpgsql (units_sold | quantity | movements |
-- name), never a raw column name/direction taken from the caller.
-- Pagination is bounded: p_page_size clamped to [1, 100].

grant select (id, business_id, name, sku, track_inventory, low_stock_threshold, status, currency_code)
  on public.products to private_reports_reader;
grant select (business_id, product_id, inventory_location_id, quantity)
  on public.inventory_balances to private_reports_reader;
grant select (business_id, inventory_location_id, product_id, created_at, movement_type)
  on public.inventory_ledger to private_reports_reader;
grant select (id, business_id, branch_id, status)
  on public.inventory_locations to private_reports_reader;
grant select (business_id, sale_id, product_id, quantity)
  on public.sale_items to private_reports_reader;
-- id is additive to the (business_id, customer_id, branch_id, status,
-- total, completed_at) grant the customer-report migration already gave
-- this role — needed here too, for the sale_items -> sales join below.
grant select (id)
  on public.sales to private_reports_reader;

create or replace function public.get_inventory_detail_report(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_branch_id   uuid default null,
  p_search      text default null,
  p_sort        text default 'units_sold',
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
  v_total_products    bigint;
  v_in_stock          bigint;
  v_low_stock         bigint;
  v_out_of_stock      bigint;
  v_units_sold        numeric;
  v_movement_count    bigint;
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

  v_sort_col := case p_sort
    when 'quantity' then 'current_quantity'
    when 'movements' then 'movement_count'
    when 'name' then 'name'
    else 'units_sold'
  end;
  v_dir := case lower(coalesce(p_direction, 'desc')) when 'asc' then 'asc' else 'desc' end;

  v_page := greatest(coalesce(p_page, 1), 1);
  v_page_size := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_offset := (v_page - 1) * v_page_size;

  v_search := nullif(left(btrim(coalesce(p_search, '')), 200), '');

  -- Current on-hand quantity per product, restricted to ACTIVE locations
  -- in-scope for the branch filter (or every active location when no
  -- branch is given) — mirrors getInventoryOverview's own summation.
  create temporary table tmp_product_quantity on commit drop as
  select b.product_id, coalesce(sum(b.quantity), 0) as current_quantity
  from public.inventory_balances b
  join public.inventory_locations loc
    on loc.id = b.inventory_location_id and loc.business_id = p_business_id
  where b.business_id = p_business_id
    and loc.status = 'active'
    and (p_branch_id is null or loc.branch_id = p_branch_id)
  group by b.product_id;

  -- Units sold in the period, from COMPLETED sales only, optionally
  -- narrowed to one branch.
  create temporary table tmp_product_units_sold on commit drop as
  select si.product_id, coalesce(sum(si.quantity), 0) as units_sold
  from public.sale_items si
  join public.sales s
    on s.id = si.sale_id and s.business_id = p_business_id
  where si.business_id = p_business_id
    and s.status = 'COMPLETED'
    and s.completed_at >= p_from
    and s.completed_at < p_to
    and (p_branch_id is null or s.branch_id = p_branch_id)
  group by si.product_id;

  -- Movement count/last movement in the period, restricted the same way
  -- as current quantity above.
  create temporary table tmp_product_movements on commit drop as
  select l.product_id, count(*) as movement_count, max(l.created_at) as last_movement
  from public.inventory_ledger l
  join public.inventory_locations loc
    on loc.id = l.inventory_location_id and loc.business_id = p_business_id
  where l.business_id = p_business_id
    and l.created_at >= p_from
    and l.created_at < p_to
    and (p_branch_id is null or loc.branch_id = p_branch_id)
  group by l.product_id;

  create temporary table tmp_inventory_report on commit drop as
  select
    p.id as product_id,
    p.name,
    p.sku,
    coalesce(q.current_quantity, 0) as current_quantity,
    coalesce(u.units_sold, 0) as units_sold,
    coalesce(m.movement_count, 0) as movement_count,
    m.last_movement,
    case
      when coalesce(q.current_quantity, 0) <= 0 then 'out_of_stock'
      when p.low_stock_threshold is not null and coalesce(q.current_quantity, 0) <= p.low_stock_threshold then 'low_stock'
      else 'in_stock'
    end as stock_status
  from public.products p
  left join tmp_product_quantity q on q.product_id = p.id
  left join tmp_product_units_sold u on u.product_id = p.id
  left join tmp_product_movements m on m.product_id = p.id
  where p.business_id = p_business_id
    and p.status = 'active'
    and p.track_inventory = true
    and (
      v_search is null
      or p.name ilike '%' || v_search || '%'
      or p.sku ilike '%' || v_search || '%'
    );

  select count(*) into v_total_products from tmp_inventory_report;
  select count(*) filter (where stock_status = 'in_stock') into v_in_stock from tmp_inventory_report;
  select count(*) filter (where stock_status = 'low_stock') into v_low_stock from tmp_inventory_report;
  select count(*) filter (where stock_status = 'out_of_stock') into v_out_of_stock from tmp_inventory_report;
  select coalesce(sum(units_sold), 0) into v_units_sold from tmp_inventory_report;
  select coalesce(sum(movement_count), 0) into v_movement_count from tmp_inventory_report;

  select count(*) into v_total_count from tmp_inventory_report;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from ' ||
    '(select * from tmp_inventory_report order by %I %s nulls last, product_id asc limit %L offset %L) t',
    v_sort_col, v_dir, v_page_size, v_offset
  ) into v_rows;

  return jsonb_build_object(
    'currency_code', v_business_currency,
    'kpis', jsonb_build_object(
      'total_products', v_total_products,
      'in_stock', v_in_stock,
      'low_stock', v_low_stock,
      'out_of_stock', v_out_of_stock,
      'units_sold', v_units_sold,
      'movements', v_movement_count
    ),
    'rows', v_rows,
    'total_count', v_total_count,
    'page', v_page,
    'page_size', v_page_size
  );
end;
$$;

grant create on schema public to private_reports_reader;
alter function public.get_inventory_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  owner to private_reports_reader;
revoke create on schema public from private_reports_reader;

revoke all on function public.get_inventory_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  from public, anon, service_role;
grant execute on function public.get_inventory_detail_report(uuid, timestamptz, timestamptz, uuid, text, text, text, integer, integer)
  to authenticated;
