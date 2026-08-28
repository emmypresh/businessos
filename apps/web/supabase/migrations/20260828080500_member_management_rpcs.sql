-- Phase 1F: staff-management RPCs.
--
-- public.business_members has no UPDATE policy for `authenticated` at
-- all (Phase 1) — role changes and suspend/reactivate are the first
-- writes to that table `authenticated` can trigger, and they go through
-- these narrowly-scoped functions only, never a direct
-- `.from('business_members').update(...)`. Every one of the four
-- functions below independently re-derives and re-checks the caller's own
-- hierarchy standing on every call — never trusts a client-supplied
-- "I am an owner" claim.
--
-- Hierarchy rules (every function below applies these identically):
--   - Only staff.manage holders (OWNER/ADMIN per the seeded matrix) may
--     call any of these at all.
--   - A caller may never target their OWN membership row through these
--     functions (CANNOT_MANAGE_SELF) — self-service role/status changes
--     are out of scope for Phase 1F and this closes any self-promotion or
--     accidental self-lockout path outright, not merely discourages it.
--   - A caller who is not OWNER may never target a member whose CURRENT
--     role is OWNER (CANNOT_MANAGE_OWNER) — ADMIN cannot demote, suspend,
--     reactivate, or reassign branches for an OWNER.
--   - A caller who is not OWNER may never assign the OWNER role to
--     anyone (CANNOT_ASSIGN_OWNER_ROLE).
--   - The existing private.protect_last_owner trigger (Phase 1) remains
--     the final, structural authority on "never leave zero active
--     owners" — these functions do not reimplement that check; they let
--     the trigger's own check_violation surface, caught here and
--     re-raised as the stable LAST_OWNER_REQUIRED code so the public
--     contract does not depend on that trigger's exact English wording.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_staff_writer') then
    create role private_staff_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_staff_writer to postgres;

grant usage on schema public to private_staff_writer;
grant usage on schema private to private_staff_writer;

grant select (id, business_id, user_id, role_id, status)
  on public.business_members to private_staff_writer;
grant update (role_id, status) on public.business_members to private_staff_writer;

grant select (id, name) on public.roles to private_staff_writer;

grant select (id, business_id, status) on public.business_branches to private_staff_writer;

-- is_primary is included in the SELECT grant (not just INSERT/UPDATE)
-- specifically because `ON CONFLICT (member_id, branch_id) DO UPDATE SET
-- is_primary = excluded.is_primary` requires SELECT privilege on any
-- column named in its SET target list, in addition to UPDATE — confirmed
-- empirically against the real local Data API (a grant with UPDATE
-- (is_primary) but no matching SELECT still failed with a bare
-- "permission denied for table" on this exact statement).
grant select (id, business_id, member_id, branch_id, is_primary)
  on public.business_member_branches to private_staff_writer;
grant insert (business_id, member_id, branch_id, is_primary, assigned_by)
  on public.business_member_branches to private_staff_writer;
grant update (is_primary) on public.business_member_branches to private_staff_writer;
grant delete on public.business_member_branches to private_staff_writer;

grant execute on function private.current_uid() to private_staff_writer;
grant execute on function private.has_permission(uuid, text) to private_staff_writer;

-- change_member_role -------------------------------------------------------

create or replace function public.change_member_role(
  p_business_id uuid,
  p_member_id   uuid,
  p_role        text
)
returns uuid  -- member_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid              uuid;
  v_caller_role      text;
  v_target_user_id   uuid;
  v_target_role      text;
  v_new_role_id      uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_member_id is null or p_role is null then
    raise exception 'p_business_id, p_member_id, and p_role are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  -- status is deliberately not read here: a role change is allowed
  -- regardless of the target's current active/suspended status (e.g.
  -- correcting a role before reactivating someone), unlike suspend/
  -- reactivate, which each have their own explicit status preconditions.
  select bm.user_id, r.name
  into v_target_user_id, v_target_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.id = p_member_id and bm.business_id = p_business_id
  for update of bm;

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
  end if;
  if v_target_user_id = v_uid then
    raise exception 'CANNOT_MANAGE_SELF' using errcode = '23514';
  end if;
  if v_target_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_MANAGE_OWNER' using errcode = '42501';
  end if;
  if p_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_ASSIGN_OWNER_ROLE' using errcode = '42501';
  end if;

  select id into v_new_role_id from public.roles where name = p_role;
  if v_new_role_id is null then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  begin
    update public.business_members set role_id = v_new_role_id
    where id = p_member_id and business_id = p_business_id;
  exception
    when check_violation then
      raise exception 'LAST_OWNER_REQUIRED' using errcode = '23514';
  end;

  return p_member_id;
end;
$$;

-- suspend_member / reactivate_member ---------------------------------------

create or replace function public.suspend_member(
  p_business_id uuid,
  p_member_id   uuid
)
returns uuid  -- member_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid             uuid;
  v_caller_role     text;
  v_target_user_id  uuid;
  v_target_role     text;
  v_target_status   text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_member_id is null then
    raise exception 'p_business_id and p_member_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  select bm.user_id, r.name, bm.status
  into v_target_user_id, v_target_role, v_target_status
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.id = p_member_id and bm.business_id = p_business_id
  for update of bm;

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = '22023';
  end if;
  if v_target_user_id = v_uid then
    raise exception 'CANNOT_MANAGE_SELF' using errcode = '23514';
  end if;
  if v_target_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_MANAGE_OWNER' using errcode = '42501';
  end if;
  if v_target_status = 'suspended' then
    raise exception 'MEMBER_ALREADY_SUSPENDED' using errcode = '23514';
  end if;
  if v_target_status <> 'active' then
    raise exception 'MEMBER_NOT_FOUND' using errcode = '22023';  -- invited/removed: not an operational member to suspend
  end if;

  begin
    update public.business_members set status = 'suspended'
    where id = p_member_id and business_id = p_business_id;
  exception
    when check_violation then
      raise exception 'LAST_OWNER_REQUIRED' using errcode = '23514';
  end;

  return p_member_id;
end;
$$;

create or replace function public.reactivate_member(
  p_business_id uuid,
  p_member_id   uuid
)
returns uuid  -- member_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid             uuid;
  v_caller_role     text;
  v_target_user_id  uuid;
  v_target_role     text;
  v_target_status   text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_member_id is null then
    raise exception 'p_business_id and p_member_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  select bm.user_id, r.name, bm.status
  into v_target_user_id, v_target_role, v_target_status
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.id = p_member_id and bm.business_id = p_business_id
  for update of bm;

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = '22023';
  end if;
  -- A suspended OWNER can only ever have been suspended by another
  -- OWNER (suspend_member's own CANNOT_MANAGE_OWNER check guarantees
  -- this), but this check is repeated here independently rather than
  -- assumed — reactivate is its own authorization boundary.
  if v_target_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_MANAGE_OWNER' using errcode = '42501';
  end if;
  if v_target_status <> 'suspended' then
    raise exception 'MEMBER_NOT_SUSPENDED' using errcode = '23514';
  end if;

  update public.business_members set status = 'active'
  where id = p_member_id and business_id = p_business_id;

  return p_member_id;
end;
$$;

-- replace_member_branches ---------------------------------------------------
--
-- Wholesale replacement, not an incremental add/remove — the caller
-- always sends the COMPLETE target set of branch ids (and which one, if
-- any, is primary), and this function makes that the new, exact state:
-- existing assignment rows not in the new set are deleted, rows in the
-- new set are (re)inserted fresh. This is what makes a retry of the exact
-- same call deterministic (§ approved plan) — replaying an identical
-- request always converges to the identical end state, never
-- accumulating duplicate or stale rows. Deliberately NOT
-- idempotency-ledgered like a creation RPC: this operation has no
-- "created once, must never re-create" resource of its own to protect —
-- it fully overwrites in place every time, which needs no separate replay
-- detection.

create or replace function public.replace_member_branches(
  p_business_id        uuid,
  p_member_id          uuid,
  p_branch_ids         jsonb,
  p_primary_branch_id  uuid default null
)
returns uuid  -- member_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid              uuid;
  v_caller_role      text;
  v_target_user_id   uuid;
  v_target_role      text;
  v_raw_id           jsonb;
  v_branch_id_text   text;
  v_branch_id        uuid;
  v_branch_ids       uuid[] := array[]::uuid[];
  v_max_branches     constant int := 50;
  v_status           text;
  v_found_business_id uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_member_id is null or p_branch_ids is null then
    raise exception 'p_business_id, p_member_id, and p_branch_ids are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  -- status is deliberately not read here — branch assignments may be
  -- prepared/replaced regardless of the target's current active/
  -- suspended status, matching change_member_role's own treatment.
  select bm.user_id, r.name
  into v_target_user_id, v_target_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.id = p_member_id and bm.business_id = p_business_id
  for update of bm;

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = '22023';
  end if;
  -- Codex adversarial review, Finding 2: self-targeting was previously
  -- allowed here even though every OTHER staff-management action in this
  -- file (change_member_role, suspend_member) already refuses it — an
  -- inconsistency, not a deliberate exception. No caller, OWNER or
  -- ADMIN, may replace their OWN branch assignments through this RPC.
  if v_target_user_id = v_uid then
    raise exception 'CANNOT_MANAGE_SELF' using errcode = '23514';
  end if;
  if v_target_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_MANAGE_OWNER' using errcode = '42501';
  end if;

  -- NORMALIZE + VALIDATE INPUT SHAPE ONLY.
  --
  -- Codex adversarial review, Finding 3 — LOCKED INVARIANT: every call to
  -- this RPC must leave the target member with at least one branch
  -- assignment and exactly one primary among them, regardless of the
  -- target's current active/suspended status (a single consistent rule,
  -- rather than a status-conditional one, per the review's own
  -- preference). An empty branch list, or a nonempty one with no (or an
  -- out-of-set) primary, is rejected outright — there is no RPC-reachable
  -- path that leaves a member with zero assignments or zero primaries.
  if jsonb_typeof(p_branch_ids) is distinct from 'array' then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) = 0 then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';  -- every member needs >= 1 branch
  end if;
  if jsonb_array_length(p_branch_ids) > v_max_branches then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if p_primary_branch_id is null then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';  -- exactly one primary is mandatory
  end if;

  for v_raw_id in select * from jsonb_array_elements(p_branch_ids)
  loop
    if jsonb_typeof(v_raw_id) is distinct from 'string' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id_text := v_raw_id#>>'{}';
    if v_branch_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id := v_branch_id_text::uuid;
    if v_branch_id = any(v_branch_ids) then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';  -- duplicate in the caller's own set
    end if;
    v_branch_ids := array_append(v_branch_ids, v_branch_id);
  end loop;

  if p_primary_branch_id is not null and not (p_primary_branch_id = any(v_branch_ids)) then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';  -- primary must be in the assigned set
  end if;

  -- Every branch in the set must be a real, ACTIVE, same-tenant branch.
  -- Scoped directly in the WHERE clause — a foreign-tenant branch is
  -- never loaded at all, not loaded-then-compared.
  for v_branch_id in select unnest(v_branch_ids)
  loop
    select business_id, status into v_found_business_id, v_status
    from public.business_branches
    where id = v_branch_id and business_id = p_business_id;

    if v_found_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
    if v_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
    end if;
  end loop;

  -- Wholesale replace: delete every existing assignment for this member
  -- not in the new set, then insert the new set fresh. Both statements
  -- run in this function's one transaction — no intermediate state is
  -- ever observable outside it.
  delete from public.business_member_branches
  where member_id = p_member_id
    and business_id = p_business_id
    and not (branch_id = any(v_branch_ids));

  for v_branch_id in select unnest(v_branch_ids)
  loop
    insert into public.business_member_branches
      (business_id, member_id, branch_id, is_primary, assigned_by)
    values
      -- p_primary_branch_id is proven NOT NULL above, so this comparison
      -- is never itself NULL (SQL's `x = NULL` — always NULL, never
      -- false — is exactly the trap a genuinely-nullable primary would
      -- hit here; that case is rejected outright before this loop runs).
      (p_business_id, p_member_id, v_branch_id, v_branch_id = p_primary_branch_id, v_uid)
    on conflict (member_id, branch_id) do update
      set is_primary = excluded.is_primary;
  end loop;

  return p_member_id;
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface --------------------

grant create on schema public to private_staff_writer;
alter function public.change_member_role(uuid, uuid, text) owner to private_staff_writer;
alter function public.suspend_member(uuid, uuid) owner to private_staff_writer;
alter function public.reactivate_member(uuid, uuid) owner to private_staff_writer;
alter function public.replace_member_branches(uuid, uuid, jsonb, uuid) owner to private_staff_writer;
revoke create on schema public from private_staff_writer;

revoke all on function public.change_member_role(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.suspend_member(uuid, uuid) from public, anon, service_role;
revoke all on function public.reactivate_member(uuid, uuid) from public, anon, service_role;
revoke all on function public.replace_member_branches(uuid, uuid, jsonb, uuid) from public, anon, service_role;

grant execute on function public.change_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.suspend_member(uuid, uuid) to authenticated;
grant execute on function public.reactivate_member(uuid, uuid) to authenticated;
grant execute on function public.replace_member_branches(uuid, uuid, jsonb, uuid) to authenticated;
