-- Phase 1F remediation (Codex adversarial review, application-layer round
-- 2, Medium 1) — ADDITIVE ONLY. Does not alter any of the eight frozen
-- Phase 1F migrations (20260828080000 through 20260828080700), any
-- existing table, or any existing policy/grant on business_branches.
--
-- Problem: business_branches' own SELECT policy (create_business_branches.sql)
-- is deliberately gated on branches.view — correct for ordinary browsing,
-- but it also means a caller who holds staff.invite WITHOUT branches.view
-- (a real, intended permission combination — see
-- branches_staff_permissions.sql's own seeded matrix, which does not
-- imply one from the other) cannot read ANY branch row through the
-- ordinary RLS-governed path, and therefore cannot see which ACTIVE
-- branches exist to assign to the invitation they ARE authorized to
-- create. This function is the narrow, purpose-built exception: it
-- returns the absolute minimum data (id, name, code — never address,
-- phone, created_by, timestamps, or is_default) needed to populate that
-- one picker, authorized on staff.invite specifically, never branches.view
-- and never service_role.

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ This role exists for exactly one purpose — reading the minimal       │
-- │ ACTIVE-branch picker data for invitation creation. Never extend its  │
-- │ grants to solve some other function's privilege problem; give that   │
-- │ function its own dedicated minimal role instead. Mirrors every other │
-- │ Phase 1F private role's own identical warning.                       │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invitation_branch_reader') then
    create role private_invitation_branch_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invitation_branch_reader to postgres;

grant usage on schema public to private_invitation_branch_reader;
grant usage on schema private to private_invitation_branch_reader;

-- Exactly the columns the function body below reads: business_id/status
-- are WHERE-clause predicates (a WHERE-referenced column needs SELECT
-- privilege exactly like a SELECT-list column does — see this project's
-- own established precedent, e.g. lib/expenses/dal.ts's own comments on
-- this rule), id/name/code are the only three columns ever returned.
-- Deliberately excludes address_line1/address_line2/city/state/
-- country_code/phone/is_default/created_by/created_at/updated_at — this
-- role can never read any of those, structurally, not merely by
-- convention.
grant select (id, business_id, name, code, status) on public.business_branches to private_invitation_branch_reader;

grant execute on function private.has_permission(uuid, text) to private_invitation_branch_reader;

-- get_invitation_branch_options ------------------------------------------
--
-- Authorization: staff.invite ONLY — never branches.view, never
-- staff.view, never role-name/hierarchy checks. private.has_permission
-- already fails closed for a suspended caller (status <> 'active') and
-- for a caller with no membership in p_business_id at all (foreign
-- tenant), exactly like every other Phase 1F RPC's own authorization
-- check.
create or replace function public.get_invitation_branch_options(p_business_id uuid)
returns table (id uuid, name text, code text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.invite') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select bb.id, bb.name, bb.code
  from public.business_branches bb
  where bb.business_id = p_business_id
    and bb.status = 'ACTIVE'
  order by bb.name;
end;
$$;

grant create on schema public to private_invitation_branch_reader;
alter function public.get_invitation_branch_options(uuid) owner to private_invitation_branch_reader;
revoke create on schema public from private_invitation_branch_reader;

-- service_role is deliberately absent too (not merely anon/public) — this
-- is an ordinary authenticated-caller convenience RPC; service_role
-- already bypasses RLS entirely and has no legitimate reason to call it.
revoke all on function public.get_invitation_branch_options(uuid) from public, anon, service_role;
grant execute on function public.get_invitation_branch_options(uuid) to authenticated;
