-- Automatic OWNER membership, and concurrency-safe protection against
-- ever leaving a business with zero owners. Both live here because they
-- are two sides of the same invariant: "every business has at least one
-- active OWNER, from the moment it exists, for as long as it exists."
--
-- Both functions are SECURITY DEFINER because business_members has forced
-- RLS and, by design (previous migration), `authenticated` has no
-- INSERT/UPDATE/DELETE policy on it at all in Phase 1 — these triggers are
-- the only path that may write to it. Narrow surface: neither function
-- takes caller-supplied input beyond the row already being written by the
-- triggering statement, and neither is reachable except through the
-- trigger on businesses/business_members.

-- Fires after a business row is inserted and creates its OWNER membership
-- in the same statement/transaction, so a business can never exist without
-- an owner: either both inserts commit, or (e.g. because the OWNER role
-- somehow isn't seeded) neither does.
create or replace function private.create_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_role_id uuid;
begin
  select id into v_owner_role_id from public.roles where name = 'OWNER';

  if v_owner_role_id is null then
    raise exception 'OWNER role is not seeded';
  end if;

  insert into public.business_members (business_id, user_id, role_id, status)
  values (new.id, new.created_by, v_owner_role_id, 'active');

  return new;
end;
$$;

revoke all on function private.create_owner_membership() from public;

create trigger businesses_create_owner_membership
  after insert on public.businesses
  for each row
  execute function private.create_owner_membership();

-- Fires before any update or delete on business_members and blocks the
-- change if it would remove the last active OWNER of a business.
--
-- Concurrency safety: two simultaneous requests each removing a different
-- owner of the same business could both count "1 other active owner
-- remaining" and both proceed, leaving zero. pg_advisory_xact_lock keyed on
-- the business_id serializes owner-affecting writes for that one business
-- (unrelated businesses are unaffected) — the second transaction blocks
-- until the first commits or rolls back, then re-reads a count that
-- reflects the first transaction's outcome. The lock is transaction-scoped
-- and releases automatically at commit/rollback.
--
-- Skips entirely when the business itself no longer exists: business_id's
-- ON DELETE CASCADE means deleting a business deletes its business_members
-- rows too, including its last owner — that cascade is not "removing the
-- last owner of a business" in the sense this trigger protects against,
-- since there's no business left to protect. Without this check, every
-- businesses DELETE would fail (the cascade always removes the deleted
-- business's last owner alongside it), making the businesses_delete RLS
-- policy from a later migration permanently unusable.
--
-- Fails closed if the OWNER role can't be resolved (renamed or deleted —
-- only reachable by an already-privileged writer, since `authenticated`
-- has no write grant on `roles` at all): every UPDATE/DELETE on an
-- existing business's members is refused outright, rather than silently
-- treating "we don't know what OWNER means right now" as "nothing here is
-- an owner, so nothing is protected." A broken security invariant must
-- block the operations it can no longer reason about, not wave them
-- through — the same principle private.create_owner_membership already
-- applies on the creation side.
create or replace function private.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_role_id     uuid;
  v_business_id       uuid;
  v_remaining_owners  int;
  v_removes_ownership boolean;
begin
  v_business_id := old.business_id;

  if not exists (select 1 from public.businesses where id = v_business_id) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select id into v_owner_role_id from public.roles where name = 'OWNER';

  if v_owner_role_id is null then
    raise exception 'OWNER role is not seeded';
  end if;

  -- Only an active OWNER row leaving the "active OWNER" state is
  -- interesting; anything else (a non-owner row, or an owner row that
  -- was already inactive) can't reduce the active-owner count. Note: NEW
  -- does not exist on DELETE, so this check — and every return below —
  -- must branch on tg_op before touching NEW.
  if old.role_id is distinct from v_owner_role_id or old.status <> 'active' then
    v_removes_ownership := false;
  elsif tg_op = 'DELETE' then
    v_removes_ownership := true;
  else
    v_removes_ownership := new.role_id is distinct from v_owner_role_id
      or new.status <> 'active';
  end if;

  if v_removes_ownership then
    perform pg_advisory_xact_lock(hashtextextended(v_business_id::text, 0));

    select count(*) into v_remaining_owners
    from public.business_members
    where business_id = v_business_id
      and role_id = v_owner_role_id
      and status = 'active'
      and id <> old.id;

    if v_remaining_owners = 0 then
      raise exception 'cannot remove the last owner of a business'
        using errcode = '23514'; -- check_violation
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.protect_last_owner() from public;

create trigger business_members_protect_last_owner
  before update or delete on public.business_members
  for each row
  execute function private.protect_last_owner();
