-- Phase 1F: business branches.
--
-- A branch is a physical/operational location a business runs staff and
-- work out of — distinct from public.inventory_locations (Phase 1C), which
-- tracks WHERE STOCK PHYSICALLY SITS for inventory-ledger purposes. The two
-- concepts are deliberately NOT merged: a business may eventually want
-- branches that hold no stock at all (a sales office) or an inventory
-- location that isn't staffed as its own branch (a shared warehouse).
-- Phase 1F does not connect the two; a future phase may.
--
-- All writes are RPC-only (business_branch_rpcs.sql, next migration) —
-- there is no INSERT/UPDATE/DELETE policy for `authenticated` on this
-- table, ever, matching public.expenses'/public.sales' own "fully
-- RPC-only" precedent. No delete path exists at all, even through RPC —
-- branches are deactivated (status = 'INACTIVE'), never removed, so
-- historical branch-assignment/invitation records always resolve to a
-- real row.

-- Canonicalizes a branch name: outer whitespace trimmed, every internal
-- run of whitespace collapsed to a single space — "  Main   Branch  " and
-- "Main Branch" become byte-identical. IMMUTABLE (a pure function of its
-- input, no table access) so it's usable directly in the unique index
-- expression below, not just in RPC bodies. Codex adversarial review,
-- Finding 4: without this, visually-equivalent names ("Main Branch" vs.
-- "Main   Branch") coexisted, since the ORIGINAL uniqueness expression
-- only trimmed OUTER whitespace, never collapsed internal runs.
create or replace function private.canonicalize_branch_name(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(btrim(p_name), '[[:space:]]+', ' ', 'g');
$$;

revoke all on function private.canonicalize_branch_name(text) from public;

create table public.business_branches (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  -- Stored ALREADY internal-whitespace-collapsed (create_business_branch/
  -- update_business_branch persist private.canonicalize_branch_name(...)
  -- directly, never the raw caller-supplied string) — so this CHECK's own
  -- length bound applies to the same canonical form the uniqueness index
  -- below compares, and any reader sees consistently-formatted names with
  -- no further normalization needed.
  name          text not null
                  check (length(name) <= 100 and length(btrim(name)) >= 2),
  -- Codes are intentionally NOT whitespace-collapsed the way names are —
  -- a code is a short identifier (e.g. "BR-01"), not free-form display
  -- text, so internal whitespace is rejected outright rather than
  -- silently collapsed.
  code          text
                  check (code is null or (
                    length(code) <= 20 and length(btrim(code)) >= 1
                    and code !~ '[[:space:]]'
                  )),
  address_line1 text check (address_line1 is null or length(address_line1) <= 200),
  address_line2 text check (address_line2 is null or length(address_line2) <= 200),
  city          text check (city is null or length(city) <= 100),
  state         text check (state is null or length(state) <= 100),
  -- ISO 3166-1 alpha-2, uppercase, fixed 2 letters — deliberately not a
  -- lookup table in Phase 1F (no country picker/reference-data UI exists
  -- yet); the CHECK is a shape constraint, not a real ISO-membership
  -- validation.
  country_code  text not null default 'NG' check (country_code ~ '^[A-Z]{2}$'),
  phone         text check (phone is null or length(phone) <= 32),
  is_default    boolean not null default false,
  status        text not null default 'ACTIVE'
                  check (status in ('ACTIVE', 'INACTIVE')),
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A default branch can never be stored inactive — single-row CHECK, no
  -- cross-row query needed. This is what makes "the default branch must
  -- be ACTIVE" and "the default branch cannot be deactivated while still
  -- default" the SAME guarantee: an UPDATE trying to set status =
  -- 'INACTIVE' while is_default remains true is rejected by this CHECK
  -- outright. public.deactivate_business_branch (next migration) checks
  -- is_default explicitly first anyway, purely to return a clean
  -- DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED instead of a raw constraint
  -- violation — this CHECK is the actual backstop, independent of that
  -- RPC-level check, for any other writer.
  check (not is_default or status = 'ACTIVE'),

  -- Composite key so member/invitation branch-assignment tables can FK
  -- against (id, business_id) together, making a cross-tenant branch
  -- reference structurally unrepresentable — same technique as every
  -- other Phase 1C/1D/1E "child references parent within the same
  -- business" table.
  unique (id, business_id)
);

-- At most one default branch per business — a partial unique index, not a
-- CHECK, since "at most one" is inherently a cross-row property. Mirrors
-- inventory_locations_one_default_idx exactly.
create unique index business_branches_one_default_idx
  on public.business_branches (business_id)
  where is_default = true;

-- Case/whitespace-normalized name uniqueness per business, spanning BOTH
-- statuses (no status filter) — an inactive branch never frees its name
-- for reuse, matching expense_categories'/products' own name-uniqueness
-- treatment. Applies private.canonicalize_branch_name on top of the
-- already-canonicalized stored value (belt and suspenders — the actual
-- write path always stores the canonical form already, but this index
-- expression is what makes "Main Branch" and "Main   Branch" structurally
-- indistinguishable for ANY writer, not merely the ones that go through
-- create_business_branch/update_business_branch).
create unique index business_branches_name_unique_idx
  on public.business_branches (business_id, upper(private.canonicalize_branch_name(name)));

-- Same normalization for the optional code, only enforced when a code is
-- actually set.
create unique index business_branches_code_unique_idx
  on public.business_branches (business_id, upper(btrim(code)))
  where code is not null;

create index business_branches_business_status_idx
  on public.business_branches (business_id, status);

create trigger business_branches_set_updated_at
  before update on public.business_branches
  for each row
  execute function private.set_updated_at();

-- business_id and created_by are fixed at creation time — never
-- reassignable after the fact, by any writer, independent of RLS.
-- Mirrors products'/customers'/expense_categories' own immutable-field
-- triggers exactly.
create or replace function private.enforce_business_branch_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'business_branches.business_id cannot be changed'
      using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'business_branches.created_by cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_business_branch_immutable_fields() from public;

create trigger business_branches_enforce_immutable_fields
  before update on public.business_branches
  for each row
  execute function private.enforce_business_branch_immutable_fields();

-- Default-branch backfill ------------------------------------------------
--
-- Every existing business gets exactly one ACTIVE default branch, named
-- "Main Branch" — idempotent by construction (the NOT EXISTS guard skips
-- any business that already has one; on a fresh `db reset` this affects
-- zero rows, since no business rows are seeded by migrations). Run BEFORE
-- the future-business trigger below, so it only ever reasons about
-- "businesses with zero branches" (the pre-migration population), never a
-- business the trigger already handled moments earlier in this same
-- migration. Mirrors create_inventory_locations.sql's own backfill
-- exactly.
insert into public.business_branches (business_id, name, is_default, status, created_by)
select b.id, 'Main Branch', true, 'ACTIVE', b.created_by
from public.businesses b
where not exists (
  select 1 from public.business_branches x where x.business_id = b.id
);

-- Future businesses -------------------------------------------------------

create or replace function private.create_default_business_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.business_branches (business_id, name, is_default, status, created_by)
  values (new.id, 'Main Branch', true, 'ACTIVE', new.created_by);
  return new;
end;
$$;

revoke all on function private.create_default_business_branch() from public;

create trigger businesses_create_default_business_branch
  after insert on public.businesses
  for each row
  execute function private.create_default_business_branch();

-- Row Level Security ---------------------------------------------------

alter table public.business_branches enable row level security;
alter table public.business_branches force row level security;

create policy business_branches_select on public.business_branches
  for select
  to authenticated
  using (private.has_permission(business_id, 'branches.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated`, ever — fully
-- RPC-only (business_branch_rpcs.sql). There is no DELETE path at all,
-- through RPC or otherwise.

revoke all on public.business_branches from public, anon, authenticated, service_role;

grant select (
  id, business_id, name, code, address_line1, address_line2, city, state,
  country_code, phone, is_default, status, created_by, created_at, updated_at
) on public.business_branches to authenticated, service_role;

revoke references, trigger, truncate on public.business_branches from anon, authenticated;
