-- Phase 1G remediation round 2 (Codex adversarial review, "CONFIRMED
-- PROBLEM") — ADDITIVE ONLY. Does not alter any of the six frozen Phase
-- 1G migrations (20260829075900 through 20260829080400), any Phase 1A-1F
-- migration, business_branches' own SELECT policy, or any existing
-- grant/role.
--
-- Problem: business_branches' own SELECT policy (create_business_branches.sql)
-- is gated on branches.view. That is correct for the branch-management UI
-- (business_branches' own dedicated screen), but several approved
-- application permissions legitimately need minimal branch-picker
-- metadata WITHOUT logically requiring branches.view: sales.create
-- (choosing where to record a sale), products.manage (choosing where
-- opening stock lands), inventory.adjust (choosing where to adjust
-- stock), expenses.manage (attributing an expense to a branch),
-- reports.view (scoping a report to a branch), sales.view/inventory.view
-- (filtering a business-wide list by branch). Every SEEDED role happens
-- to bundle branches.view alongside these (branches_staff_permissions.sql),
-- so ordinary built-in roles were never actually blocked — but this
-- application's permission model is explicitly capability-based and
-- already supports nonstandard custom permission compositions (see
-- tests/integration/nonstandard-permission-fixtures.test.ts), so a
-- picker's availability silently depending on an unrelated permission is
-- a genuine contract gap, not a hypothetical one.
--
-- Fix: ONE new SECURITY DEFINER RPC, scoped by an explicit finite
-- whitelist of PURPOSE strings (never a caller-supplied permission name —
-- see the "reject unknown scopes" check below), each scope independently
-- authorized on the exact permission that already gates the real
-- operation it backs, returning only the minimal columns a branch picker
-- ever needs (id, name, code, status, is_default, is_primary) — never
-- address/phone/created_by/timestamps/staff-assignment/permission data.
-- This deliberately does NOT become "list every branch to any active
-- member" (explicitly forbidden by the review — that would expose branch
-- names/status to a member with no legitimate operation requiring them);
-- every scope below still requires a specific, real permission.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ This role exists for exactly one purpose — reading minimal           │
-- │ branch-picker metadata for the five whitelisted scopes below. Never  │
-- │ extend its grants to solve some other function's privilege problem;  │
-- │ give that function its own dedicated minimal role instead. Mirrors   │
-- │ every other Phase 1F/1G private role's own identical warning.        │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_branch_option_reader') then
    create role private_branch_option_reader noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_branch_option_reader to postgres;

grant usage on schema public to private_branch_option_reader;
grant usage on schema private to private_branch_option_reader;

-- Least-privilege: SELECT narrowed to exactly the columns this function's
-- queries read or filter on — never a whole-table grant. Deliberately
-- excludes business_branches' address_line1/address_line2/city/state/
-- country_code/phone/created_by/timestamps, and excludes
-- business_member_branches'/business_members' own assigned_by/assigned_at/
-- role_id/user_id-adjacent columns beyond the one (user_id) actually
-- needed to resolve the caller's own member row.
grant select (id, business_id, name, code, status, is_default)
  on public.business_branches to private_branch_option_reader;
grant select (id, business_id, member_id, branch_id, is_primary)
  on public.business_member_branches to private_branch_option_reader;
grant select (id, business_id, user_id, status)
  on public.business_members to private_branch_option_reader;

grant execute on function private.has_permission(uuid, text) to private_branch_option_reader;
grant execute on function private.is_business_member(uuid) to private_branch_option_reader;
-- private.current_uid() is used here (never a direct auth.uid() call)
-- because this function's OWNER (private_branch_option_reader, below) is
-- a brand-new role with no privileges on the `auth` schema, and postgres
-- itself cannot extend `auth` access to a role it creates — see
-- private.current_uid()'s own header comment in create_business_rpc.sql
-- for the full explanation. Every other Phase 1E-1G bypassrls-owned
-- function that needs the caller's own uid follows this same pattern
-- (get_financial_summary_rpc.sql's own private_reports_reader grant).
grant execute on function private.current_uid() to private_branch_option_reader;

-- get_business_branch_options ---------------------------------------------
--
-- p_scope is an explicit finite whitelist, never a raw permission key —
-- rejecting anything outside {'operations','expenses','reports',
-- 'sales_filter','inventory_filter'} up front means a client can never
-- probe for some other permission's branch data merely by passing an
-- arbitrary string; the five branches below are the ONLY code paths that
-- can ever run.
--
-- Identity is never caller-suppliable: every check below derives from
-- private.current_uid()/private.is_business_member/private.has_permission,
-- exactly like every other Phase 1E-1G RPC — there is no p_user_id
-- parameter, and there never should be one.
create or replace function public.get_business_branch_options(
  p_business_id uuid,
  p_scope       text
)
returns table (
  id         uuid,
  name       text,
  code       text,
  status     text,
  is_default boolean,
  is_primary boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_scope is null then
    raise exception 'p_business_id and p_scope are required' using errcode = '22023';
  end if;

  if p_scope not in ('operations', 'expenses', 'reports', 'sales_filter', 'inventory_filter') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  -- Fail closed, uniformly, for a foreign/nonexistent business BEFORE any
  -- scope-specific check runs — private.is_business_member already never
  -- discloses whether p_business_id itself exists (it can only ever
  -- return true/false derived from the caller's OWN membership rows), so
  -- a stranger and a caller targeting a made-up id get the identical
  -- insufficient_privilege outcome below, matching every other Phase
  -- 1E-1G RPC's own non-disclosure contract.
  if not private.is_business_member(p_business_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_scope = 'operations' then
    -- Used for: sale creation, product opening stock, inventory
    -- adjustment. Authorization: active membership (already checked
    -- above) AND at least one relevant operational permission — matching
    -- create_sale/create_product/record_inventory_movement's own actual
    -- authorization gates exactly (never guessed; see
    -- lib/business/constants.ts's PERMISSION.SALES_CREATE/
    -- PRODUCTS_MANAGE/INVENTORY_ADJUST).
    if not (
      private.has_permission(p_business_id, 'sales.create')
      or private.has_permission(p_business_id, 'products.manage')
      or private.has_permission(p_business_id, 'inventory.adjust')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;

    select bm.id into v_member_id
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = private.current_uid()
      and bm.status = 'active';

    -- ONLY branches assigned to the current member, same business,
    -- ACTIVE — this is what replaces the current pickers' dependency on
    -- business_branches' own branches.view-gated SELECT policy (each
    -- embedded-relationship read via PostgREST independently enforces
    -- every joined table's own RLS, which is exactly the wall this RPC
    -- exists to route around, safely, for this one purpose).
    return query
    select bb.id, bb.name, bb.code, bb.status, bb.is_default, bmb.is_primary
    from public.business_member_branches bmb
    join public.business_branches bb
      on bb.id = bmb.branch_id and bb.business_id = bmb.business_id
    where bmb.business_id = p_business_id
      and bmb.member_id = v_member_id
      and bb.status = 'ACTIVE'
    order by bmb.is_primary desc, bb.name asc;
    return;
  end if;

  if p_scope = 'expenses' then
    -- Every same-business ACTIVE branch is a legitimate attribution
    -- choice, never narrowed to the caller's own operational assignment
    -- (the WHERE clause below never filters on assignment) — matching
    -- create_expense's own authorization design (expenses.manage ALONE,
    -- no has_branch_access check). Authorization here is expenses.manage
    -- OR expenses.view, not expenses.manage alone: this scope backs BOTH
    -- the create form (expenses.manage) AND the expense list's own branch
    -- filter (reachable on expenses.view alone — a real, tested role
    -- composition; no seeded role is expenses.view without
    -- expenses.manage, but a custom one legitimately can be). This
    -- mirrors an existing precedent in this exact schema:
    -- expense_categories' own SELECT policy is likewise granted on
    -- "expenses.view OR expenses.manage" together (see
    -- create_expense_categories.sql) for the identical reason — a picker/
    -- reference list that both the create and browse workflows need to
    -- read. is_primary IS still meaningful here, unlike the three purely-
    -- filter scopes below it: the expense form defaults its selection to
    -- the caller's OWN primary branch (a deliberate product choice, not
    -- an authorization boundary — see expense-form.tsx's own comment)
    -- alongside the always-available explicit "Company-wide" choice, so
    -- this LEFT JOINs the caller's own assignment purely to flag which
    -- one (if any) row is theirs; an unassigned caller (or one whose only
    -- assignment is inactive) simply gets every row back with
    -- is_primary = false, never an error.
    if not (
      private.has_permission(p_business_id, 'expenses.manage')
      or private.has_permission(p_business_id, 'expenses.view')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;

    select bm.id into v_member_id
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = private.current_uid()
      and bm.status = 'active';

    return query
    select bb.id, bb.name, bb.code, bb.status, bb.is_default,
           coalesce(bmb.is_primary, false) as is_primary
    from public.business_branches bb
    left join public.business_member_branches bmb
      on bmb.branch_id = bb.id and bmb.business_id = bb.business_id and bmb.member_id = v_member_id
    where bb.business_id = p_business_id
      and bb.status = 'ACTIVE'
    order by bb.is_default desc, bb.name asc;
    return;
  end if;

  if p_scope = 'reports' then
    -- Matches get_financial_summary's own authorization exactly:
    -- reports.view ALONE, no has_branch_access check, and historical
    -- reporting explicitly needs a deactivated branch to remain
    -- selectable — so INACTIVE branches are included here, uniquely
    -- among all five scopes.
    if not private.has_permission(p_business_id, 'reports.view') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;

    return query
    select bb.id, bb.name, bb.code, bb.status, bb.is_default, false
    from public.business_branches bb
    where bb.business_id = p_business_id
    order by bb.is_default desc, bb.name asc;
    return;
  end if;

  if p_scope = 'sales_filter' then
    -- sales.view's own RLS is business-wide with no per-branch
    -- restriction, and historical sales can reference a branch later
    -- deactivated — so, like reports, this includes INACTIVE branches
    -- and imposes no operational-assignment restriction.
    if not private.has_permission(p_business_id, 'sales.view') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;

    return query
    select bb.id, bb.name, bb.code, bb.status, bb.is_default, false
    from public.business_branches bb
    where bb.business_id = p_business_id
    order by bb.is_default desc, bb.name asc;
    return;
  end if;

  if p_scope = 'inventory_filter' then
    -- inventory.view is business-wide (never narrowed to operational
    -- branch assignment — see getInventoryOverview's own header comment
    -- in lib/inventory/dal.ts). ACTIVE only: the current inventory
    -- overview this backs has no stated need to filter by a branch that
    -- can no longer receive stock activity at all, unlike reports/sales
    -- history which are explicitly retrospective.
    if not private.has_permission(p_business_id, 'inventory.view') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;

    return query
    select bb.id, bb.name, bb.code, bb.status, bb.is_default, false
    from public.business_branches bb
    where bb.business_id = p_business_id
      and bb.status = 'ACTIVE'
    order by bb.is_default desc, bb.name asc;
    return;
  end if;
end;
$$;

grant create on schema public to private_branch_option_reader;
alter function public.get_business_branch_options(uuid, text)
  owner to private_branch_option_reader;
revoke create on schema public from private_branch_option_reader;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. service_role
-- is deliberately absent too (not merely anon/public) — this is an
-- ordinary authenticated-caller convenience RPC; service_role already
-- bypasses RLS entirely and has no legitimate reason to call it, matching
-- get_invitation_branch_options' own identical precedent.
revoke all on function public.get_business_branch_options(uuid, text)
  from public, anon, service_role;
grant execute on function public.get_business_branch_options(uuid, text)
  to authenticated;
