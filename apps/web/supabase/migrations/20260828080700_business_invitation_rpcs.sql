-- Phase 1F: invitation RPCs.
--
-- Idempotent creation, following private.customer_creation_requests'
-- proven design exactly: the arbiter is a dedicated request-ledger row's
-- INSERT ... ON CONFLICT DO NOTHING, never a comparison against
-- business_invitations' own (later-editable) current values. A retry of
-- the exact original request, even after the invitation has since
-- expired or been revoked, resolves to the SAME invitation_id via the
-- STORED original canonical payload.

create table private.business_invitation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  invitation_id     uuid references public.business_invitations (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.business_invitation_requests enable row level security;
alter table private.business_invitation_requests force row level security;

revoke all on private.business_invitation_requests from public, anon, authenticated, service_role;

-- current_verified_email ----------------------------------------------------
--
-- This is the ONLY place in the schema that reads auth.users directly.
-- Deliberately stays owned by `postgres` (no ALTER FUNCTION ... OWNER TO
-- anywhere below) rather than being transferred to a new narrow role: as
-- create_business_rpc.sql's own private.current_uid() comment documents,
-- `postgres` (the role every migration runs as) holds USAGE on the `auth`
-- schema WITHOUT GRANT OPTION, so it cannot extend auth-schema access to
-- ANY new role it creates — attempting to GRANT SELECT on auth.users to a
-- custom role produces a silent no-op, not an error. Remaining owned by
-- `postgres` sidesteps that limitation entirely: `postgres` already has
-- direct SELECT on auth.users (confirmed against the local instance), so
-- this function's own SECURITY DEFINER body can read it, and any OTHER
-- SECURITY DEFINER function (even one owned by a different, narrower
-- role) can safely CALL this one via an explicit EXECUTE grant — nested
-- SECURITY DEFINER calls each execute under their own definer role for
-- the duration of their own body, so private_invitation_acceptor never
-- itself needs auth-schema access.
--
-- Returns the caller's own email ONLY IF it is actually confirmed
-- (auth.users.email_confirmed_at is not null) — the authoritative
-- verification signal, not the JWT's `email` claim (which mirrors
-- auth.users.email regardless of confirmation state) and never
-- user_metadata.email_verified (client-editable, and explicitly called
-- out as unsafe to authorize on — private_authorization_helpers.sql).
-- Takes no parameters and resolves the caller's own uid internally,
-- exactly like private.is_business_member — there is no legitimate
-- reason for any caller to ask for a DIFFERENT user's email, so no
-- parameter exists through which one could.
create or replace function private.current_verified_email()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid;
  v_email text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    return null;
  end if;

  select email into v_email
  from auth.users
  where id = v_uid and email_confirmed_at is not null;

  return lower(btrim(v_email));
end;
$$;

revoke all on function private.current_verified_email() from public, anon, authenticated;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_invitation_writer's table grants as a quick fix │
-- │ for some other function's privilege problem; give that function its  │
-- │ own dedicated minimal role instead.                                  │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invitation_writer') then
    create role private_invitation_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invitation_writer to postgres;

grant usage on schema public to private_invitation_writer;
grant usage on schema private to private_invitation_writer;

-- email is included specifically because the lazy-expire UPDATE's own
-- WHERE clause references it (business_id = ... and email = ... and
-- status = 'PENDING' and expires_at <= now()) — a WHERE-clause column
-- needs SELECT privilege exactly like a SELECT-list column does.
grant select (id, business_id, email, status, expires_at, role_id)
  on public.business_invitations to private_invitation_writer;
grant insert (business_id, email, role_id, expires_at, invited_by, creation_key)
  on public.business_invitations to private_invitation_writer;
grant update (status, revoked_by, revoked_at)
  on public.business_invitations to private_invitation_writer;

grant select (id) on public.business_invitation_branches to private_invitation_writer;
grant insert (business_id, invitation_id, branch_id, is_primary)
  on public.business_invitation_branches to private_invitation_writer;

grant select (id, business_id, status)
  on public.business_branches to private_invitation_writer;

grant select (id, name) on public.roles to private_invitation_writer;

grant select (id, business_id, user_id, role_id, status)
  on public.business_members to private_invitation_writer;

-- Codex adversarial review, Finding 7: narrowed from a table-wide
-- SELECT/INSERT grant to exactly the columns create_business_invitation's
-- own body reads/writes — business_id/creation_key are the WHERE-clause
-- lookup key (and part of the INSERT's own target list); canonical_payload
-- and invitation_id are the only two columns ever read back (see the
-- explicit column list in the REPLAY DECISION step below — never
-- `select *`). created_at is written only via its own column default and
-- never read, so no privilege is granted for it at all.
grant select (business_id, creation_key, canonical_payload, invitation_id)
  on private.business_invitation_requests to private_invitation_writer;
grant insert (business_id, creation_key, canonical_payload)
  on private.business_invitation_requests to private_invitation_writer;
grant update (invitation_id) on private.business_invitation_requests to private_invitation_writer;

grant execute on function private.current_uid() to private_invitation_writer;
grant execute on function private.has_permission(uuid, text) to private_invitation_writer;

-- create_business_invitation -------------------------------------------------

create or replace function public.create_business_invitation(
  p_business_id        uuid,
  p_creation_key       uuid,
  p_email              text,
  p_role               text,
  p_branch_ids         jsonb default '[]'::jsonb,
  p_primary_branch_id  uuid default null
)
returns uuid  -- invitation_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_caller_role        text;
  v_email              text;
  v_role_id            uuid;
  v_raw_id             jsonb;
  v_branch_id_text     text;
  v_branch_id          uuid;
  v_branch_ids         uuid[] := array[]::uuid[];
  v_max_branches       constant int := 50;
  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_invitation_id uuid;
  v_invitation_id      uuid;
  v_status             text;
  v_found_business_id  uuid;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_email is null or p_role is null then
    raise exception 'p_business_id, p_creation_key, p_email, and p_role are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, always safe to re-check
  -- on every call, replay or not.
  if not private.has_permission(p_business_id, 'staff.invite') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY — before the idempotency
  -- claim, so the claim's canonical payload is always built from
  -- already-validated, normalized values.
  v_email := lower(btrim(p_email));
  if v_email is null or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'INVALID_INVITATION_EMAIL' using errcode = '22023';
  end if;

  select id into v_role_id from public.roles where name = p_role;
  if v_role_id is null then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  -- Hierarchy: only an OWNER caller may invite as OWNER. This is the
  -- caller's OWN role, never mutable target state, so it is always safe
  -- to re-check on every call.
  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  if p_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_ASSIGN_OWNER_ROLE' using errcode = '42501';
  end if;

  -- Codex adversarial review, Finding 3 — LOCKED INVARIANT: every
  -- invitation must carry at least one branch and exactly one primary
  -- among them, mirroring replace_member_branches' own identical
  -- invariant exactly (an accepted invitation becomes a member, and a
  -- member is never allowed to end up with zero branches/zero primary —
  -- see business_member_branches' own header comment). An empty branch
  -- list, or a nonempty one with no (or an out-of-set) primary, is
  -- rejected outright, before the idempotency claim.
  if jsonb_typeof(p_branch_ids) is distinct from 'array' then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) = 0 then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) > v_max_branches then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if p_primary_branch_id is null then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  for v_raw_id in select * from jsonb_array_elements(p_branch_ids)
  loop
    if jsonb_typeof(v_raw_id) is distinct from 'string' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id_text := v_raw_id #>> '{}';
    if v_branch_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id := v_branch_id_text::uuid;
    if v_branch_id = any(v_branch_ids) then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_ids := array_append(v_branch_ids, v_branch_id);
  end loop;

  if p_primary_branch_id is not null and not (p_primary_branch_id = any(v_branch_ids)) then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — role_id (not the role name text,
  -- so a future role rename can never falsely conflict with an
  -- already-issued request), the sorted branch id set, and the primary
  -- branch. Never includes expires_at (server-derived, not caller
  -- intent) or status/invited_by (internal/computed).
  select jsonb_agg(to_jsonb(x) order by x) into v_canonical_payload
  from unnest(v_branch_ids) as x;

  v_canonical_payload := jsonb_build_object(
    'email', v_email,
    'role_id', v_role_id::text,
    'branch_ids', coalesce(v_canonical_payload, '[]'::jsonb),
    'primary_branch_id', p_primary_branch_id::text
  );

  -- 4) CLAIM
  insert into private.business_invitation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about current invitation/branch state
    -- has been consulted before this point. Explicit column list (never
    -- `select *`), matching the role's own narrowed SELECT grant above.
    select canonical_payload, invitation_id into v_stored_payload, v_stored_invitation_id
    from private.business_invitation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'INVITATION_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_invitation_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.

  -- Lazily materialize EXPIRED for any stale PENDING invitation blocking
  -- this exact (business, email) pair — no cron: this only ever runs as
  -- a side effect of a real create_business_invitation call, which is
  -- exactly the moment a stale pending invitation would otherwise
  -- incorrectly block a fresh one. accept_business_invitation
  -- independently treats a PENDING-but-expired row as expired too,
  -- regardless of whether this lazy transition has run yet.
  update public.business_invitations
  set status = 'EXPIRED'
  where business_id = p_business_id and email = v_email
    and status = 'PENDING' and expires_at <= now();

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

  begin
    -- Server-authoritative expiry — the caller never chooses this.
    insert into public.business_invitations
      (business_id, email, role_id, expires_at, invited_by, creation_key)
    values
      (p_business_id, v_email, v_role_id, now() + interval '7 days', v_uid, p_creation_key)
    returning id into v_invitation_id;
  exception
    when unique_violation then
      raise exception 'INVITATION_ALREADY_PENDING' using errcode = '23505';
  end;

  for v_branch_id in select unnest(v_branch_ids)
  loop
    -- p_primary_branch_id is proven NOT NULL above, so this comparison
    -- is never itself NULL (see replace_member_branches' identical
    -- comment on the equivalent line for the full SQL-NULL reasoning).
    insert into public.business_invitation_branches (business_id, invitation_id, branch_id, is_primary)
    values (p_business_id, v_invitation_id, v_branch_id, v_branch_id = p_primary_branch_id);
  end loop;

  update private.business_invitation_requests set invitation_id = v_invitation_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_invitation_id;
end;
$$;

-- revoke_business_invitation -------------------------------------------------

create or replace function public.revoke_business_invitation(
  p_business_id    uuid,
  p_invitation_id  uuid
)
returns uuid  -- invitation_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid           uuid;
  v_caller_role   text;
  v_found_id      uuid;
  v_status        text;
  v_target_role   text;
  v_expires_at    timestamptz;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_invitation_id is null then
    raise exception 'p_business_id and p_invitation_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'staff.invite') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select bi.id, bi.status, bi.expires_at, r.name
  into v_found_id, v_status, v_expires_at, v_target_role
  from public.business_invitations bi
  join public.roles r on r.id = bi.role_id
  where bi.id = p_invitation_id and bi.business_id = p_business_id
  for update of bi;

  if v_found_id is null then
    raise exception 'INVITATION_NOT_FOUND' using errcode = '22023';
  end if;

  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  if v_target_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_MANAGE_OWNER' using errcode = '42501';
  end if;

  if v_status = 'ACCEPTED' then
    raise exception 'INVITATION_ALREADY_ACCEPTED' using errcode = '23514';
  end if;
  if v_status = 'REVOKED' then
    raise exception 'INVITATION_REVOKED' using errcode = '23514';
  end if;
  -- Only an effective (non-expired) PENDING invitation may be revoked —
  -- an already-due-to-expire row is treated identically to a
  -- materialized EXPIRED one, regardless of whether the lazy transition
  -- (create_business_invitation's own opportunistic step) has run yet.
  if v_status = 'EXPIRED' or v_expires_at <= now() then
    raise exception 'INVITATION_EXPIRED' using errcode = '23514';
  end if;

  update public.business_invitations
  set status = 'REVOKED', revoked_by = v_uid, revoked_at = now()
  where id = p_invitation_id and business_id = p_business_id and status = 'PENDING';

  return p_invitation_id;
end;
$$;

grant create on schema public to private_invitation_writer;
alter function public.create_business_invitation(uuid, uuid, text, text, jsonb, uuid)
  owner to private_invitation_writer;
alter function public.revoke_business_invitation(uuid, uuid) owner to private_invitation_writer;
revoke create on schema public from private_invitation_writer;

revoke all on function public.create_business_invitation(uuid, uuid, text, text, jsonb, uuid)
  from public, anon, service_role;
revoke all on function public.revoke_business_invitation(uuid, uuid) from public, anon, service_role;

grant execute on function public.create_business_invitation(uuid, uuid, text, text, jsonb, uuid)
  to authenticated;
grant execute on function public.revoke_business_invitation(uuid, uuid) to authenticated;

-- accept_business_invitation --------------------------------------------------
--
-- Security-critical: this is the ONLY path that turns an invitation into
-- real business membership, and it runs for a caller who is, by
-- definition, NOT YET a member of the target business — every other RPC
-- in this schema authorizes via private.has_permission (which requires an
-- existing active membership); this one cannot. Its authorization is
-- entirely different: possession of a valid session for the SPECIFIC,
-- Auth-server-CONFIRMED email address the invitation was issued to.
--
-- Deliberately single-argument (just the invitation id) — unlike every
-- other RPC in this schema, it does not take a business_id, because the
-- caller has no business-scoped standing to assert one; the invitation
-- row itself is the sole source of which business this concerns. The
-- invitee cannot influence role, branches, business, or email during
-- acceptance — every one of those is read from the frozen invitation row
-- (and, for email, from the trusted Auth identity), never from a
-- parameter.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invitation_acceptor') then
    create role private_invitation_acceptor noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invitation_acceptor to postgres;

grant usage on schema public to private_invitation_acceptor;
grant usage on schema private to private_invitation_acceptor;

grant select (id, business_id, email, role_id, status, expires_at)
  on public.business_invitations to private_invitation_acceptor;
grant update (status, accepted_by, accepted_at)
  on public.business_invitations to private_invitation_acceptor;

grant select (id, invitation_id, branch_id, is_primary)
  on public.business_invitation_branches to private_invitation_acceptor;

-- Codex adversarial review, Finding 1: acceptance now re-validates every
-- invited branch's CURRENT status, locked FOR SHARE for the duration of
-- this transaction. FOR SHARE requires UPDATE privilege on the table
-- (confirmed against this project's own create_sale/private_sale_writer
-- precedent — "Postgres's FOR SHARE row-locking clause requires UPDATE
-- privilege on the table, which a column-level grant satisfies") — narrowed
-- to created_by specifically because that column is ALSO independently
-- protected by business_branches' own
-- enforce_business_branch_immutable_fields trigger, so this grant is
-- structurally incapable of ever actually changing a branch even though
-- it satisfies the locking requirement. This role never performs a real
-- UPDATE against business_branches.
grant select (id, business_id, status) on public.business_branches to private_invitation_acceptor;
grant update (created_by) on public.business_branches to private_invitation_acceptor;

grant select (id, business_id, user_id) on public.business_members to private_invitation_acceptor;
grant insert (business_id, user_id, role_id, status) on public.business_members to private_invitation_acceptor;

grant insert (business_id, member_id, branch_id, is_primary, assigned_by)
  on public.business_member_branches to private_invitation_acceptor;

grant execute on function private.current_uid() to private_invitation_acceptor;
grant execute on function private.current_verified_email() to private_invitation_acceptor;

create or replace function public.accept_business_invitation(
  p_invitation_id uuid
)
returns uuid  -- business_id ONLY — the minimal result useful for routing
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid              uuid;
  v_verified_email   text;
  v_business_id      uuid;
  v_email            text;
  v_role_id          uuid;
  v_status           text;
  v_expires_at       timestamptz;
  v_already_member   boolean;
  v_member_id        uuid;
  v_branch_check     record;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_invitation_id is null then
    raise exception 'p_invitation_id is required' using errcode = '22023';
  end if;

  -- Locked for the duration of this transaction — a concurrent second
  -- acceptance attempt of the SAME invitation blocks here until this one
  -- commits or rolls back, then re-reads the now-ACCEPTED (or
  -- rolled-back-PENDING) status and resolves correctly, never racing to
  -- create two memberships.
  select business_id, email, role_id, status, expires_at
  into v_business_id, v_email, v_role_id, v_status, v_expires_at
  from public.business_invitations
  where id = p_invitation_id
  for update;

  -- Codex adversarial review, Finding 6: identity is established BEFORE
  -- any lifecycle-specific detail is ever revealed. A nonexistent
  -- invitation id and a real invitation issued to a DIFFERENT email both
  -- resolve to the exact same generic INVITATION_NOT_FOUND here — an
  -- authenticated caller who happens to know (or guess) a real
  -- invitation UUID that isn't theirs learns NOTHING about whether it
  -- exists, or whether it's pending/accepted/revoked/expired. Only once
  -- the caller's own Auth-confirmed email matches the invitation's email
  -- exactly does this function proceed to reveal anything status-specific.
  if v_business_id is null then
    raise exception 'INVITATION_NOT_FOUND' using errcode = '22023';
  end if;

  -- 2/3) DERIVE IDENTITY FROM TRUSTED AUTH STATE — never the caller's own
  -- say-so. private.current_verified_email() returns null for "email not
  -- yet confirmed", which safely fails the match below rather than being
  -- special-cased. Deliberately the SAME error as "row doesn't exist" —
  -- see the comment above.
  v_verified_email := private.current_verified_email();
  if v_verified_email is null or v_verified_email <> v_email then
    raise exception 'INVITATION_NOT_FOUND' using errcode = '22023';
  end if;

  -- Only NOW, with identity established, are lifecycle-specific states
  -- revealed — safe at this point because the caller has already proven
  -- they ARE the intended recipient.
  if v_status = 'REVOKED' then
    raise exception 'INVITATION_REVOKED' using errcode = '23514';
  end if;
  if v_status = 'ACCEPTED' then
    raise exception 'INVITATION_ALREADY_ACCEPTED' using errcode = '23514';
  end if;
  if v_status = 'EXPIRED' or v_expires_at <= now() then
    raise exception 'INVITATION_EXPIRED' using errcode = '23514';
  end if;

  select exists (
    select 1 from public.business_members where business_id = v_business_id and user_id = v_uid
  ) into v_already_member;
  if v_already_member then
    raise exception 'ALREADY_BUSINESS_MEMBER' using errcode = '23505';
  end if;

  -- Codex adversarial review, Finding 1: re-validate every invited
  -- branch's CURRENT status before writing anything — a branch
  -- deactivated between invite and accept must never silently grant (or
  -- appear to grant) operational access. Locked FOR SHARE so a
  -- concurrent deactivation blocks until this transaction resolves, then
  -- correctly re-reads the final committed state. ANY invited branch
  -- failing this check fails the ENTIRE acceptance atomically — nothing
  -- has been written yet at this point (no membership, no branch
  -- assignment), so there is no partial-completion state to roll back
  -- from; the transaction simply never commits anything.
  for v_branch_check in
    select bb.status
    from public.business_invitation_branches ib
    join public.business_branches bb
      on bb.id = ib.branch_id and bb.business_id = v_business_id
    where ib.invitation_id = p_invitation_id
    for share of bb
  loop
    if v_branch_check.status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
    end if;
  end loop;

  -- 10/11) CREATE MEMBERSHIP with the FROZEN invited role — never a
  -- caller-influenced value; there is no parameter through which one
  -- could reach this function at all.
  insert into public.business_members (business_id, user_id, role_id, status)
  values (v_business_id, v_uid, v_role_id, 'active')
  returning id into v_member_id;

  -- 12/13) COPY the invitation's own frozen branch assignments (which
  -- branch ids, and which one is primary, are exactly what was frozen at
  -- invite time) — every branch just re-validated ACTIVE above, so this
  -- insert cannot fail on that account.
  insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
  select v_business_id, v_member_id, ib.branch_id, ib.is_primary, v_uid
  from public.business_invitation_branches ib
  where ib.invitation_id = p_invitation_id;

  -- 14/15) MARK ACCEPTED. The WHERE clause re-asserts status = 'PENDING'
  -- as belt and suspenders on top of the FOR UPDATE lock already taken
  -- above — this UPDATE can only ever match the exact row already
  -- validated and locked in this same transaction.
  update public.business_invitations
  set status = 'ACCEPTED', accepted_by = v_uid, accepted_at = now()
  where id = p_invitation_id and status = 'PENDING';

  return v_business_id;
end;
$$;

grant create on schema public to private_invitation_acceptor;
alter function public.accept_business_invitation(uuid) owner to private_invitation_acceptor;
revoke create on schema public from private_invitation_acceptor;

revoke all on function public.accept_business_invitation(uuid) from public, anon, service_role;
grant execute on function public.accept_business_invitation(uuid) to authenticated;
