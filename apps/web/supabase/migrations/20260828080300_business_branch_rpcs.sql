-- Phase 1F: branch mutation RPCs.
--
-- public.business_branches has no INSERT/UPDATE/DELETE policy for
-- `authenticated` at all (create_business_branches.sql) — every write
-- goes through one of the five functions below, each running under its
-- own narrowly-privileged role. Creation is idempotent, following
-- private.customer_creation_requests' proven design exactly: the arbiter
-- is a dedicated request-ledger row's INSERT ... ON CONFLICT DO NOTHING,
-- never a comparison against the branches table's own (later-editable)
-- current values.

create table private.business_branch_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  branch_id         uuid references public.business_branches (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.business_branch_creation_requests enable row level security;
alter table private.business_branch_creation_requests force row level security;

revoke all on private.business_branch_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the tables it's    │
-- │ granted on today. Never extend private_branch_writer's table grants  │
-- │ as a quick fix for some other function's privilege problem; give     │
-- │ that function its own dedicated minimal role instead.                │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_branch_writer') then
    create role private_branch_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_branch_writer to postgres;

grant usage on schema public to private_branch_writer;
grant usage on schema private to private_branch_writer;

-- Least-privilege: SELECT narrowed to exactly the columns any of the five
-- functions below read; UPDATE narrowed to exactly the columns any of
-- them write. updated_at is never listed — the existing
-- business_branches_set_updated_at trigger bumps it regardless of the
-- invoking role's own column grants (matching every other table's own
-- precedent).
grant select (
  id, business_id, name, code, is_default, status
) on public.business_branches to private_branch_writer;
grant insert (
  business_id, name, code, address_line1, address_line2, city, state,
  country_code, phone, created_by
) on public.business_branches to private_branch_writer;
grant update (
  name, code, address_line1, address_line2, city, state, country_code,
  phone, is_default, status
) on public.business_branches to private_branch_writer;

-- Codex adversarial review, Finding 7: narrowed from a table-wide
-- SELECT/INSERT grant to exactly the columns create_business_branch's
-- own body reads/writes — business_id/creation_key are the WHERE-clause
-- lookup key (and the INSERT's own target list); canonical_payload and
-- branch_id are the only two columns ever read back (see the explicit
-- column list in the REPLAY DECISION step below — never `select *`).
-- created_at is written only via its own column default and never read,
-- so no privilege is granted for it at all.
grant select (business_id, creation_key, canonical_payload, branch_id)
  on private.business_branch_creation_requests to private_branch_writer;
grant insert (business_id, creation_key, canonical_payload)
  on private.business_branch_creation_requests to private_branch_writer;
grant update (branch_id) on private.business_branch_creation_requests to private_branch_writer;

grant execute on function private.current_uid() to private_branch_writer;
grant execute on function private.has_permission(uuid, text) to private_branch_writer;
grant execute on function private.canonicalize_branch_name(text) to private_branch_writer;

-- create_business_branch --------------------------------------------------

create or replace function public.create_business_branch(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_name           text,
  p_code           text default null,
  p_address_line1  text default null,
  p_address_line2  text default null,
  p_city           text default null,
  p_state          text default null,
  p_country_code   text default 'NG',
  p_phone          text default null
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_name               text;
  v_code               text;
  v_address_line1      text;
  v_address_line2      text;
  v_city               text;
  v_state              text;
  v_country_code       text;
  v_phone              text;
  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_branch_id   uuid;
  v_branch_id          uuid;
  v_constraint         text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null then
    raise exception 'p_business_id and p_creation_key are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- NORMALIZE + VALIDATE INPUT SHAPE ONLY — every rule here mirrors
  -- business_branches' own CHECK constraints exactly, applied BEFORE the
  -- idempotency claim, so the claim's canonical payload is always built
  -- from already-validated, normalized values. Name is canonicalized
  -- (internal whitespace collapsed) BEFORE the length check, so the
  -- length bound applies to the exact form that gets persisted and
  -- compared for uniqueness — never the raw, pre-collapse string.
  v_name := private.canonicalize_branch_name(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'INVALID_BRANCH_NAME' using errcode = '22023';
  end if;

  -- Codes are validated, never whitespace-collapsed — an internal space
  -- is rejected outright (INVALID_BRANCH_CODE), matching the table's own
  -- CHECK exactly, so this never surfaces as a raw constraint violation
  -- for the common case.
  v_code := nullif(btrim(p_code), '');
  if v_code is not null and (length(v_code) > 20 or v_code ~ '[[:space:]]') then
    raise exception 'INVALID_BRANCH_CODE' using errcode = '22023';
  end if;

  v_address_line1 := nullif(btrim(p_address_line1), '');
  if v_address_line1 is not null and length(v_address_line1) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_address_line2 := nullif(btrim(p_address_line2), '');
  if v_address_line2 is not null and length(v_address_line2) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_city := nullif(btrim(p_city), '');
  if v_city is not null and length(v_city) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_state := nullif(btrim(p_state), '');
  if v_state is not null and length(v_state) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;

  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BRANCH_COUNTRY_CODE' using errcode = '22023';
  end if;

  v_phone := nullif(btrim(p_phone), '');
  if v_phone is not null and length(v_phone) > 32 then
    raise exception 'INVALID_BRANCH_PHONE' using errcode = '22023';
  end if;

  v_canonical_payload := jsonb_build_object(
    'name', v_name,
    'code', v_code,
    'address_line1', v_address_line1,
    'address_line2', v_address_line2,
    'city', v_city,
    'state', v_state,
    'country_code', v_country_code,
    'phone', v_phone
  );

  -- CLAIM
  insert into private.business_branch_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- REPLAY DECISION — no current-state validation consulted before
    -- this. Explicit column list (never `select *`), matching the
    -- role's own narrowed SELECT grant above.
    select canonical_payload, branch_id into v_stored_payload, v_stored_branch_id
    from private.business_branch_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'BRANCH_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_branch_id;
  end if;

  -- ONLY A NEWLY CLAIMED REQUEST REACHES HERE. New branches are never
  -- created as the default — public.set_default_business_branch is the
  -- only path that ever changes is_default.
  begin
    insert into public.business_branches (
      business_id, name, code, address_line1, address_line2, city, state,
      country_code, phone, created_by
    ) values (
      p_business_id, v_name, v_code, v_address_line1, v_address_line2, v_city, v_state,
      v_country_code, v_phone, v_uid
    )
    returning id into v_branch_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'business_branches_name_unique_idx' then
        raise exception 'BRANCH_NAME_ALREADY_EXISTS' using errcode = '23505';
      elsif v_constraint = 'business_branches_code_unique_idx' then
        raise exception 'BRANCH_CODE_ALREADY_EXISTS' using errcode = '23505';
      end if;
      raise;
  end;

  update private.business_branch_creation_requests set branch_id = v_branch_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_branch_id;
end;
$$;

-- update_business_branch ---------------------------------------------------
--
-- Ordinary (non-idempotent) update — a retry simply reasserts the same
-- target field values, which is already safe, matching updateProduct's/
-- updateCustomer's own "no idempotency ledger needed for PUT-shaped
-- writes" precedent. status and is_default are never touched here — those
-- are the two dedicated RPCs below.

create or replace function public.update_business_branch(
  p_business_id    uuid,
  p_branch_id      uuid,
  p_name           text,
  p_code           text default null,
  p_address_line1  text default null,
  p_address_line2  text default null,
  p_city           text default null,
  p_state          text default null,
  p_country_code   text default 'NG',
  p_phone          text default null
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;
  v_name           text;
  v_code           text;
  v_address_line1  text;
  v_address_line2  text;
  v_city           text;
  v_state          text;
  v_country_code   text;
  v_phone          text;
  v_found_id       uuid;
  v_constraint     text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_branch_id is null then
    raise exception 'p_business_id and p_branch_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Same canonicalization as create_business_branch — see that
  -- function's own comment.
  v_name := private.canonicalize_branch_name(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'INVALID_BRANCH_NAME' using errcode = '22023';
  end if;
  v_code := nullif(btrim(p_code), '');
  if v_code is not null and (length(v_code) > 20 or v_code ~ '[[:space:]]') then
    raise exception 'INVALID_BRANCH_CODE' using errcode = '22023';
  end if;
  v_address_line1 := nullif(btrim(p_address_line1), '');
  if v_address_line1 is not null and length(v_address_line1) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_address_line2 := nullif(btrim(p_address_line2), '');
  if v_address_line2 is not null and length(v_address_line2) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_city := nullif(btrim(p_city), '');
  if v_city is not null and length(v_city) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_state := nullif(btrim(p_state), '');
  if v_state is not null and length(v_state) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BRANCH_COUNTRY_CODE' using errcode = '22023';
  end if;
  v_phone := nullif(btrim(p_phone), '');
  if v_phone is not null and length(v_phone) > 32 then
    raise exception 'INVALID_BRANCH_PHONE' using errcode = '22023';
  end if;

  begin
    update public.business_branches
    set name = v_name, code = v_code, address_line1 = v_address_line1,
        address_line2 = v_address_line2, city = v_city, state = v_state,
        country_code = v_country_code, phone = v_phone
    where id = p_branch_id and business_id = p_business_id
    returning id into v_found_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'business_branches_name_unique_idx' then
        raise exception 'BRANCH_NAME_ALREADY_EXISTS' using errcode = '23505';
      elsif v_constraint = 'business_branches_code_unique_idx' then
        raise exception 'BRANCH_CODE_ALREADY_EXISTS' using errcode = '23505';
      end if;
      raise;
  end;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
  end if;

  return v_found_id;
end;
$$;

-- set_default_business_branch ---------------------------------------------
--
-- Atomically reassigns which branch is the default: unsets the current
-- default (if any), then sets the new one, as two sequential statements
-- inside this one function's implicit transaction — the partial unique
-- index (business_branches_one_default_idx) never sees two default rows
-- at once, and "no default" only ever exists transiently between these
-- two statements, never observable outside this transaction.

create or replace function public.set_default_business_branch(
  p_business_id uuid,
  p_branch_id   uuid
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid          uuid;
  v_found_id     uuid;
  v_status       text;
  v_is_default   boolean;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_branch_id is null then
    raise exception 'p_business_id and p_branch_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id, status, is_default into v_found_id, v_status, v_is_default
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
  end if;

  if v_is_default then
    return v_found_id;  -- already the default: no-op, not an error
  end if;

  -- Concurrency safety: two simultaneous set_default calls targeting two
  -- DIFFERENT branches of the same business could otherwise both proceed
  -- through the unset/set pair interleaved. Postgres's own UPDATE
  -- row-locking (a blocked "unset current default" naturally re-resolves
  -- its WHERE clause against the post-block committed state once
  -- unblocked) already makes this safe without a lock, but the advisory
  -- lock — salt 2, distinct from protect_last_owner's salt 0 and
  -- inventory's protect_last_active_location's salt 1, so the three
  -- invariants never contend the same key for the same business_id —
  -- makes that guarantee explicit and auditable rather than relying on
  -- an implicit blocking-semantics argument.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 2));

  update public.business_branches set is_default = false
  where business_id = p_business_id and is_default = true;

  update public.business_branches set is_default = true
  where id = p_branch_id and business_id = p_business_id;

  return v_found_id;
end;
$$;

-- deactivate_business_branch / reactivate_business_branch -----------------

create or replace function public.deactivate_business_branch(
  p_business_id uuid,
  p_branch_id   uuid
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_found_id   uuid;
  v_status     text;
  v_is_default boolean;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_branch_id is null then
    raise exception 'p_business_id and p_branch_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id, status, is_default into v_found_id, v_status, v_is_default
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;
  if v_is_default then
    raise exception 'DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED' using errcode = '23514';
  end if;
  if v_status = 'INACTIVE' then
    return v_found_id;  -- already inactive: no-op, not an error
  end if;

  update public.business_branches set status = 'INACTIVE'
  where id = p_branch_id and business_id = p_business_id;

  return v_found_id;
end;
$$;

create or replace function public.reactivate_business_branch(
  p_business_id uuid,
  p_branch_id   uuid
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_found_id  uuid;
  v_status    text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_branch_id is null then
    raise exception 'p_business_id and p_branch_id are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id, status into v_found_id, v_status
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status = 'ACTIVE' then
    return v_found_id;  -- already active: no-op, not an error
  end if;

  update public.business_branches set status = 'ACTIVE'
  where id = p_branch_id and business_id = p_business_id;

  return v_found_id;
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface for all five ------

grant create on schema public to private_branch_writer;
alter function public.create_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  owner to private_branch_writer;
alter function public.update_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  owner to private_branch_writer;
alter function public.set_default_business_branch(uuid, uuid) owner to private_branch_writer;
alter function public.deactivate_business_branch(uuid, uuid) owner to private_branch_writer;
alter function public.reactivate_business_branch(uuid, uuid) owner to private_branch_writer;
revoke create on schema public from private_branch_writer;

revoke all on function public.create_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  from public, anon, service_role;
revoke all on function public.update_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  from public, anon, service_role;
revoke all on function public.set_default_business_branch(uuid, uuid) from public, anon, service_role;
revoke all on function public.deactivate_business_branch(uuid, uuid) from public, anon, service_role;
revoke all on function public.reactivate_business_branch(uuid, uuid) from public, anon, service_role;

grant execute on function public.create_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  to authenticated;
grant execute on function public.update_business_branch(uuid, uuid, text, text, text, text, text, text, text, text)
  to authenticated;
grant execute on function public.set_default_business_branch(uuid, uuid) to authenticated;
grant execute on function public.deactivate_business_branch(uuid, uuid) to authenticated;
grant execute on function public.reactivate_business_branch(uuid, uuid) to authenticated;
