-- Phase 1C: the authoritative inventory-mutation boundary.
--
-- private.apply_inventory_movement is the shared mechanism (locking,
-- tenant validation, idempotency, negative-stock guard, ledger insert,
-- balance update) — it does NOT check permissions itself, since different
-- callers need different permission keys; that stays with each public
-- entry point. public.record_inventory_movement is the first such entry
-- point (public.create_product, in create_product_rpc.sql, is the
-- second).
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the four tables    │
-- │ it's granted on today. Never extend private_inventory_writer's table │
-- │ grants as a quick fix for some other function's privilege problem;   │
-- │ give that function its own dedicated minimal role instead (exactly   │
-- │ as private_product_creator, in the next migration, does).            │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_inventory_writer') then
    create role private_inventory_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_inventory_writer to postgres;

grant usage on schema public to private_inventory_writer;
grant usage on schema private to private_inventory_writer;
-- UPDATE (not just SELECT) is required here even though this role never
-- issues an UPDATE against either table: Postgres's row-locking clauses
-- (FOR SHARE, used below to close the archive/movement race) require the
-- UPDATE privilege on every table they lock, in addition to SELECT — this
-- is a documented Postgres requirement, not a mistake. apply_inventory_movement's
-- code never actually writes to products or inventory_locations; the
-- grant exists solely to make FOR SHARE's lock acquisition legal.
grant select, update on public.products to private_inventory_writer;
grant select, update on public.inventory_locations to private_inventory_writer;
grant select, insert on public.inventory_ledger to private_inventory_writer;
grant select, insert, update on public.inventory_balances to private_inventory_writer;

-- Explicit cross-role EXECUTE dependencies (SECURITY DEFINER does not
-- transitively grant EXECUTE on functions a function calls — each
-- cross-role call needs its own explicit grant; see private_authorization_helpers.sql's
-- pattern for private_business_creator, applied identically here).
grant execute on function private.current_uid() to private_inventory_writer;
grant execute on function private.has_permission(uuid, text) to private_inventory_writer;

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

  if p_movement_type not in ('OPENING_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT') then
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

  if p_movement_type = 'ADJUSTMENT_OUT' then
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
  -- is what makes deadlocks structurally impossible here.
  --
  -- FOR SHARE (not FOR UPDATE): this function only reads products/
  -- inventory_locations, never writes them. FOR SHARE conflicts with a
  -- concurrent UPDATE's implicit FOR NO KEY UPDATE lock (e.g. an archive)
  -- but not with another concurrent FOR SHARE, so multiple simultaneous
  -- movements against the same product don't serialize on this lock
  -- unnecessarily. This closes the archive/movement race: an in-flight
  -- movement blocks a concurrent archive until it commits, and vice
  -- versa — the status this function reads can never go stale mid-flight.
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
  -- ever created even if two concurrent OPENING_STOCK calls race; both
  -- then proceed to FOR UPDATE, which serializes them on that one row.
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

  -- Negative stock is never allowed in Phase 1C — hard block, no override.
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

-- ALTER ... OWNER TO requires CREATE on the target schema at the moment
-- of transfer — granted only for that instant (mirrors create_business_rpc.sql).
grant create on schema private to private_inventory_writer;
alter function private.apply_inventory_movement(
  uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, uuid, uuid
) owner to private_inventory_writer;
revoke create on schema private from private_inventory_writer;

revoke all on function private.apply_inventory_movement(
  uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, uuid, uuid
) from public;
-- No explicit self-grant needed: ownership already implies EXECUTE.
-- public.create_product (create_product_rpc.sql), owned by a DIFFERENT
-- role, receives an explicit cross-role grant there.

create or replace function public.record_inventory_movement(
  p_business_id           uuid,
  p_product_id            uuid,
  p_inventory_location_id uuid,
  p_movement_type         text,
  p_quantity              numeric,
  p_idempotency_key       uuid,
  p_unit_cost             numeric default null,
  p_reason                text default null,
  p_note                  text default null,
  p_reference_type        text default null,
  p_reference_id          uuid default null
)
returns public.inventory_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if not private.has_permission(p_business_id, 'inventory.adjust') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  return private.apply_inventory_movement(
    p_business_id, p_product_id, p_inventory_location_id, p_movement_type,
    p_quantity, p_unit_cost, p_reference_type, p_reference_id,
    p_reason, p_note, p_idempotency_key, v_uid
  );
end;
$$;

grant create on schema public to private_inventory_writer;
alter function public.record_inventory_movement(
  uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
) owner to private_inventory_writer;
revoke create on schema public from private_inventory_writer;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant — there is no concrete service_role actor calling
-- this in Phase 1C (no automated sales/purchase system exists yet); a
-- future one gets its own deliberately-designed trusted calling
-- convention when it's actually built, not a speculative grant now.
revoke all on function public.record_inventory_movement(
  uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
) from public, anon;
grant execute on function public.record_inventory_movement(
  uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
) to authenticated;
