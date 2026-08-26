-- Phase 1C: append-only stock ledger + derived stock balance cache.
--
-- The ledger is the sole source of truth. inventory_balances is a
-- transactionally-maintained cache of it, always reconcilable via
-- SUM(quantity_delta) grouped by (product_id, inventory_location_id).
-- Neither table has any INSERT/UPDATE/DELETE grant for `authenticated` OR
-- `service_role` — every mutation goes through
-- private.apply_inventory_movement (inventory_rpc.sql), full stop.

create table public.inventory_ledger (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  inventory_location_id  uuid not null,
  product_id             uuid not null,
  movement_type          text not null
                           check (movement_type in ('OPENING_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')),
  quantity_delta         numeric(14,3) not null
                           check (quantity_delta <> 0),
  unit_cost              numeric(14,2)
                           check (unit_cost is null or unit_cost >= 0),
  balance_after          numeric(14,3) not null,
  reference_type         text
                           check (reference_type is null or reference_type in ('manual')),
  reference_id           uuid,
  -- Mandatory, not optional protection: every movement is idempotency-keyed.
  -- Internal mutation-control metadata, not a display field — deliberately
  -- excluded from `authenticated`'s SELECT grant below.
  idempotency_key        uuid not null,
  reason                 text not null
                           check (length(btrim(reason)) >= 3),
  note                   text
                           check (note is null or length(note) <= 1000),
  created_by             uuid not null references auth.users (id),
  created_at             timestamptz not null default now(),

  -- Direction is always derived server-side from movement_type, never
  -- caller-signed; this CHECK is defense in depth independent of the RPC.
  check (
    (movement_type in ('OPENING_STOCK', 'ADJUSTMENT_IN') and quantity_delta > 0)
    or (movement_type = 'ADJUSTMENT_OUT' and quantity_delta < 0)
  ),

  -- Tenant-consistent composite FKs: a ledger row's product_id/
  -- inventory_location_id must belong to the SAME business_id as the row
  -- itself, enforced by Postgres, not only by the RPC's own exists()
  -- check. NO ACTION (not RESTRICT — RESTRICT cannot be deferred in
  -- Postgres regardless of a DEFERRABLE clause; only NO ACTION can) +
  -- DEFERRABLE INITIALLY DEFERRED: a whole-business DELETE cascades
  -- products/locations/ledger/balances together in one transaction
  -- without tripping a false violation on cascade-ordering, while a
  -- standalone product/location DELETE (its own transaction, nothing else
  -- removes the referencing rows) is still blocked when that same
  -- transaction's deferred check fires at its end.
  foreign key (product_id, business_id)
    references public.products (id, business_id)
    on delete no action
    deferrable initially deferred,
  foreign key (inventory_location_id, business_id)
    references public.inventory_locations (id, business_id)
    on delete no action
    deferrable initially deferred,

  constraint inventory_ledger_business_idempotency_key unique (business_id, idempotency_key)
);

create index inventory_ledger_product_location_created_idx
  on public.inventory_ledger (business_id, product_id, inventory_location_id, created_at desc);

create index inventory_ledger_business_created_idx
  on public.inventory_ledger (business_id, created_at desc);

create table public.inventory_balances (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  inventory_location_id  uuid not null,
  product_id             uuid not null,
  quantity               numeric(14,3) not null default 0
                           check (quantity >= 0),
  updated_at             timestamptz not null default now(),

  foreign key (product_id, business_id)
    references public.products (id, business_id)
    on delete no action
    deferrable initially deferred,
  foreign key (inventory_location_id, business_id)
    references public.inventory_locations (id, business_id)
    on delete no action
    deferrable initially deferred,

  unique (business_id, product_id, inventory_location_id)
);

-- Row Level Security ---------------------------------------------------

alter table public.inventory_ledger enable row level security;
alter table public.inventory_ledger force row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_balances force row level security;

create policy inventory_ledger_select on public.inventory_ledger
  for select
  to authenticated
  using (private.has_permission(business_id, 'inventory.view'));

create policy inventory_balances_select on public.inventory_balances
  for select
  to authenticated
  using (private.has_permission(business_id, 'inventory.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` at all, ever.
-- Column-restricted SELECT on the ledger excludes unit_cost (see the Cost
-- Visibility Architecture) and idempotency_key (internal mutation-control
-- metadata). `service_role` gets the identical restriction and no
-- write grant on either table — not even trusted server code writes
-- stock directly; every writer goes through record_inventory_movement.
revoke all on public.inventory_ledger from public, anon, authenticated, service_role;
grant select (
  id, business_id, inventory_location_id, product_id, movement_type,
  quantity_delta, balance_after, reference_type, reference_id,
  reason, note, created_by, created_at
) on public.inventory_ledger to authenticated, service_role;

revoke all on public.inventory_balances from public, anon, authenticated, service_role;
grant select on public.inventory_balances to authenticated, service_role;

-- Product archive invariant ----------------------------------------------
--
-- Lives here, not in create_products.sql, because its body depends on
-- inventory_balances existing. A product cannot transition
-- active -> archived while it holds nonzero stock anywhere. SECURITY
-- DEFINER (owned by the default migration role, no dedicated role
-- needed — mirrors private.protect_last_owner exactly) because a caller
-- with products.manage but not inventory.view would otherwise have their
-- own inventory_balances reads RLS-filtered to nothing, producing a
-- false-negative SUM() of zero that would wrongly allow archiving real
-- stock. Concurrency-safe for free: an archive UPDATE holds Postgres's
-- implicit FOR NO KEY UPDATE lock on the products row for its whole
-- transaction, which conflicts with apply_inventory_movement's own
-- SELECT ... FOR SHARE on that same row (inventory_rpc.sql) — the two
-- can never interleave unsafely, in either order, without any additional
-- locking beyond what's already there for the product/location/balance
-- lock order.
create or replace function private.enforce_zero_stock_before_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric(14,3);
begin
  -- Scoped to (business_id, product_id) together, matching this design's
  -- composite tenant-key discipline used everywhere else, and letting
  -- this query hit inventory_balances' unique index on its leading
  -- columns instead of scanning a non-leading one.
  select coalesce(sum(quantity), 0) into v_total
  from public.inventory_balances
  where business_id = old.business_id
    and product_id = old.id;

  if v_total <> 0 then
    raise exception 'CANNOT_ARCHIVE_WITH_STOCK'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_zero_stock_before_archive() from public;

create trigger products_enforce_zero_stock_before_archive
  before update on public.products
  for each row
  when (old.status = 'active' and new.status = 'archived')
  execute function private.enforce_zero_stock_before_archive();
