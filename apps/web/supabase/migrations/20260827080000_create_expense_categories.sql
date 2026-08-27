-- Phase 1E: expense categories.
--
-- Unlike products/customers/sales, category CREATION and metadata edits
-- are BOTH plain RLS-governed writes for `authenticated` — a category is
-- descriptive metadata, not a financial transaction, so there is no
-- cross-table invariant or idempotency concern an RPC boundary would need
-- to protect (mirrors products'/customers' own "metadata edit" treatment,
-- just extended to INSERT too, since a category has no bundled creation
-- side effect the way a product's opening-stock or a sale's stock
-- deduction does). Archiving is the only removal path — no DELETE policy
-- or grant exists for `authenticated` at all, ever.

create table public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null
                check (length(name) <= 100 and length(btrim(name)) >= 2),
  status      text not null default 'ACTIVE'
                check (status in ('ACTIVE', 'ARCHIVED')),
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Composite key so expenses can FK against (id, business_id) together,
  -- making a cross-tenant expense/category combination structurally
  -- unrepresentable, not just RPC-checked — same technique as products'/
  -- customers' own unique(id, business_id).
  unique (id, business_id)
);

-- Business-scoped, case/whitespace-normalized name uniqueness, spanning
-- BOTH statuses (no `status` filter) — mirrors products' sku/barcode
-- index exactly: archiving a category never frees its name for reuse, so
-- "Rent" always resolves to exactly one category, forever, within a
-- business. This is also what keeps default-category seeding
-- (backfill below, and the future-business trigger) safely re-runnable —
-- a second attempt to insert an already-seeded name fails the unique
-- index rather than creating a duplicate.
create unique index expense_categories_name_unique_idx
  on public.expense_categories (business_id, upper(btrim(name)));

create index expense_categories_business_status_idx
  on public.expense_categories (business_id, status);

create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row
  execute function private.set_updated_at();

-- business_id and created_by are fixed at creation time, exactly like
-- products'/customers' own immutable-field triggers.
create or replace function private.enforce_expense_category_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'expense_categories.business_id cannot be changed'
      using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'expense_categories.created_by cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_expense_category_immutable_fields() from public;

create trigger expense_categories_enforce_immutable_fields
  before update on public.expense_categories
  for each row
  execute function private.enforce_expense_category_immutable_fields();

-- Row Level Security ---------------------------------------------------

alter table public.expense_categories enable row level security;
alter table public.expense_categories force row level security;

-- Visible on EITHER expenses.view OR expenses.manage — NOT because manage
-- implies view (it deliberately does not; a manage-only caller still
-- cannot read public.expenses, see create_expenses.sql), but because
-- Postgres's UPDATE machinery requires the target row to already be
-- visible under the table's SELECT policy before an UPDATE can match it
-- at all. Without this OR, a caller holding expenses.manage but not
-- expenses.view would pass the expense_categories_update policy's own
-- USING/WITH CHECK (both check expenses.manage) yet still affect zero
-- rows, because the row was never visible to be targeted in the first
-- place — this is what actually authorizes the row visibility a
-- manage-only caller needs to perform category management, without
-- granting them any access to real financial (expenses) records.
create policy expense_categories_select on public.expense_categories
  for select
  to authenticated
  using (
    private.has_permission(business_id, 'expenses.view')
    or private.has_permission(business_id, 'expenses.manage')
  );

-- INSERT policy: the first table in this schema where `authenticated`
-- creates rows directly rather than through an RPC (see the header
-- comment). created_by defaults to auth.uid() and is deliberately EXCLUDED
-- from the INSERT grant below (Postgres only checks column privilege for
-- columns actually present in the target list — an omitted column with a
-- default needs no privilege at all), so a client cannot set it to
-- another user's id even if it tried; the WITH CHECK below is belt and
-- suspenders on top of that grant-level restriction. status is likewise
-- excluded from the INSERT grant — every category starts 'ACTIVE' via its
-- column default, never caller-chosen at creation.
create policy expense_categories_insert on public.expense_categories
  for insert
  to authenticated
  with check (
    private.has_permission(business_id, 'expenses.manage')
    and created_by = (select auth.uid())
  );

create policy expense_categories_update on public.expense_categories
  for update
  to authenticated
  using (private.has_permission(business_id, 'expenses.manage'))
  with check (private.has_permission(business_id, 'expenses.manage'));

-- No DELETE policy or grant for `authenticated` at all: an archived
-- category remains historically valid for every expense that already
-- references it (category_name_snapshot on public.expenses, next
-- migration, is what keeps historical rendering independent of the
-- category's current/future name or status regardless).

revoke all on public.expense_categories from public, anon, authenticated, service_role;

grant select (
  id, business_id, name, status, created_by, created_at, updated_at
) on public.expense_categories to authenticated, service_role;

grant insert (business_id, name) on public.expense_categories to authenticated;
grant update (name, status) on public.expense_categories to authenticated;

revoke references, trigger, truncate on public.expense_categories from anon, authenticated;

-- Default categories -----------------------------------------------------
--
-- Every business gets the same ten starter categories: existing
-- businesses via a one-time backfill (this migration, guarded by NOT
-- EXISTS so a re-run affects zero already-seeded businesses), future
-- businesses via an additive AFTER INSERT trigger on `businesses` —
-- exactly the technique already proven by
-- private.create_default_inventory_location (create_inventory_locations.sql).
-- create_business's own function body is never touched by either path.
--
-- Deterministic (the same fixed literal list, in the same order, every
-- time), duplicate-safe (the NOT EXISTS guard below plus the unique name
-- index above both independently prevent a double-seed), business-local
-- (each business gets its own ten rows, never a shared/global row), and
-- has no dependence on raw_user_meta_data/user_metadata — created_by
-- comes from businesses.created_by, a plain foreign-key column, exactly
-- like the inventory-location backfill's own treatment.
insert into public.expense_categories (business_id, name, created_by)
select b.id, cat.name, b.created_by
from public.businesses b
cross join (values
  ('Rent'), ('Utilities'), ('Transport'), ('Salaries & Wages'), ('Marketing'),
  ('Supplies'), ('Repairs & Maintenance'), ('Professional Services'),
  ('Taxes & Fees'), ('Other')
) as cat(name)
where not exists (
  select 1 from public.expense_categories ec where ec.business_id = b.id
);

create or replace function private.create_default_expense_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_categories (business_id, name, created_by) values
    (new.id, 'Rent', new.created_by),
    (new.id, 'Utilities', new.created_by),
    (new.id, 'Transport', new.created_by),
    (new.id, 'Salaries & Wages', new.created_by),
    (new.id, 'Marketing', new.created_by),
    (new.id, 'Supplies', new.created_by),
    (new.id, 'Repairs & Maintenance', new.created_by),
    (new.id, 'Professional Services', new.created_by),
    (new.id, 'Taxes & Fees', new.created_by),
    (new.id, 'Other', new.created_by);
  return new;
end;
$$;

revoke all on function private.create_default_expense_categories() from public;

create trigger businesses_create_default_expense_categories
  after insert on public.businesses
  for each row
  execute function private.create_default_expense_categories();
