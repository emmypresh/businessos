-- Phase 1O-A — Platform Admin Security Foundation.
--
-- Introduces a SECOND, wholly separate authorization domain: internal
-- BusinessOS staff/platform administration. This is independent of
-- business_members/roles/role_permissions (tenant authorization) in every
-- respect — no shared table, no shared role enum, no implication in
-- either direction. A tenant OWNER/ADMIN (even of many businesses) gains
-- zero platform authority from that membership alone; platform authority
-- comes only from an explicit, active row in platform_admins, which only
-- an operator can create (see the bootstrap note on platform_admins
-- below — there is deliberately no self-service or first-signup path).
--
-- Mirrors the exact security pattern already established for tenant
-- authorization (private_authorization_helpers.sql / create_business_
-- members.sql): RLS enabled + FORCED with no authenticated-facing
-- policies at all (fail closed by default), a SECURITY DEFINER helper
-- that derives identity from private.current_uid() (never a caller-
-- supplied user_id — see private.has_platform_permission below), a fixed
-- empty search_path with fully-qualified references, and a narrow
-- SECURITY INVOKER public wrapper for server-side callers.

-- ---------------------------------------------------------------------
-- 1. platform_admins — the only source of platform authority.
-- ---------------------------------------------------------------------
create table public.platform_admins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  role        text not null
                check (role in ('SUPER_ADMIN', 'SUPPORT', 'OPERATIONS', 'BILLING', 'VIEWER')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Nullable: the very first platform_admins row is created by an operator
  -- running trusted SQL directly (see the bootstrap note below), before any
  -- other platform_admins row exists to attribute it to. Every row created
  -- afterward via a future admin-management RPC (Phase 1O-D or later) is
  -- expected to populate this.
  created_by  uuid references auth.users (id)
);

create trigger platform_admins_set_updated_at
  before update on public.platform_admins
  for each row
  execute function private.set_updated_at();

-- Row Level Security ---------------------------------------------------
--
-- Deliberately NO policy at all, for any operation, for `authenticated`.
-- Combined with the grants below (no SELECT/INSERT/UPDATE/DELETE granted
-- to `authenticated` either — GRANT and RLS are independent layers, and
-- this table gets neither), a normal tenant user cannot see this table
-- exists, cannot enumerate platform admins, admin emails, admin user IDs,
-- or admin roles, and cannot write to it under any circumstance. The only
-- way to read or reason about this table's contents is through the
-- SECURITY DEFINER functions below, which only ever answer questions
-- about the CURRENT authenticated user's own row — never anyone else's,
-- and never a listing.
alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;

-- service_role gets SELECT only, matching business_members' own
-- precedent: operator tooling and any future admin-management RPC can
-- read through service_role or as the SECURITY DEFINER functions' owner;
-- no additional grant is needed for the functions below to work, since
-- they run with the privileges of their (separately created) owning
-- role, not of `authenticated`.
grant select on public.platform_admins to service_role;

comment on table public.platform_admins is
  'Internal BusinessOS staff authorization. Wholly separate from tenant '
  'business_members/roles — a tenant OWNER/ADMIN gains no authority here. '
  'No authenticated-facing grants or RLS policies exist by design; access '
  'is only ever through the has_platform_permission()/get_my_platform_role() '
  'functions below. Bootstrap: the first SUPER_ADMIN row must be inserted '
  'directly by an operator with database access (e.g. via the Supabase '
  'SQL editor or `supabase db` against the target project), never by '
  'application code, a migration hardcoding a personal email, or any '
  'automatic promotion (first signup, first OWNER, an email domain, etc).';

-- ---------------------------------------------------------------------
-- 2. Platform permission catalog — small and explicit, read-only for
--    1O-A. Mirrors the shape of public.permissions/role_permissions
--    (tenant side) for the same auditability, but role->permission is
--    a fixed seed matrix here, not something any RPC ever mutates: the
--    platform role enum is fixed code (the CHECK constraint above), not
--    a user-manageable roles table.
-- ---------------------------------------------------------------------
create table public.platform_permissions (
  key         text primary key,
  description text not null
);

create table public.platform_role_permissions (
  role           text not null
                   check (role in ('SUPER_ADMIN', 'SUPPORT', 'OPERATIONS', 'BILLING', 'VIEWER')),
  permission_key text not null references public.platform_permissions (key),
  primary key (role, permission_key)
);

-- No grants at all to `authenticated`/`anon` on either catalog table:
-- like platform_admins itself, the only sanctioned read path is the
-- SECURITY DEFINER functions below. This is reference data an ordinary
-- tenant user still has no legitimate reason to enumerate directly.
grant select on public.platform_permissions, public.platform_role_permissions to service_role;

alter table public.platform_permissions enable row level security;
alter table public.platform_permissions force row level security;
alter table public.platform_role_permissions enable row level security;
alter table public.platform_role_permissions force row level security;

insert into public.platform_permissions (key, description) values
  ('platform.dashboard.view', 'View the internal platform administration overview.'),
  ('platform.businesses.view', 'View tenant business records (read-only, for future support/operations tooling).'),
  ('platform.users.view', 'View platform-level user records (read-only, for future support tooling).'),
  ('platform.subscriptions.view', 'View subscription/billing records (read-only, for future billing/operations tooling).'),
  ('platform.audit.view', 'View platform-level audit history.');

-- 1O-A grants only *.view permissions to any role. Future mutation
-- permissions (platform.businesses.manage, platform.subscriptions.manage,
-- platform.support.manage, platform.admins.manage) are intentionally not
-- created yet — see the phase brief; creating the name would not by
-- itself enable anything unsafe, but this phase's scope is read
-- authorization only, so they are simply not seeded.
insert into public.platform_role_permissions (role, permission_key) values
  ('SUPER_ADMIN', 'platform.dashboard.view'),
  ('SUPER_ADMIN', 'platform.businesses.view'),
  ('SUPER_ADMIN', 'platform.users.view'),
  ('SUPER_ADMIN', 'platform.subscriptions.view'),
  ('SUPER_ADMIN', 'platform.audit.view'),
  ('SUPPORT', 'platform.dashboard.view'),
  ('SUPPORT', 'platform.businesses.view'),
  ('SUPPORT', 'platform.users.view'),
  ('OPERATIONS', 'platform.dashboard.view'),
  ('OPERATIONS', 'platform.businesses.view'),
  ('OPERATIONS', 'platform.subscriptions.view'),
  ('BILLING', 'platform.dashboard.view'),
  ('BILLING', 'platform.subscriptions.view'),
  ('VIEWER', 'platform.dashboard.view');

-- ---------------------------------------------------------------------
-- 3. Authorization functions.
-- ---------------------------------------------------------------------

-- Identity is ALWAYS derived from private.current_uid() (the same JWT-
-- backed helper create_business's RPC boundary uses) — never accepted as
-- a parameter. A caller cannot ask "does user X have permission Y"; only
-- "do I have permission Y", which makes cross-user spoofing structurally
-- unavailable rather than merely checked for.
create or replace function private.has_platform_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins pa
    join public.platform_role_permissions prp on prp.role = pa.role
    where pa.user_id = private.current_uid()
      and pa.is_active = true
      and prp.permission_key = p_permission_key
  );
$$;

revoke all on function private.has_platform_permission(text) from public, anon, authenticated;
grant execute on function private.has_platform_permission(text) to authenticated;

-- Public, PostgREST-callable wrapper — SECURITY INVOKER, exactly like
-- public.has_permission: it does no privileged work itself, only forwards
-- to the already-narrow SECURITY DEFINER helper above.
create or replace function public.has_platform_permission(p_permission_key text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.has_platform_permission(p_permission_key);
$$;

revoke all on function public.has_platform_permission(text) from public, anon;
grant execute on function public.has_platform_permission(text) to authenticated;

-- Returns the current user's own platform role (or null if none/inactive),
-- for the internal admin overview screen to display — never anyone
-- else's. SECURITY DEFINER for the same reason has_platform_permission
-- is: platform_admins carries no authenticated-facing SELECT grant or
-- policy, so a SECURITY INVOKER function could never see even the
-- caller's own row.
create or replace function private.get_my_platform_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pa.role
  from public.platform_admins pa
  where pa.user_id = private.current_uid()
    and pa.is_active = true;
$$;

revoke all on function private.get_my_platform_role() from public, anon, authenticated;
grant execute on function private.get_my_platform_role() to authenticated;

create or replace function public.get_my_platform_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select private.get_my_platform_role();
$$;

revoke all on function public.get_my_platform_role() from public, anon;
grant execute on function public.get_my_platform_role() to authenticated;
