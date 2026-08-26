-- Password-recovery capability grants: a single-use, short-lived,
-- server-verifiable proof that the CURRENT authenticated session was
-- established via a genuine password-recovery link — not signup
-- confirmation, not an ordinary login.
--
-- Why this exists: claims.amr (the JWT's Authentication Methods
-- Reference) cannot be used for this. Verified empirically against the
-- local Supabase Auth stack: a signup-confirmation verifyOtp session, a
-- recovery verifyOtp session, and both of those again after a token
-- refresh, all record amr method "otp" — GoTrue does not distinguish
-- verifyOtp's `type` in this claim, and the value survives a refresh
-- identically for every otp-derived flow. There is no claim that safely
-- answers "did this session come from the recovery link" on its own.

-- One grant per successful recovery verification. Bound to session_id
-- (below), not just user_id: without that, a user with an unconsumed
-- grant from one recovery attempt could have ANY of their other current
-- sessions (e.g. an ordinary password login open in another tab) consume
-- it, since user_id alone doesn't prove *that* session came from the
-- recovery link.
create table private.password_recovery_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz
);

create index password_recovery_grants_user_id_idx on private.password_recovery_grants (user_id);

-- Enabled and forced immediately, and deliberately given NO policies at
-- all for authenticated/anon/service_role: every access goes through the
-- two functions below, mirroring business_members' write boundary (see
-- create_business_members.sql) — a table this sensitive is not something
-- any client role should be able to query or write directly, even
-- filtered by RLS.
alter table private.password_recovery_grants enable row level security;
alter table private.password_recovery_grants force row level security;

-- Reads the JWT "session_id" claim the same way private.current_uid()
-- (create_business_rpc.sql) reads "sub" — via the stable PostgREST GUCs a
-- JWT-based request always sets, not the `auth` schema (which this
-- project's migration-running role cannot extend access to; see
-- current_uid()'s own comment for the full explanation). Still used by
-- consume_recovery_grant below (an ordinary authenticated call, gated by
-- the caller's own JWT) — issue_recovery_grant no longer calls this; see
-- its own comment for why.
create or replace function private.current_session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.session_id', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')
  )::uuid
$$;

revoke all on function private.current_session_id() from public, anon, authenticated;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY-CRITICAL: this function's EXECUTE grant is the entire       │
-- │ security boundary of the recovery-grant mechanism. It must NEVER    │
-- │ be granted to `authenticated` or `anon`.                            │
-- └─────────────────────────────────────────────────────────────────────┘
--
-- Original design flaw (caught in review, before this migration ever
-- shipped): an earlier version of this function derived user_id/session_id
-- from private.current_uid()/private.current_session_id() — i.e. from
-- whoever's JWT was calling it — and was grant-executable to
-- `authenticated`. That meant ANY ordinary, password-authenticated
-- session could call it directly and mint itself a fully valid recovery
-- grant for its own session, then immediately consume it and change its
-- own password without ever touching the recovery email flow — the
-- session-binding check added no protection at all against a session
-- that mints its own grant. Deriving identity from "whoever is calling"
-- is exactly backwards for a function whose entire purpose is proving
-- "this session came from a specific, narrow, externally-triggered event
-- (a real recovery email verification)" — that fact cannot be
-- self-attested by the session being vouched for.
--
-- Corrected design: this function takes user_id/session_id as EXPLICIT
-- parameters instead, and is executable ONLY by `service_role` — no
-- `authenticated`, no `anon`, no `PUBLIC`. The only code in this entire
-- application permitted to hold a service-role-authenticated Supabase
-- client is lib/auth/recovery-grant-admin-client.ts (server-only,
-- SUPABASE_SECRET_KEY, never shipped to the browser), and the only place
-- that client is used is app/auth/confirm/route.ts, immediately after
-- `supabase.auth.verifyOtp({ type: "recovery", ... })` succeeds — at
-- which point the route handler reads the *just-verified* user_id and
-- session_id off the newly-established session's own JWT claims (via the
-- ordinary cookie-bound client, not the admin one) and passes those
-- specific, already-authenticated values through. The privilege boundary
-- that matters is therefore "can this caller present a valid
-- service-role key" — true only for this app's own trusted server code,
-- never for a browser, an anon/publishable-key client, or any
-- authenticated end-user session — not anything this function re-derives
-- from a JWT, because there is no end-user JWT in a service-role call to
-- derive from.
create or replace function public.issue_recovery_grant(p_user_id uuid, p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant_id uuid;
begin
  if p_user_id is null or p_session_id is null then
    raise exception 'p_user_id and p_session_id are required'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  insert into private.password_recovery_grants (user_id, session_id)
  values (p_user_id, p_session_id)
  returning id into v_grant_id;

  return v_grant_id;
end;
$$;

-- Atomically consumes a grant. The single UPDATE below — with
-- consumed_at is null and expires_at > now() in the WHERE clause — is
-- race-safe under Postgres MVCC: two concurrent callers racing to consume
-- the same grant_id can't both succeed, because the second UPDATE's WHERE
-- clause no longer matches once the first has committed consumed_at (or,
-- for two truly concurrent transactions, the second blocks on the row
-- lock and then re-evaluates WHERE against the first's committed result).
-- This is what makes the capability genuinely single-use, not just
-- "the browser's cookie was cleared after one use."
--
-- Unlike issue_recovery_grant, this one legitimately derives identity
-- from the caller's own JWT (private.current_uid()/current_session_id())
-- and stays `authenticated`-callable: an ordinary session calling this
-- can only ever consume a grant matching ITS OWN user_id and session_id,
-- and — now that issuance is service-role-only — an ordinary session
-- will never have had a grant issued for it in the first place. Calling
-- this with a guessed/random grant id, or a grant issued for a different
-- user or a different session, always returns false; it never mutates
-- anything the caller wasn't already narrowly scoped to.
create or replace function public.consume_recovery_grant(p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_session_id uuid;
  v_updated_id uuid;
begin
  v_uid := private.current_uid();
  v_session_id := private.current_session_id();

  if v_uid is null or v_session_id is null then
    return false;
  end if;

  update private.password_recovery_grants
  set consumed_at = now()
  where id = p_grant_id
    and user_id = v_uid
    and session_id = v_session_id
    and consumed_at is null
    and expires_at > now()
  returning id into v_updated_id;

  return v_updated_id is not null;
end;
$$;

-- Explicit, narrow surface. issue_recovery_grant: PUBLIC, anon, AND
-- authenticated all explicitly denied — service_role only (see the
-- function's own header comment for why this is the entire security
-- boundary). consume_recovery_grant: PUBLIC and anon denied,
-- authenticated allowed (it self-scopes via the caller's own JWT).
revoke all on function public.issue_recovery_grant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.issue_recovery_grant(uuid, uuid) to service_role;

revoke all on function public.consume_recovery_grant(uuid) from public, anon;
grant execute on function public.consume_recovery_grant(uuid) to authenticated;
