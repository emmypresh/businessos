-- business_members: the single source of truth for who belongs to a
-- business, with what role, and in what state. Every authorization
-- decision in later migrations reads through this table — never through
-- auth.jwt() claims or user_metadata.

create table public.business_members (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role_id     uuid not null references public.roles (id),
  status      text not null default 'active'
                check (status in ('invited', 'active', 'suspended', 'removed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A user holds exactly one membership row (and therefore one role) per
  -- business. Also serves as the lookup index for "all members of this
  -- business" (business_id leads the index) and, combined with the WHERE
  -- clause in queries, "is this user a member of this business".
  unique (business_id, user_id)
);

-- Not covered by the unique(business_id, user_id) index above, which leads
-- with business_id: "all businesses a given user belongs to".
create index business_members_user_id_idx on public.business_members (user_id);
-- Supports role-based lookups, including the last-owner count query added
-- in the next migration.
create index business_members_role_id_idx on public.business_members (role_id);

create trigger business_members_set_updated_at
  before update on public.business_members
  for each row
  execute function private.set_updated_at();

-- A membership row's identity is the (business_id, user_id) pair it was
-- created with. Letting either be reassigned would let one membership
-- silently become a different membership — effectively moving a user
-- between businesses, or swapping which user a role grant applies to,
-- without going through creation/removal. Enforced independently of RLS
-- so it holds for every writer, including future privileged RPCs.
create or replace function private.prevent_membership_reassignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id or new.user_id <> old.user_id then
    raise exception 'business_members.business_id and user_id cannot be changed'
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

-- Postgres refuses to invoke any trigger function outside trigger context
-- regardless of EXECUTE grants; this revoke is a grants-audit signal, not
-- a functional change (see private_schema_and_updated_at.sql).
revoke all on function private.prevent_membership_reassignment() from public;

create trigger business_members_prevent_reassignment
  before update on public.business_members
  for each row
  execute function private.prevent_membership_reassignment();

-- Row Level Security ---------------------------------------------------
--
-- Enabled and forced immediately. No policies yet: the SELECT policy needs
-- private.is_business_member (added once the helper functions exist, in a
-- later migration), and there is deliberately no INSERT/UPDATE/DELETE
-- policy for `authenticated` in Phase 1 at all — membership rows are only
-- ever written by the SECURITY DEFINER trigger functions added in the next
-- migration (automatic OWNER membership on business creation). Member
-- invite/remove/role-change RPCs are out of scope for this phase; when
-- they're added, they'll be their own narrowly-scoped SECURITY DEFINER
-- functions, not a blanket RLS policy. Until any policy exists here, every
-- operation is denied by default for `authenticated` (fail closed).

alter table public.business_members enable row level security;
alter table public.business_members force row level security;

-- GRANT is a separate layer from RLS: it controls whether a role may
-- attempt an operation at all (recent Supabase projects no longer
-- auto-expose new tables — see create_roles_permissions.sql), RLS then
-- controls which rows. `authenticated` gets SELECT only, matching the one
-- policy this table will have — there is intentionally no INSERT/UPDATE/
-- DELETE grant for it, so even if a future migration's policy authoring
-- slipped up, the role still couldn't write to this table. `service_role`
-- also gets SELECT only for now: the SECURITY DEFINER trigger functions in
-- the next migration write to this table as the table owner, independent
-- of any grant, so service_role doesn't need write access yet either —
-- future member-management RPCs can extend this when they're built.
grant select on public.business_members to authenticated, service_role;
