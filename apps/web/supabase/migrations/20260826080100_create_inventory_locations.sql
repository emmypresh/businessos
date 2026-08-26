-- Phase 1C: inventory locations.
--
-- No location-management UI/RPC exists in Phase 1C — `authenticated` has
-- SELECT only, no write path at all. Every business gets exactly one
-- active default location: existing businesses via a one-time backfill
-- (this migration), future businesses via an additive AFTER INSERT
-- trigger on `businesses` (create_business's own function body is never
-- touched — same technique already used for automatic OWNER membership).

create table public.inventory_locations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null
                check (length(name) <= 100 and length(btrim(name)) >= 2),
  is_default  boolean not null default false,
  status      text not null default 'active'
                check (status in ('active', 'archived')),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A default location can never be stored archived — enforced as a
  -- single-row CHECK (no cross-row query needed). A future
  -- location-management phase reassigning default-ness must do so
  -- atomically (unset the old default, set the new one, in the same
  -- transaction) before archiving the old default is possible; this CHECK
  -- rejecting a premature archive is the intended fail-safe, not a bug.
  check (not is_default or status = 'active'),

  unique (id, business_id)
);

create unique index inventory_locations_one_default_idx
  on public.inventory_locations (business_id)
  where is_default = true;

create index inventory_locations_business_status_idx
  on public.inventory_locations (business_id, status);

create trigger inventory_locations_set_updated_at
  before update on public.inventory_locations
  for each row
  execute function private.set_updated_at();

-- Backfill -------------------------------------------------------------
--
-- Exactly one active default location for every business that predates
-- this migration and has none. Idempotent by construction (the NOT
-- EXISTS guard means a business that already has a location is skipped
-- on any re-run) — on a fresh `db reset` this affects zero rows, since no
-- business rows are seeded by migrations; on a real database it catches
-- every pre-existing tenant in one pass. Run BEFORE the future-business
-- trigger is installed, so it only ever has to reason about "businesses
-- with zero locations" (the pre-migration population), never a business
-- the trigger already handled moments earlier in this same migration.
insert into public.inventory_locations (business_id, name, is_default, status, created_by)
select b.id, 'Main Store', true, 'active', b.created_by
from public.businesses b
where not exists (
  select 1 from public.inventory_locations l where l.business_id = b.id
);

-- Future businesses ------------------------------------------------------

create or replace function private.create_default_inventory_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.inventory_locations (business_id, name, is_default, status, created_by)
  values (new.id, 'Main Store', true, 'active', new.created_by);
  return new;
end;
$$;

revoke all on function private.create_default_inventory_location() from public;

create trigger businesses_create_default_inventory_location
  after insert on public.businesses
  for each row
  execute function private.create_default_inventory_location();

-- Last-active-location protection ---------------------------------------
--
-- Mirrors private.protect_last_owner exactly: fires on both UPDATE and
-- DELETE, uses the same "parent business no longer exists -> skip"
-- escape hatch (so ON DELETE CASCADE from a business deletion is never
-- blocked by this trigger), and uses advisory-lock salt 1 — distinct from
-- protect_last_owner's salt 0 — so the two invariants never contend the
-- same lock key for the same business_id.

create or replace function private.protect_last_active_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id      uuid;
  v_remaining_active  int;
  v_deactivates       boolean;
begin
  v_business_id := old.business_id;

  if not exists (select 1 from public.businesses where id = v_business_id) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if old.status <> 'active' then
    v_deactivates := false;
  elsif tg_op = 'DELETE' then
    v_deactivates := true;
  else
    v_deactivates := new.status <> 'active';
  end if;

  if v_deactivates then
    perform pg_advisory_xact_lock(hashtextextended(v_business_id::text, 1));

    select count(*) into v_remaining_active
    from public.inventory_locations
    where business_id = v_business_id
      and status = 'active'
      and id <> old.id;

    if v_remaining_active = 0 then
      raise exception 'cannot remove the last active inventory location of a business'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.protect_last_active_location() from public;

create trigger inventory_locations_protect_last_active
  before update or delete on public.inventory_locations
  for each row
  execute function private.protect_last_active_location();

-- Row Level Security ---------------------------------------------------

alter table public.inventory_locations enable row level security;
alter table public.inventory_locations force row level security;

-- Plain membership, not a specific permission: every member (including
-- SALES) needs to resolve "the" default location transparently, and
-- Phase 1C has no locations UI for this to over-expose.
create policy inventory_locations_select on public.inventory_locations
  for select
  to authenticated
  using (private.is_business_member(business_id));

revoke all on public.inventory_locations from public, anon, authenticated, service_role;
grant select on public.inventory_locations to authenticated, service_role;
