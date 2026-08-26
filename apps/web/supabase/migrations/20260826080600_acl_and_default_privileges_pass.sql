-- Phase 1C: final ACL confirmation pass + cost-visibility accessor functions.
--
-- service_role bypasses RLS entirely (see create_businesses.sql) — GRANT
-- is not a second layer behind RLS for that role, it is the entire
-- boundary. This migration re-states, explicitly, the intended grant for
-- every Phase 1C table rather than relying on whatever Supabase's Data
-- API default-privilege configuration happens to be for a fresh table
-- (config.toml's auto_expose_new_tables note: recent Supabase projects do
-- not auto-expose new entities, but this migration does not depend on
-- that default holding — it states the grants directly).

revoke all on public.products, public.inventory_locations,
              public.inventory_ledger, public.inventory_balances
  from public, anon, authenticated, service_role;

grant select (
  id, business_id, name, description, sku, barcode, category, unit,
  selling_price, currency_code, track_inventory, low_stock_threshold,
  status, created_by, created_at, updated_at
) on public.products to authenticated, service_role;

grant update (
  name, description, sku, barcode, category, unit, cost_price,
  selling_price, currency_code, low_stock_threshold, status
) on public.products to authenticated;

grant select on public.inventory_locations to authenticated, service_role;

grant select (
  id, business_id, inventory_location_id, product_id, movement_type,
  quantity_delta, balance_after, reference_type, reference_id,
  reason, note, created_by, created_at
) on public.inventory_ledger to authenticated, service_role;

grant select on public.inventory_balances to authenticated, service_role;

-- Least-privilege pass, mirroring revoke_unnecessary_default_privileges.sql
-- exactly, extended to the four new tables.
revoke references, trigger, truncate
  on public.products, public.inventory_locations,
     public.inventory_ledger, public.inventory_balances
  from anon, authenticated;

-- Cost-visibility accessor functions -------------------------------------
--
-- cost_price/unit_cost are excluded from the column grants above — no
-- authenticated session, at any permission level, can read them via a
-- plain `.from()` call, `select("*")` included (Postgres denies the whole
-- query, not just the column, when a role lacks privilege on any column
-- referenced). These two functions are the only read path, each
-- internally checking inventory.view_cost per call.
--
-- RETURNS JSONB, not numeric: `supabase gen types` maps a nullable SQL
-- function's numeric return to a non-nullable TypeScript `number`
-- (confirmed against the installed CLI's actual output — a `returns
-- numeric` function that can return SQL NULL was generated as
-- `Returns: number`, which is a lie the type system would happily let
-- calling code trust). A `returns jsonb` function maps to the app's own
-- `Json` type, whose definition already includes `| null` — so a
-- genuinely-nullable result is represented truthfully, not patched by
-- hand-editing the generated file. The function still returns actual SQL
-- NULL for "no result" (not a wrapped JSON null) and to_jsonb() of the
-- real numeric value on success, which arrives client-side as a plain
-- JSON number.
--
-- Non-disclosure: a nonexistent id and a foreign-tenant id (one that
-- exists but belongs to a business the caller is not an active member of)
-- must be indistinguishable to the caller. The tenant-visibility gate
-- (private.is_business_member) runs FIRST and returns the identical
-- result (null) for both cases; only once the caller is confirmed to be
-- an active member of the resolved business does the function proceed to
-- the finer-grained inventory.view_cost check, which DOES distinguish
-- (42501 vs. the real value) — that distinction is safe at that point
-- because the caller already legitimately knows the product/business
-- exists.
create or replace function public.get_product_cost(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_cost        numeric(14,2);
begin
  select business_id, cost_price into v_business_id, v_cost
  from public.products
  where id = p_product_id;

  if v_business_id is null or not private.is_business_member(v_business_id) then
    return null;
  end if;

  if not private.has_permission(v_business_id, 'inventory.view_cost') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  return to_jsonb(v_cost);
end;
$$;

revoke all on function public.get_product_cost(uuid) from public, anon;
grant execute on function public.get_product_cost(uuid) to authenticated;
grant execute on function private.is_business_member(uuid) to postgres;
grant execute on function private.has_permission(uuid, text) to postgres;

create or replace function public.get_movement_unit_cost(p_ledger_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_cost        numeric(14,2);
begin
  select business_id, unit_cost into v_business_id, v_cost
  from public.inventory_ledger
  where id = p_ledger_id;

  if v_business_id is null or not private.is_business_member(v_business_id) then
    return null;
  end if;

  if not private.has_permission(v_business_id, 'inventory.view_cost') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  return to_jsonb(v_cost);
end;
$$;

revoke all on function public.get_movement_unit_cost(uuid) from public, anon;
grant execute on function public.get_movement_unit_cost(uuid) to authenticated;
