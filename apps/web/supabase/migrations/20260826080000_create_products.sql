-- Phase 1C: product catalog.
--
-- Creation is RPC-only (public.create_product, added in a later migration)
-- — no INSERT policy or grant exists for `authenticated` on this table,
-- mirroring public.create_business's write-boundary pattern exactly, for
-- the same reason: normalization, SKU/business_id validation, and atomic
-- opening-stock bundling cannot be guaranteed if a client can
-- `.from("products").insert(...)` directly. Metadata edits and archiving
-- ARE plain RLS-governed UPDATEs (no cross-table invariant to protect),
-- mirroring businesses_update.

create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  name                text not null
                        check (length(name) <= 200 and length(btrim(name)) >= 2),
  description         text
                        check (description is null or length(description) <= 2000),
  sku                 text
                        check (sku is null or length(btrim(sku)) between 1 and 64),
  barcode             text
                        check (barcode is null or length(btrim(barcode)) between 1 and 64),
  category            text
                        check (category is null or length(category) <= 100),
  unit                text not null default 'unit'
                        check (length(unit) between 1 and 20),
  cost_price          numeric(14,2) not null default 0
                        check (cost_price >= 0),
  selling_price       numeric(14,2) not null default 0
                        check (selling_price >= 0),
  currency_code       text not null default 'NGN'
                        check (currency_code ~ '^[A-Z]{3}$'),
  track_inventory     boolean not null default true,
  low_stock_threshold numeric(14,3)
                        check (low_stock_threshold is null or low_stock_threshold >= 0),
  status              text not null default 'active'
                        check (status in ('active', 'archived')),
  -- Idempotency key for public.create_product (see create_product_rpc.sql).
  -- Internal mutation-control metadata, not a display field — deliberately
  -- excluded from `authenticated`'s SELECT grant below.
  creation_key        uuid not null,
  created_by          uuid not null references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A stock-tracked item must have an identifiable SKU; a non-tracked
  -- (service) item may omit one.
  check (not track_inventory or sku is not null),

  -- Composite key so inventory_ledger/inventory_balances can FK against
  -- (id, business_id) together, making a cross-tenant product/ledger
  -- combination structurally unrepresentable, not just RPC-checked.
  unique (id, business_id),

  constraint products_business_creation_key unique (business_id, creation_key)
);

-- SKU/barcode uniqueness is business-scoped, case/whitespace-normalized,
-- and spans BOTH active and archived products (no `status` filter):
-- archiving a product never frees its identifier for reuse, so a SKU
-- always resolves to exactly one product, forever, within a business.
create unique index products_sku_unique_idx
  on public.products (business_id, upper(btrim(sku)))
  where sku is not null;

create unique index products_barcode_unique_idx
  on public.products (business_id, upper(btrim(barcode)))
  where barcode is not null;

create index products_business_status_idx on public.products (business_id, status);

create trigger products_set_updated_at
  before update on public.products
  for each row
  execute function private.set_updated_at();

-- business_id, created_by, creation_key, and track_inventory are all fixed
-- at creation time. track_inventory has no designed transition in Phase
-- 1C (flipping it post-creation raises invariant questions — what happens
-- to already-accumulated stock — this phase doesn't answer), so it is
-- immutable, not just excluded from the UPDATE grant below (belt and
-- suspenders, matching businesses.created_by's own treatment).
create or replace function private.enforce_product_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'products.business_id cannot be changed'
      using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'products.created_by cannot be changed'
      using errcode = '23514';
  end if;
  if new.creation_key <> old.creation_key then
    raise exception 'products.creation_key cannot be changed'
      using errcode = '23514';
  end if;
  if new.track_inventory <> old.track_inventory then
    raise exception 'products.track_inventory cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_product_immutable_fields() from public;

create trigger products_enforce_immutable_fields
  before update on public.products
  for each row
  execute function private.enforce_product_immutable_fields();

-- Row Level Security ---------------------------------------------------

alter table public.products enable row level security;
alter table public.products force row level security;

create policy products_select on public.products
  for select
  to authenticated
  using (private.has_permission(business_id, 'products.view'));

create policy products_update on public.products
  for update
  to authenticated
  using (private.has_permission(business_id, 'products.manage'))
  with check (private.has_permission(business_id, 'products.manage'));

-- No INSERT/DELETE policy for `authenticated` at all: creation is
-- RPC-only, and archiving (via UPDATE status) is the only removal path.

-- GRANT is a separate layer from RLS (see create_roles_permissions.sql):
-- it controls whether a role may attempt an operation at all. Column-
-- restricted for SELECT (excludes cost_price — see the Cost Visibility
-- Architecture; and creation_key — internal mutation-control metadata,
-- not granted to ordinary reads per this phase's final hardening) and for
-- UPDATE (excludes id/business_id/created_by/created_at/updated_at/
-- track_inventory/creation_key). `service_role` gets the identical
-- restricted SELECT — it has no more direct access to cost_price or
-- creation_key than `authenticated` does; it is not the product-write
-- boundary (private_product_creator, added in create_product_rpc.sql, is)
-- and has no INSERT/UPDATE grant here at all.
revoke all on public.products from public, anon, authenticated, service_role;

grant select (
  id, business_id, name, description, sku, barcode, category, unit,
  selling_price, currency_code, track_inventory, low_stock_threshold,
  status, created_by, created_at, updated_at
) on public.products to authenticated, service_role;

grant update (
  name, description, sku, barcode, category, unit, cost_price,
  selling_price, currency_code, low_stock_threshold, status
) on public.products to authenticated;
