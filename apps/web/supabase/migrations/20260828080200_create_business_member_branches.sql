-- Phase 1F: member-to-branch assignments, and the branch-access helper.
--
-- LOCKED INVARIANT (Codex adversarial review, Finding 3): every member
-- this table has ANY row for is required, transactionally, by the RPCs
-- that write it (replace_member_branches — member_management_rpcs.sql —
-- and accept_business_invitation — business_invitation_rpcs.sql) to end
-- up with at least one assignment row and EXACTLY one of them
-- is_primary. There is no RPC-reachable path that leaves a member with
-- zero assignments or a nonempty assignment set with no primary — a
-- request that would produce either is rejected outright, atomically,
-- before anything commits. This is NOT expressed as a table CHECK (a
-- single-row CHECK cannot see "how many OTHER rows does this member
-- have", and a hard minimum enforced only at the table level would also
-- make the RPCs' own atomic-replace pattern harder to reason about) —
-- it is enforced by the write path being the only write path, exactly
-- like this project's other RPC-enforced-not-CHECK-enforced invariants
-- (e.g. "primary branch must be ACTIVE").
--
-- What IS enforced structurally by the schema itself: a member can never
-- be assigned to a branch outside their own business (the composite
-- tenant FKs below), never assigned to the same branch twice (the unique
-- constraint), and never have two PRIMARY branches at once (the partial
-- unique index).
--
-- Historical assignment rows are still never deleted merely because a
-- branch is later deactivated or a member is suspended — deactivating a
-- branch revokes operational access immediately (see
-- private.has_branch_access below) without touching this table at all,
-- and a suspended member's assignment rows are preserved for historical/
-- admin visibility, matching this project's established "snapshot at
-- write time, never re-derive from later-mutable state" philosophy for
-- the ROWS themselves, while access itself is always re-derived live.

create table public.business_member_branches (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  member_id   uuid not null,
  branch_id   uuid not null,
  is_primary  boolean not null default false,
  assigned_by uuid not null references auth.users (id),
  assigned_at timestamptz not null default now(),

  unique (member_id, branch_id),

  -- Tenant-consistent composite FKs: member_id must resolve to a
  -- business_members row in THIS SAME business_id, and branch_id must
  -- resolve to a business_branches row in THIS SAME business_id — a
  -- cross-tenant assignment (a member from business A assigned to a
  -- branch of business B, or vice versa) is structurally unrepresentable,
  -- not merely RPC-checked. NO ACTION + DEFERRABLE INITIALLY DEFERRED,
  -- matching every other Phase 1C/1D/1E child-table FK exactly, so a
  -- whole-business DELETE can cascade business_members/business_branches/
  -- business_member_branches together in one transaction without tripping
  -- a false violation on cascade-ordering.
  foreign key (member_id, business_id)
    references public.business_members (id, business_id)
    on delete cascade,
  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

-- At most one primary branch per member.
create unique index business_member_branches_one_primary_idx
  on public.business_member_branches (member_id)
  where is_primary = true;

create index business_member_branches_business_idx
  on public.business_member_branches (business_id);
create index business_member_branches_branch_idx
  on public.business_member_branches (business_id, branch_id);

-- No updated_at/immutable-fields trigger: rows here are only ever
-- replaced wholesale (delete + reinsert) by
-- public.replace_member_branches, never updated in place — see that
-- function's own header comment.

-- Row Level Security ---------------------------------------------------
--
-- Suspending a member preserves their branch-assignment rows (never
-- deleted on suspend) for "historical/admin visibility" per the approved
-- plan — this policy's own use of private.is_business_member (which
-- requires the VIEWER, not the row's member, to currently be active)
-- already achieves that: a suspended member's assignment rows remain
-- visible to every other currently-active member exactly as before, and
-- the assignment rows themselves are never touched by suspension.

alter table public.business_member_branches enable row level security;
alter table public.business_member_branches force row level security;

-- Visible to any currently-active business member (mirrors
-- business_members_select's own "any active member sees the whole
-- roster" precedent — branch assignments are no more sensitive than the
-- membership roster itself, which is already fully exposed that way), OR
-- to the assigned member viewing their own assignments regardless of
-- their own current status (so a just-suspended member's client, which
-- may still be rendering already-fetched state, and an admin looking at
-- that member's own history, both resolve consistently).
create policy business_member_branches_select on public.business_member_branches
  for select
  to authenticated
  using (
    private.is_business_member(business_id)
    or member_id in (
      select id from public.business_members where user_id = (select auth.uid())
    )
  );

-- No INSERT/UPDATE/DELETE policy for `authenticated`, ever — fully
-- RPC-only (member_management_rpcs.sql, business_invitation_rpcs.sql).
-- assigned_by must never be spoofable by a client-supplied value.

revoke all on public.business_member_branches from public, anon, authenticated, service_role;

grant select (
  id, business_id, member_id, branch_id, is_primary, assigned_by, assigned_at
) on public.business_member_branches to authenticated, service_role;

revoke references, trigger, truncate on public.business_member_branches from anon, authenticated;

-- Branch-access helper ---------------------------------------------------
--
-- Mirrors private.has_permission's exact shape and reasoning: derives
-- access entirely from trusted DB state (business_members +
-- business_member_branches + business_branches), never user_metadata, and
-- only ever returns true for a real, ACTIVE membership with a real
-- assignment row AGAINST A CURRENTLY-ACTIVE BRANCH backing it up — a
-- spoofed business_id/branch_id gains nothing. Deliberately a SEPARATE
-- concept from has_permission, not a replacement for it: future
-- branch-aware authorization is expected to combine
-- "has_permission(business_id, 'x.y') AND has_branch_access(business_id,
-- branch_id)", never one in place of the other. No branch-aware resource
-- exists yet in Phase 1F — this helper is the minimum foundation for a
-- future phase to build on, not itself wired into any table's RLS.
--
-- Codex adversarial review, Finding 1: the assignment ROW is deliberately
-- never deleted when its branch is later deactivated (see this file's own
-- header comment — "historical/admin visibility"), but that historical
-- row must NEVER confer operational access. Deactivating a branch must
-- immediately revoke has_branch_access for everyone assigned to it,
-- without needing to touch a single business_member_branches row — this
-- is why the branch's CURRENT status is joined and checked live on every
-- call, not cached or snapshotted anywhere.
create or replace function private.has_branch_access(p_business_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members bm
    join public.business_member_branches bmb
      on bmb.member_id = bm.id and bmb.business_id = bm.business_id
    join public.business_branches bb
      on bb.id = bmb.branch_id and bb.business_id = bm.business_id
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.status = 'active'
      and bmb.branch_id = p_branch_id
      and bb.status = 'ACTIVE'
  );
$$;

revoke all on function private.has_branch_access(uuid, uuid) from public;
grant execute on function private.has_branch_access(uuid, uuid) to authenticated;

-- Public, server-callable wrapper — mirrors public.has_permission exactly
-- (SECURITY INVOKER: does no privileged work of its own, only forwards to
-- the already-narrowly-scoped DEFINER helper above).
create or replace function public.has_branch_access(p_business_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.has_branch_access(p_business_id, p_branch_id);
$$;

revoke all on function public.has_branch_access(uuid, uuid) from public, anon;
grant execute on function public.has_branch_access(uuid, uuid) to authenticated, service_role;
