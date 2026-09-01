-- Phase 1I: additive extension of the inventory-mutation boundary to
-- support return-driven restocking.
--
-- Does NOT edit any committed Phase 1C/1D migration file — mirrors
-- 20260826090200_extend_inventory_movement_for_sale.sql's own exact
-- technique: widen two CHECK constraints (one new enum value each) and
-- CREATE OR REPLACE private.apply_inventory_movement with the IDENTICAL
-- signature, extending its sign-derivation to treat 'SALE_RETURN' exactly
-- like 'OPENING_STOCK'/'ADJUSTMENT_IN' (always a POSITIVE quantity_delta —
-- a return restock can only ever ADD stock back, never remove it; a
-- restock=false return line never calls this function at all — see
-- create_sale_return's own header comment). Every existing caller and
-- every existing movement_type/reference_type value is unaffected — the
-- full pre-existing inventory adversarial suite is rerun against this
-- replacement before any return-specific test is trusted.
--
-- Exact constraint names confirmed by direct live inspection of
-- pg_constraint on this schema, not guessed (mirrors the Phase 1D
-- extension's own identical verification discipline).

alter table public.inventory_ledger
  drop constraint inventory_ledger_movement_type_check;
alter table public.inventory_ledger
  add constraint inventory_ledger_movement_type_check
  check (movement_type in ('OPENING_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'SALE', 'SALE_RETURN'));

alter table public.inventory_ledger
  drop constraint inventory_ledger_reference_type_check;
alter table public.inventory_ledger
  add constraint inventory_ledger_reference_type_check
  check (reference_type is null or reference_type in ('manual', 'sale', 'sale_return'));

-- The direction-vs-sign invariant, widened: SALE_RETURN behaves exactly
-- like OPENING_STOCK/ADJUSTMENT_IN (quantity_delta must be positive) —
-- restocking is always a stock INCREASE, matching every other IN-class
-- movement in this system.
alter table public.inventory_ledger
  drop constraint inventory_ledger_check;
alter table public.inventory_ledger
  add constraint inventory_ledger_check
  check (
    (movement_type in ('OPENING_STOCK', 'ADJUSTMENT_IN', 'SALE_RETURN') and quantity_delta > 0)
    or (movement_type in ('ADJUSTMENT_OUT', 'SALE') and quantity_delta < 0)
  );

create or replace function private.apply_inventory_movement(
  p_business_id           uuid,
  p_product_id            uuid,
  p_inventory_location_id uuid,
  p_movement_type         text,
  p_quantity              numeric,
  p_unit_cost             numeric,
  p_reference_type        text,
  p_reference_id          uuid,
  p_reason                text,
  p_note                  text,
  p_idempotency_key       uuid,
  p_actor                 uuid
)
returns public.inventory_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason          text;
  v_note            text;
  v_reference_type  text;
  v_signed_delta    numeric(14,3);
  v_existing        public.inventory_ledger;
  v_product_status  text;
  v_track_inventory boolean;
  v_location_status text;
  v_current_qty     numeric(14,3);
  v_new_qty         numeric(14,3);
  v_ledger          public.inventory_ledger;
  v_constraint      text;
begin
  if p_business_id is null or p_product_id is null or p_inventory_location_id is null
     or p_movement_type is null or p_quantity is null or p_reason is null
     or p_idempotency_key is null or p_actor is null then
    raise exception 'missing required parameter' using errcode = '22023';
  end if;

  -- Only change from the previous version: 'SALE_RETURN' is now a
  -- recognized movement_type.
  if p_movement_type not in ('OPENING_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'SALE', 'SALE_RETURN') then
    raise exception 'invalid movement_type' using errcode = '22023';
  end if;

  -- Positive quantity always required; direction is derived below, never
  -- accepted signed from the caller.
  if p_quantity <= 0 then
    raise exception 'quantity must be positive' using errcode = '22023';
  end if;

  -- Normalize before both persistence and comparison, so a retry with
  -- incidental whitespace differences still matches what's already
  -- stored, and the stored row is itself in canonical form.
  v_reason := btrim(p_reason);
  if length(v_reason) < 3 then
    raise exception 'reason is too short' using errcode = '22023';
  end if;
  v_note := nullif(btrim(p_note), '');
  v_reference_type := nullif(btrim(p_reference_type), '');

  -- Only change from the previous version: 'SALE_RETURN' derives a
  -- POSITIVE delta, exactly like 'OPENING_STOCK'/'ADJUSTMENT_IN'.
  if p_movement_type in ('ADJUSTMENT_OUT', 'SALE') then
    v_signed_delta := -p_quantity;
  else
    v_signed_delta := p_quantity;
  end if;

  -- Idempotency lookup, before any lock is acquired, so a duplicate
  -- replay is cheap. Null-safe comparison (IS NOT DISTINCT FROM) on every
  -- nullable field.
  select * into v_existing
  from public.inventory_ledger
  where business_id = p_business_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.product_id = p_product_id
       and v_existing.inventory_location_id = p_inventory_location_id
       and v_existing.movement_type = p_movement_type
       and v_existing.quantity_delta = v_signed_delta
       and v_existing.unit_cost is not distinct from p_unit_cost
       and v_existing.reference_type is not distinct from v_reference_type
       and v_existing.reference_id is not distinct from p_reference_id
       and v_existing.reason = v_reason
       and v_existing.note is not distinct from v_note
    then
      return v_existing;
    else
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;
  end if;

  -- Fixed lock order for this subsystem: product -> location -> balance.
  -- Every function touching more than one of these rows in the same
  -- transaction must acquire locks in this order, never reversed — this
  -- is what makes deadlocks structurally impossible here. Unchanged by
  -- this migration.
  select status, track_inventory into v_product_status, v_track_inventory
  from public.products
  where id = p_product_id and business_id = p_business_id
  for share;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;
  if v_product_status <> 'active' then
    raise exception 'PRODUCT_ARCHIVED' using errcode = '23514';
  end if;
  if not v_track_inventory then
    raise exception 'PRODUCT_NOT_TRACKED' using errcode = '23514';
  end if;

  select status into v_location_status
  from public.inventory_locations
  where id = p_inventory_location_id and business_id = p_business_id
  for share;

  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_location_status <> 'active' then
    raise exception 'LOCATION_ARCHIVED' using errcode = '23514';
  end if;

  -- Lazily create + lock the balance row, race-safe: the unique
  -- constraint plus ON CONFLICT DO NOTHING guarantees exactly one row is
  -- ever created even if two concurrent movements race; both then
  -- proceed to FOR UPDATE, which serializes them on that one row.
  insert into public.inventory_balances (business_id, product_id, inventory_location_id, quantity)
  values (p_business_id, p_product_id, p_inventory_location_id, 0)
  on conflict (business_id, product_id, inventory_location_id) do nothing;

  select quantity into v_current_qty
  from public.inventory_balances
  where business_id = p_business_id
    and product_id = p_product_id
    and inventory_location_id = p_inventory_location_id
  for update;

  v_new_qty := v_current_qty + v_signed_delta;

  -- Negative stock is never allowed — hard block, no override, for any
  -- movement_type including SALE_RETURN (structurally unreachable for a
  -- positive-delta movement in practice, but checked uniformly with every
  -- other movement_type regardless).
  if v_new_qty < 0 then
    raise exception 'INSUFFICIENT_STOCK' using errcode = '23514';
  end if;

  begin
    insert into public.inventory_ledger (
      business_id, inventory_location_id, product_id, movement_type,
      quantity_delta, unit_cost, balance_after, reference_type, reference_id,
      idempotency_key, reason, note, created_by
    ) values (
      p_business_id, p_inventory_location_id, p_product_id, p_movement_type,
      v_signed_delta, p_unit_cost, v_new_qty, v_reference_type, p_reference_id,
      p_idempotency_key, v_reason, v_note, p_actor
    )
    returning * into v_ledger;
  exception
    when unique_violation then
      -- Race recovery: two concurrent callers with the SAME key can both
      -- pass the pre-check above and both attempt the INSERT; exactly one
      -- succeeds. The loser re-runs the identical comparison against the
      -- now-committed winner, returning it on a match or raising
      -- IDEMPOTENCY_KEY_REUSED on a mismatch — never silently accepted.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'inventory_ledger_business_idempotency_key' then
        select * into v_existing
        from public.inventory_ledger
        where business_id = p_business_id and idempotency_key = p_idempotency_key;

        if v_existing.product_id = p_product_id
           and v_existing.inventory_location_id = p_inventory_location_id
           and v_existing.movement_type = p_movement_type
           and v_existing.quantity_delta = v_signed_delta
           and v_existing.unit_cost is not distinct from p_unit_cost
           and v_existing.reference_type is not distinct from v_reference_type
           and v_existing.reference_id is not distinct from p_reference_id
           and v_existing.reason = v_reason
           and v_existing.note is not distinct from v_note
        then
          return v_existing;
        else
          raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
        end if;
      end if;
      raise;
  end;

  update public.inventory_balances
  set quantity = v_new_qty, updated_at = now()
  where business_id = p_business_id
    and product_id = p_product_id
    and inventory_location_id = p_inventory_location_id;

  return v_ledger;
end;
$$;

-- CREATE OR REPLACE preserves the existing owner (private_inventory_writer)
-- and its existing grants/ACL — no re-grant needed, no ownership change.
-- create_sale_return's own NEW role (next migration) receives its own
-- explicit cross-role EXECUTE grant there, exactly like
-- private_sale_writer's own identical cross-role grant for the 'SALE'
-- movement type.
