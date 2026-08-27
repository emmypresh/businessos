-- Phase 1D: customer records.
--
-- Creation is RPC-only (public.create_customer, added in the next
-- migration) — no INSERT policy or grant exists for `authenticated` on
-- this table, mirroring public.create_product's exact write-boundary
-- pattern (a client `.from("customers").insert(...)` would bypass
-- normalization and the idempotency arbiter). Metadata edits ARE a plain
-- RLS-governed UPDATE (no cross-table invariant to protect, no bundled
-- transactional side effect) — mirroring products' own metadata-edit
-- treatment.
--
-- Deliberately NOT over-restricted: two customers may share name, phone,
-- or email — no uniqueness constraint on any of them. `email` gets a
-- permissive format CHECK as a defense-in-depth backstop only (the
-- application's own validation is the real gate); `phone` gets no format
-- CHECK at all (international/local formats vary too much to safely
-- constrain server-side without a normalization library).

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null
                check (length(name) <= 200 and length(btrim(name)) >= 2),
  phone       text
                check (phone is null or length(btrim(phone)) between 1 and 32),
  email       text
                check (email is null or (
                  length(email) <= 254
                  and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                )),
  address     text
                check (address is null or length(address) <= 500),
  notes       text
                check (notes is null or length(notes) <= 2000),
  status      text not null default 'active'
                check (status in ('active', 'inactive', 'archived')),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Composite key so sales can FK against (id, business_id) together,
  -- making a cross-tenant sale/customer combination structurally
  -- unrepresentable, not just RPC-checked — same technique as
  -- products' own unique(id, business_id).
  unique (id, business_id)
);

create index customers_business_status_idx on public.customers (business_id, status);
-- Supports a plain case/whitespace-normalized name search without relying
-- on the imatch search path for every query shape (the DAL, when built,
-- may still use buildImatchSearchValue for the .or() free-text search —
-- this index just keeps a simple `lower(btrim(name)) = ...` lookup fast).
create index customers_business_name_idx on public.customers (business_id, lower(btrim(name)));

create trigger customers_set_updated_at
  before update on public.customers
  for each row
  execute function private.set_updated_at();

-- business_id and created_by are fixed at creation time, exactly like
-- products' own immutable-field trigger.
create or replace function private.enforce_customer_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'customers.business_id cannot be changed'
      using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'customers.created_by cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_customer_immutable_fields() from public;

create trigger customers_enforce_immutable_fields
  before update on public.customers
  for each row
  execute function private.enforce_customer_immutable_fields();

-- Row Level Security ---------------------------------------------------

alter table public.customers enable row level security;
alter table public.customers force row level security;

create policy customers_select on public.customers
  for select
  to authenticated
  using (private.has_permission(business_id, 'customers.view'));

create policy customers_update on public.customers
  for update
  to authenticated
  using (private.has_permission(business_id, 'customers.manage'))
  with check (private.has_permission(business_id, 'customers.manage'));

-- No INSERT/DELETE policy for `authenticated` at all: creation is
-- RPC-only (next migration); there is no delete path — archiving (via
-- UPDATE status) is the only removal, mirroring products exactly.

revoke all on public.customers from public, anon, authenticated, service_role;

grant select (
  id, business_id, name, phone, email, address, notes, status,
  created_by, created_at, updated_at
) on public.customers to authenticated, service_role;

grant update (
  name, phone, email, address, notes, status
) on public.customers to authenticated;

revoke references, trigger, truncate on public.customers from anon, authenticated;
