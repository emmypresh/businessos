-- Businesses: the tenant table for BusinessOS.
--
-- Ownership is expressed through business_members (added in the next
-- migration), not an owner_id column here, so there is exactly one source
-- of truth for "who can do what" on a business.

create table public.businesses (
  id         uuid primary key default gen_random_uuid(),
  -- Bounded at the database layer, not just in create_business's own
  -- validation: length(name) <= 150 caps storage regardless of who writes
  -- the row (including service_role, which isn't routed through the RPC),
  -- and length(btrim(name)) >= 2 rejects empty/whitespace-only/1-character
  -- values even if a future writer forgets to trim first.
  name       text not null
               check (length(name) <= 150 and length(btrim(name)) >= 2),
  slug       text not null unique,
  status     text not null default 'active'
               check (status in ('active', 'suspended', 'archived')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index businesses_created_by_idx on public.businesses (created_by);
create index businesses_status_idx on public.businesses (status);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row
  execute function private.set_updated_at();

-- created_by is set once, at creation, and is load-bearing for the
-- automatic-OWNER-membership trigger added in a later migration — it must
-- never be reassignable after the fact, by any writer (including a future
-- privileged RPC), independent of whatever RLS policy is in force.
create or replace function private.prevent_created_by_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.created_by <> old.created_by then
    raise exception 'businesses.created_by cannot be changed'
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

-- Postgres refuses to invoke any trigger function outside trigger context
-- regardless of EXECUTE grants; this revoke is a grants-audit signal, not
-- a functional change (see private_schema_and_updated_at.sql).
revoke all on function private.prevent_created_by_change() from public;

create trigger businesses_prevent_created_by_change
  before update on public.businesses
  for each row
  execute function private.prevent_created_by_change();

-- Row Level Security ---------------------------------------------------
--
-- Enabled and forced from the moment this table exists, so even the table
-- owner role is subject to policies. No INSERT policy for `authenticated`
-- is defined here, ever: business creation has exactly one authorized
-- path, public.create_business (see create_business_rpc.sql), which runs
-- as its own dedicated, narrowly-privileged role rather than as
-- `authenticated`. See that migration for the reasoning — in short, a
-- `businesses_insert` policy + INSERT grant for `authenticated` would let
-- a client call `.from('businesses').insert(...)` directly, bypassing
-- create_business's slug normalization/validation and making it not
-- actually the authoritative creation boundary. SELECT/UPDATE/DELETE
-- depend on the private.is_business_member / private.has_permission
-- helpers, which in turn depend on business_members — neither exists
-- until later migrations. Until all of this exists, this table has no
-- policy for `authenticated` at all, so every operation is denied by
-- default (fail closed) rather than left open in the meantime.

alter table public.businesses enable row level security;
alter table public.businesses force row level security;

-- `service_role` bypasses RLS entirely and is granted full access now — it
-- does legitimate administrative/server-side work from day one, and the
-- created_by-immutability trigger above restricts it exactly like every
-- other writer regardless of which columns it's granted. `authenticated`
-- gets no grant here at all — see above.
grant select, insert, update, delete on public.businesses to service_role;
