-- Atomic business creation.
--
-- This is the ONLY authorized path into public.businesses for
-- `authenticated`: there is no businesses_insert RLS policy and no INSERT
-- grant for `authenticated` on that table (see create_businesses.sql) — a
-- client cannot bypass this function with `.from('businesses').insert(...)`,
-- so slug normalization/validation and the OWNER-membership guarantee
-- below cannot be skipped.

-- Pure text normalization, no table access: lowercases, trims, collapses
-- any run of characters that isn't a-z/0-9 into a single hyphen, and
-- strips leading/trailing hyphens. Returns null for input that normalizes
-- to nothing (e.g. all-punctuation), which create_business below treats as
-- invalid. SECURITY INVOKER (the default) is correct here — normalizing
-- text carries no privilege of its own. Only create_business calls this
-- (as private_business_creator, once that role exists below), so it needs
-- no grant for `authenticated` at all.
create or replace function private.normalize_slug(p_slug text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    trim(both '-' from regexp_replace(lower(btrim(p_slug)), '[^a-z0-9]+', '-', 'g')),
    ''
  );
$$;

revoke all on function private.normalize_slug(text) from public, anon, authenticated;

-- Reads the JWT "sub" claim the exact same way auth.uid() does, using only
-- pg_catalog builtins (current_setting, jsonb) and no reference to the
-- `auth` schema at all. This exists because of a real constraint, not
-- preference: the `auth` schema is administered by `supabase_admin`, and
-- migrations run as `postgres`, which holds USAGE on `auth` without GRANT
-- OPTION — `postgres` is therefore unable to extend `auth` schema access
-- (or EXECUTE on auth.uid()) to any new role it creates, including
-- private_business_creator below (attempting it produces a silent
-- "no privileges were granted" warning, not an error, which is exactly
-- the kind of thing worth writing around explicitly rather than papering
-- over). Reimplementing against the stable PostgREST GUCs a JWT-based
-- request always sets — rather than depending on cross-schema-admin
-- privileges this project doesn't control — is the more robust choice for
-- a SECURITY DEFINER function whose owner needs this exactly once.
-- current_setting, nullif, and coalesce are all pg_catalog/SQL-standard
-- built-ins, which stay resolvable regardless of search_path (pg_catalog
-- is always implicitly searched) — search_path = '' here is about denying
-- resolution of anything else, not these.
create or replace function private.current_uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

revoke all on function private.current_uid() from public, anon, authenticated;

-- Dedicated, non-login role that owns create_business's SECURITY DEFINER
-- execution context, and nothing else. It exists purely so that function
-- can insert into businesses without either (a) granting `authenticated`
-- direct INSERT on businesses — which is exactly the bypass this migration
-- closes — or (b) running as `postgres`/the table owner, which would give
-- one narrowly-scoped function superuser-equivalent access to the entire
-- database instead of the two privileges it actually needs. BYPASSRLS is
-- deliberate here, not a shortcut: businesses_select is scoped `to
-- authenticated` only, so without BYPASSRLS this role — being neither
-- `authenticated` nor covered by any policy of its own — would fail to
-- read back the row it just inserted, for reasons unrelated to whether
-- the OWNER membership actually exists yet. NOLOGIN means it can never be
-- used to open a session directly (locally or via any connection string);
-- its only avenue into the system is as the security context of this one
-- function. NOINHERIT means it can never silently gain privileges through
-- a future role membership grant.
--
-- Guarded with an existence check because `db reset` recreates the
-- `postgres` database's contents but Postgres roles are cluster-level
-- objects that are not guaranteed to be dropped by that — a bare
-- `CREATE ROLE` would fail with "role already exists" on a second reset.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ BYPASSRLS is a role-wide attribute, not scoped to the businesses     │
-- │ table it's granted on today. If a future migration grants this role │
-- │ SELECT/INSERT/UPDATE/DELETE on any OTHER table, that table's RLS     │
-- │ policies become entirely invisible to this role too — silently, with│
-- │ no warning at grant time. Never extend this role's table grants as  │
-- │ a quick fix for some other SECURITY DEFINER function's privilege    │
-- │ problem; give that function its own dedicated minimal role instead. │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_business_creator') then
    create role private_business_creator noinherit nologin bypassrls;
  end if;
end;
$$;

-- `ALTER FUNCTION ... OWNER TO` requires the current role to be able to
-- `SET ROLE` into the target — this membership grant exists only to
-- satisfy that requirement for the migration below. NOINHERIT on
-- private_business_creator means this membership does not hand its
-- BYPASSRLS/table grants to `postgres` implicitly; `postgres` already has
-- broader access than that role by other means.
grant private_business_creator to postgres;

-- Minimum privileges necessary: USAGE to resolve the two schemas it
-- touches (no `auth` — see private.current_uid() above), SELECT + INSERT
-- on businesses only (no UPDATE, no DELETE, no access to any other table —
-- not even business_members, which it never writes to directly; that
-- stays the AFTER INSERT trigger's job, and that trigger runs under its
-- own SECURITY DEFINER context regardless of which role performed the
-- INSERT that fired it), and EXECUTE on exactly the two helper functions
-- it calls.
grant usage on schema public to private_business_creator;
grant usage on schema private to private_business_creator;
grant select, insert on public.businesses to private_business_creator;
grant execute on function private.normalize_slug(text) to private_business_creator;
grant execute on function private.current_uid() to private_business_creator;

-- Creates a business and its OWNER membership atomically, for the calling
-- user only.
--
-- SECURITY DEFINER, narrowly: `authenticated` has no INSERT grant on
-- businesses at all (see create_businesses.sql), so this function must run
-- with different privileges than its caller to perform the insert — that
-- is what private_business_creator (above) is for. This is exactly the
-- "genuinely required" case: the function does one specific, fully
-- validated write, not a general-purpose bypass of RLS or of anything
-- else `authenticated` couldn't otherwise justify doing to their own data.
--
-- Never accepts created_by, an owner user id, or a role_id as input:
-- created_by is always private.current_uid() (the JWT's own "sub" claim —
-- see that function for why this isn't literally auth.uid(), though it is
-- the same value), the OWNER role is always looked up by name inside the
-- AFTER INSERT trigger, and the membership row's role is hardcoded to
-- OWNER there — there is no parameter through which a caller could spoof
-- any of the three.
--
-- search_path = '' plus fully-qualified references throughout: with
-- SECURITY DEFINER this isn't optional hardening, it's what stops a
-- malicious search_path from redirecting an unqualified name to a
-- same-named object the definer role can also see.
create or replace function public.create_business(p_name text, p_slug text)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_name       text;
  v_slug       text;
  v_business   public.businesses;
  v_constraint text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000'; -- invalid_authorization_specification
  end if;

  -- Surrounding whitespace only, per businesses.name's own CHECK
  -- constraint (length(name) <= 150 and length(btrim(name)) >= 2) —
  -- normalizing here keeps the common case from ever reaching that
  -- constraint, but the constraint itself is the actual backstop, since
  -- it also covers writers that don't go through this RPC (e.g.
  -- service_role).
  v_name := btrim(p_name);
  if v_name is null or length(v_name) = 0 then
    raise exception 'business name is required'
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  if length(v_name) < 2 then
    raise exception 'business name is too short'
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  if length(v_name) > 150 then
    raise exception 'business name is too long'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  v_slug := private.normalize_slug(p_slug);
  if v_slug is null or length(v_slug) > 63 then
    raise exception 'business slug is invalid'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  -- No RETURNING here on purpose, though it's no longer an RLS-timing
  -- workaround now that this runs as private_business_creator
  -- (BYPASSRLS): it's kept because it makes the sequencing explicit and
  -- auditable — this INSERT fires the AFTER INSERT trigger
  -- (private.create_owner_membership) before control returns here, so by
  -- the time the SELECT below runs, the OWNER membership row already
  -- exists or the trigger has already raised and this whole function call
  -- (and the INSERT with it) has already been rolled back.
  --
  -- Slug collisions are caught explicitly and replaced with a generic,
  -- controlled error: the raw unique_violation carries a DETAIL naming
  -- the conflicting key/value, which would otherwise hand an unrelated
  -- caller confirmation that a specific slug (and therefore a specific
  -- tenant name) already exists elsewhere in the system. Scoped to
  -- businesses_slug_key specifically via GET STACKED DIAGNOSTICS, so an
  -- unrelated/unexpected unique_violation (should one ever exist) still
  -- surfaces normally instead of being masked.
  begin
    insert into public.businesses (name, slug, created_by)
    values (v_name, v_slug, v_uid);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'businesses_slug_key' then
        raise exception 'SLUG_UNAVAILABLE'
          using errcode = '23505'; -- unique_violation (keeps PostgREST's 409 mapping)
      end if;
      raise;
  end;

  -- slug is globally unique (businesses_slug_key), so this unambiguously
  -- identifies the row just inserted.
  select * into v_business
  from public.businesses
  where slug = v_slug;

  if v_business.id is null then
    raise exception 'business creation failed';
  end if;

  return v_business;
end;
$$;

-- ALTER ... OWNER TO requires the new owner to hold CREATE on the target
-- schema at the moment of transfer (so ownership can't be used to smuggle
-- an object into a schema the new owner couldn't have created it in
-- directly) — granted here only for that instant and revoked immediately
-- after, since private_business_creator has no ongoing need to create
-- anything in public; it only ever INSERTs/SELECTs on the one table
-- granted to it above.
grant create on schema public to private_business_creator;
alter function public.create_business(text, text) owner to private_business_creator;
revoke create on schema public from private_business_creator;

-- Explicit, narrow surface: PUBLIC and anon get nothing (anon has no
-- auth.uid() to create a business under, and would fail the null check
-- above anyway, but denying at the GRANT layer is the clearer signal and
-- means "not authenticated" fails as a permission error, not a runtime
-- exception, when called with the anon key). Only `authenticated` may call
-- it — not even `service_role` needs to, since server-side admin code can
-- already write to businesses directly (see create_businesses.sql).
revoke all on function public.create_business(text, text) from public, anon;
grant execute on function public.create_business(text, text) to authenticated;
