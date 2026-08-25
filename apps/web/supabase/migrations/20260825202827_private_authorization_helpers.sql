-- Private authorization helpers.
--
-- Every access-control decision in this schema is expressed as a call to
-- one of these two functions, which read business_members / role_permissions
-- directly — never auth.jwt() claims, and never user_metadata (which is
-- client-editable and unsafe to authorize on). A caller can pass any
-- business_id it likes; these functions only ever return true if a real,
-- active membership row for auth.uid() backs it up, so a spoofed
-- business_id gains nothing. This is what makes it safe for RLS policies
-- (and server code, via the public wrapper below) to accept a business_id
-- from the client without trusting it.
--
-- Both are SECURITY DEFINER, narrowly: business_members has forced RLS and
-- no SELECT policy yet (added in the next migration, which itself depends
-- on these functions) — without SECURITY DEFINER, is_business_member could
-- never see the very row it needs to check, and the SELECT policy on
-- business_members would recurse into itself trying to evaluate whether
-- the caller may see rows used to decide whether the caller may see rows.
-- STABLE (not VOLATILE) since they only read, and a fixed search_path
-- keeps a malicious search_path from redirecting `public.*` lookups. Both
-- are revoked from PUBLIC and granted only to `authenticated` — `anon` has
-- no legitimate use for either, and every new Postgres function is
-- EXECUTE-granted to PUBLIC by default.
--
-- USAGE on the `private` schema itself is separate from EXECUTE on a
-- function in it: USAGE only allows a role to look an object up (needed
-- to even resolve `private.has_permission` while parsing a query), it
-- grants no rights on its own. `authenticated` needs it because the
-- public.has_permission wrapper below runs as SECURITY INVOKER and
-- resolves `private.*` under the calling role, not the function owner.
grant usage on schema private to authenticated;

create or replace function private.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.status = 'active'
  );
$$;

revoke all on function private.is_business_member(uuid) from public;
grant execute on function private.is_business_member(uuid) to authenticated;

create or replace function private.has_permission(p_business_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members bm
    join public.role_permissions rp on rp.role_id = bm.role_id
    join public.permissions p on p.id = rp.permission_id
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.status = 'active'
      and p.key = p_permission_key
  );
$$;

revoke all on function private.has_permission(uuid, text) from public;
grant execute on function private.has_permission(uuid, text) to authenticated;

-- Public, server-callable wrapper --------------------------------------
--
-- Exposed via PostgREST RPC (config.toml exposes the `public` schema) so
-- server-side code — Route Handlers, Server Actions, anything holding the
-- signed-in user's session — can ask "does the current session's user have
-- permission X on business Y" and get an answer derived entirely from
-- server-verified state, instead of trusting a role or permission flag the
-- client sent up. SECURITY INVOKER, not DEFINER: it does no privileged
-- work of its own, it only forwards to private.has_permission (which is
-- already the narrowly-scoped DEFINER), so it runs as whatever role calls
-- it and needs no elevated privilege itself.
create or replace function public.has_permission(p_business_id uuid, p_permission_key text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.has_permission(p_business_id, p_permission_key);
$$;

revoke all on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;
