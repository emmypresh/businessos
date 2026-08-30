-- Phase 1G: closes a latent Phase 1F gap that Phase 1G's own new
-- has_branch_access-gated write paths (sale creation, first — see the
-- next migrations) newly make load-bearing.
--
-- DISCOVERED DURING DESIGN AUDIT: private.create_owner_membership
-- (Phase 1A — owner_membership_and_last_owner_protection.sql) has NEVER
-- given the automatically-created OWNER any business_member_branches row
-- at all, for any business, past or future — no Phase 1F migration added
-- one either (grep confirms create_business_member_branches.sql,
-- member_management_rpcs.sql, and business_invitation_rpcs.sql are the
-- only writers of that table, and none of them runs at business-creation
-- time). This was harmless in Phase 1F, where has_branch_access existed
-- but was "not itself wired into any table's RLS" or RPC yet (that
-- function's own header comment). It stops being harmless the moment ANY
-- write path starts requiring it: public.replace_member_branches
-- explicitly forbids a caller from ever targeting their OWN membership
-- (CANNOT_MANAGE_SELF), so a zero-assignment OWNER has NO self-service way
-- to grant themselves branch access after the fact — without this fix,
-- EVERY business's own founding OWNER (every existing one today, and
-- every new one created after this phase ships) would be immediately
-- locked out of any has_branch_access-gated action, including their own
-- first sale. This is fixed in two parts: a one-time backfill for every
-- member who already has zero assignments (not just OWNERs — any member
-- created via accept_business_invitation already has real assignments
-- from Phase 1F, so this only ever matches accounts a raw historical gap
-- affects), and a trigger fix so it can never recur for a business created
-- after this migration.

-- Backfill: every existing business_members row (any role, any status —
-- deliberately unconditional; has_branch_access already independently
-- requires status = 'active' on every check, so backfilling a suspended
-- member's historical assignment row is harmless and matches this
-- table's own established "assignment rows are preserved regardless of
-- current status" philosophy) that has ZERO business_member_branches rows
-- gets exactly one: the business's own default branch, as primary —
-- mirrors the LOCKED INVARIANT every RPC-reachable write path already
-- enforces ("every member ends up with at least one assignment and
-- exactly one primary among them"). Deterministic and lossless for the
-- same structural reason the sales-backfill migration proves: every
-- business has exactly one ACTIVE default branch, always.
insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
select bm.business_id, bm.id, bb.id, true, bm.user_id
from public.business_members bm
join public.business_branches bb on bb.business_id = bm.business_id and bb.is_default = true
where not exists (
  select 1 from public.business_member_branches x where x.member_id = bm.id
);

-- Future businesses: give the auto-created OWNER real, immediate
-- operational access to the business's own default branch, in the SAME
-- transaction as their membership itself. Safe to look the branch up here
-- unconditionally: businesses_create_default_business_branch's own
-- trigger name sorts alphabetically BEFORE businesses_create_owner_membership
-- ("...default_business_branch" < "...owner_membership"), and Postgres
-- fires same-event AFTER INSERT triggers on one table in trigger-name
-- order — so the default branch (and, transitively, its own canonical
-- inventory location — created by that branch row's own AFTER INSERT
-- trigger, next migration) is already committed within this same
-- statement by the time this trigger's body runs, for every business,
-- without exception. The `if v_branch_id is not null` guard is pure
-- defense in depth — business creation itself must never spuriously fail
-- because of it — never an expected path.
create or replace function private.create_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_role_id uuid;
  v_member_id     uuid;
  v_branch_id     uuid;
begin
  select id into v_owner_role_id from public.roles where name = 'OWNER';

  if v_owner_role_id is null then
    raise exception 'OWNER role is not seeded';
  end if;

  insert into public.business_members (business_id, user_id, role_id, status)
  values (new.id, new.created_by, v_owner_role_id, 'active')
  returning id into v_member_id;

  select id into v_branch_id
  from public.business_branches
  where business_id = new.id and is_default = true;

  if v_branch_id is not null then
    insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
    values (new.id, v_member_id, v_branch_id, true, new.created_by);
  end if;

  return new;
end;
$$;

-- CREATE OR REPLACE preserves the existing owner (postgres — this function
-- has never had an explicit ALTER FUNCTION ... OWNER TO, exactly like
-- every other businesses-table AFTER INSERT trigger function in this
-- schema) and its existing REVOKE (owner_membership_and_last_owner_protection.sql's
-- own "revoke all on function private.create_owner_membership() from
-- public") — no re-grant needed; the trigger definition itself
-- (businesses_create_owner_membership) is untouched, since a trigger
-- simply calls whatever its function currently is.
