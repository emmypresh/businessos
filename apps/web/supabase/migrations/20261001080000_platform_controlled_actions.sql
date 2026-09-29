-- Phase 1O-D — Controlled Platform Actions.
--
-- Introduces a SMALL, EXPLICIT set of privileged platform mutations:
-- suspend a business, reactivate a business, extend a TRIALING
-- subscription's trial by a bounded number of days. Plan override is
-- DEFERRED (see the header note in section 6) — the existing subscription
-- architecture ties plan identity to a real Paystack-side subscription for
-- non-MANUAL rows, and a platform-only local override would desync
-- provider billing state, which this phase's own instructions explicitly
-- treat as a stop condition rather than something to force through.
--
-- Platform authority remains wholly separate from tenant authority
-- (1O-A's own founding invariant): every mutation below re-derives the
-- caller's identity from private.current_uid(), independently re-checks
-- platform admin status + AAL2 + the specific mutation permission via
-- private.has_platform_permission (which already enforces both, per
-- 20260928090000), and never accepts an actor/role/AAL claim from the
-- caller. A tenant OWNER/ADMIN — even at AAL2, even of the SAME business
-- being targeted — has no path to any function in this migration: none of
-- platform_admins/platform_permissions/platform_role_permissions/
-- platform_action_audit ever grant `authenticated` anything directly, and
-- has_platform_permission is a wholly separate check from tenant
-- has_permission.
--
-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1 — New platform permissions (narrow, one per mutation; never
-- widen an existing *.view permission to also gate a mutation).
-- ═══════════════════════════════════════════════════════════════════════
insert into public.platform_permissions (key, description) values
  ('platform.businesses.suspend', 'Suspend a business, blocking tenant operational access.'),
  ('platform.businesses.reactivate', 'Reactivate a previously suspended business.'),
  ('platform.subscriptions.extend_trial', 'Extend a business''s active trial by a bounded number of days.')
on conflict (key) do nothing;

-- ROLE MAPPING RATIONALE (documented per phase instructions §13):
--
-- SUPER_ADMIN: all three controlled actions — the frozen 1O-A role
-- matrix already gives SUPER_ADMIN every existing platform permission;
-- controlled mutations are no exception.
--
-- OPERATIONS: suspend + reactivate, NOT extend_trial. OPERATIONS already
-- holds platform.subscriptions.view (1O-A) alongside platform.businesses.view,
-- making business lifecycle (suspend/reactivate) a natural extension of its
-- existing "day-to-day business operations oversight" scope. Trial length is
-- treated here as a BILLING policy decision, not an operations one.
--
-- BILLING: extend_trial, NOT suspend/reactivate. BILLING already holds
-- platform.subscriptions.view; extending a trial is a billing-policy action
-- squarely inside that existing scope. Suspending/reactivating a business is
-- a broader operational action BILLING has no existing precedent for (it
-- holds no platform.businesses.* permission at all in the 1O-A matrix), so
-- it is deliberately withheld here rather than assumed.
--
-- SUPPORT: none. SUPPORT's frozen 1O-A scope is read-only investigation
-- (dashboard/businesses/users view) to help diagnose tenant issues; no
-- controlled action is required for that job, and granting one would widen
-- SUPPORT from "can look" to "can change tenant state" with no stated
-- product need to justify it. If a future phase finds a concrete support
-- workflow that needs a mutation, that is a new, separately reviewed grant.
--
-- VIEWER: none — VIEWER never holds any mutation permission, by definition.
insert into public.platform_role_permissions (role, permission_key) values
  ('SUPER_ADMIN', 'platform.businesses.suspend'),
  ('SUPER_ADMIN', 'platform.businesses.reactivate'),
  ('SUPER_ADMIN', 'platform.subscriptions.extend_trial'),
  ('OPERATIONS', 'platform.businesses.suspend'),
  ('OPERATIONS', 'platform.businesses.reactivate'),
  ('BILLING', 'platform.subscriptions.extend_trial')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2 — Central tenant-access enforcement.
--
-- businesses.status already has a 'suspended' value in its CHECK
-- constraint (20260825202823) but, until this migration, NOTHING in the
-- authorization stack ever reads it — private.is_business_member and
-- private.has_permission (the two functions every RLS policy and every
-- app-level hasPermission()/is_business_member() call ultimately goes
-- through) check only business_members.status. Setting businesses.status
-- to 'suspended' today has zero enforcement effect anywhere.
--
-- This section closes that gap at the single smallest, most central
-- choke point, exactly as phase instructions §6 require ("do not scatter
-- fragile checks across 50 pages manually"): both functions now
-- additionally require the parent business's own status = 'active'. This
-- automatically propagates fail-closed to every existing RLS policy and
-- every existing hasPermission()/is_business_member() call site with no
-- per-page changes — including businesses_select itself, so a suspended
-- business's own members can no longer even read the business row. This
-- is a deliberate full-lockout model: "tenant operational access blocked"
-- is interpreted here as ALL access (read and write), not merely writes —
-- data is retained in the database throughout (no row is ever deleted or
-- altered beyond the status flip itself), but nothing about it remains
-- reachable through the tenant-facing app while suspended. Platform
-- support access is unaffected: /internal/admin/businesses/[businessId]
-- and its RPCs (list_platform_business_overview, etc.) never call
-- is_business_member/has_permission — they gate exclusively on
-- has_platform_permission, a wholly separate authorization domain — so a
-- suspended business remains fully inspectable by an authorized platform
-- admin throughout (§7).
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
    join public.businesses b on b.id = bm.business_id
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.status = 'active'
      and b.status = 'active'
  );
$$;

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
    join public.businesses b on b.id = bm.business_id
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.status = 'active'
      and p.key = p_permission_key
      and b.status = 'active'
  );
$$;

-- CREATE OR REPLACE preserves the existing REVOKE/GRANT state from
-- 20260825202827 (privileges attach to the function object, not to its
-- body), so no re-grant is needed here.

-- Close the door a tenant OWNER/ADMIN currently has to flip their own
-- business's status directly: 20260825202828 granted `update (name, slug,
-- status)` to `authenticated`, gated by businesses_update's own
-- business.manage check. Nothing in the app has ever exercised the
-- `status` half of that grant, but it is a live path today
-- (`.from('businesses').update({status:...})`), and a platform-only
-- suspend/reactivate action must not be circumventable by the tenant
-- simply writing the column back. name/slug/timezone remain untouched —
-- this revokes ONLY the `status` column privilege; Postgres column
-- privileges are independently grantable/revocable, so `update (name,
-- slug)` (20260825202828) and `update (timezone)` (20260923090000) are
-- both unaffected.
revoke update (status) on public.businesses from authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 3 — platform_action_audit: dedicated, append-only record of
-- what PLATFORM STAFF did, wholly separate from the tenant audit_events
-- ledger (1O-C's Audit tab reads audit_events to show platform staff
-- *tenant* activity — a different trust domain entirely; mixing the two
-- would confuse "what a tenant user did" with "what BusinessOS staff did
-- to a tenant", which phase instructions §16 explicitly warn against).
-- 1O-A's own brief lists "platform audit log writes" as explicitly
-- deferred to 1O-D — this table is that deferred piece.
-- ═══════════════════════════════════════════════════════════════════════
create table public.platform_action_audit (
  id                       uuid primary key default gen_random_uuid(),
  actor_platform_admin_id  uuid not null references public.platform_admins (id),
  actor_user_id            uuid not null references auth.users (id),
  action_type              text not null
                             check (action_type in ('SUSPEND_BUSINESS', 'REACTIVATE_BUSINESS', 'EXTEND_TRIAL')),
  target_business_id       uuid not null references public.businesses (id),
  reason                   text not null
                             check (length(btrim(reason)) between 10 and 500),
  -- Idempotency key is MANDATORY (phase instructions §19: "every mutation
  -- endpoint/action must accept or generate an idempotency key") and
  -- globally unique — the single source of truth a repeated request is
  -- detected against. Bounded length/charset guards against a client
  -- supplying an unbounded or exotic value; the exact bound mirrors this
  -- schema's own established "bounded identifier" convention.
  idempotency_key          text not null
                             check (idempotency_key ~ '^[A-Za-z0-9_-]{8,200}$'),
  -- A hash of the action's own semantic parameters (business id, action
  -- type, reason, and — for EXTEND_TRIAL — the day count), compared on an
  -- idempotency-key collision to distinguish a legitimate replay (exact
  -- same params) from a conflicting reuse of the same key for a
  -- different request (phase instructions §50): match -> replay, returns
  -- the original result; mismatch -> IDEMPOTENCY_KEY_CONFLICT.
  params_hash              text not null,
  -- Minimum-necessary before/after projection (phase instructions §49 —
  -- "avoid storing whole row snapshots"): e.g. {"status":"active"} /
  -- {"status":"suspended"}, or {"trial_ends_at":"..."} /
  -- {"trial_ends_at":"..."} — never a full row dump, never tokens,
  -- secrets, or provider payloads (§18).
  before_state             jsonb not null,
  after_state              jsonb not null,
  created_at               timestamptz not null default now(),

  unique (idempotency_key)
);

create index platform_action_audit_business_idx
  on public.platform_action_audit (target_business_id, created_at desc, id desc);

comment on table public.platform_action_audit is
  'Append-only record of privileged platform-staff mutations (suspend/'
  'reactivate/trial-extend). Wholly separate from the tenant audit_events '
  'ledger — this records what BusinessOS staff did, not what a tenant user '
  'did. No authenticated-facing grants or RLS policies of any kind exist; '
  'access is exclusively through the SECURITY DEFINER functions in this '
  'migration. No UPDATE/DELETE path exists for any role except service_role '
  '(operator-only), so normal application APIs — including platform admin '
  'ones — can never rewrite or erase history.';

-- Deliberately NO policy at all, for any operation, for `authenticated` —
-- mirrors platform_admins'/platform_permissions' own established
-- fail-closed-by-default posture exactly.
alter table public.platform_action_audit enable row level security;
alter table public.platform_action_audit force row level security;

grant select on public.platform_action_audit to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 4 — private_platform_action_writer: the ONE role every
-- controlled mutation runs as. Mirrors private_billing_writer's own
-- posture exactly (NOLOGIN NOINHERIT BYPASSRLS, non-superuser, no
-- CREATEDB/CREATEROLE) — narrow, column-level grants only, never a
-- blanket table grant.
-- ═══════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_platform_action_writer') then
    create role private_platform_action_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_platform_action_writer to postgres;

grant usage on schema public to private_platform_action_writer;
grant usage on schema private to private_platform_action_writer;

-- Every trusted writer role that calls private.current_uid()/
-- private.has_platform_permission from inside its own SECURITY DEFINER
-- functions needs EXECUTE on them directly — a nested call inside a
-- SECURITY DEFINER function still runs as the CURRENT role for privilege
-- checks on further function calls, it does not inherit the outer
-- function's own grants. Mirrors every other private_*_writer role's own
-- identical grant.
grant execute on function private.current_uid() to private_platform_action_writer;
grant execute on function private.has_platform_permission(text) to private_platform_action_writer;

grant select (user_id, id, role, is_active) on public.platform_admins to private_platform_action_writer;
grant select (id, status) on public.businesses to private_platform_action_writer;
grant update (status) on public.businesses to private_platform_action_writer;
grant select (id, business_id, status, trial_ends_at) on public.business_subscriptions to private_platform_action_writer;
grant update (trial_ends_at) on public.business_subscriptions to private_platform_action_writer;
grant select, insert on public.platform_action_audit to private_platform_action_writer;
-- No UPDATE/DELETE grant of any kind — append-only from every role's
-- perspective including this writer's own (phase instructions §17).

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 5 — Shared idempotency/param-conflict helper.
--
-- Every mutation RPC below calls this FIRST, immediately after its own
-- permission check, while already holding the target row's lock (taken by
-- the caller before this is invoked — see each RPC's own comment for why
-- locking the target row first is what makes two concurrent calls on the
-- SAME business serialize safely, per phase instructions §21). A plain
-- SELECT here (no separate lock) is sufficient for the same-business case
-- because the caller's own target-row lock already excludes concurrent
-- same-business callers; a cross-business key reuse race is instead
-- caught as a unique_violation on the INSERT each RPC performs afterward,
-- exactly like private.record_provider_event's own established
-- insert-first/compare-on-conflict idiom.
create or replace function private.check_platform_action_idempotency(
  p_idempotency_key text,
  p_params_hash     text
)
returns table (existing_id uuid, before_state jsonb, after_state jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id            uuid;
  v_hash          text;
  v_before        jsonb;
  v_after         jsonb;
begin
  select paa.id, paa.params_hash, paa.before_state, paa.after_state
  into v_id, v_hash, v_before, v_after
  from public.platform_action_audit paa
  where paa.idempotency_key = p_idempotency_key;

  if v_id is null then
    return; -- no existing row: caller proceeds with a fresh mutation.
  end if;

  if v_hash is distinct from p_params_hash then
    raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = '23514';
  end if;

  return query select v_id, v_before, v_after;
end;
$$;

grant create on schema private to private_platform_action_writer;
alter function private.check_platform_action_idempotency(text, text) owner to private_platform_action_writer;
revoke create on schema private from private_platform_action_writer;
revoke all on function private.check_platform_action_idempotency(text, text) from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 6 — public.platform_suspend_business.
--
-- ACTIVE -> SUSPENDED. archived is a terminal state this action never
-- touches (INVALID_BUSINESS_STATE). Suspending an already-SUSPENDED
-- business is treated as an explicit idempotent no-op success (phase
-- instructions §22) — still fully audited (before = after = 'suspended'),
-- never an error, so a retried/duplicate operator action is always safe.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.platform_suspend_business(
  p_business_id      uuid,
  p_reason           text,
  p_idempotency_key  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id    uuid;
  v_status      text;
  v_reason      text;
  v_params_hash text;
  v_before      jsonb;
  v_after       jsonb;
  v_existing    record;
  v_audit_id    uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.suspend') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id into v_admin_id
  from public.platform_admins
  where user_id = private.current_uid() and is_active = true;
  if v_admin_id is null then
    -- Structurally unreachable given the permission check above (it
    -- already requires an active platform_admins row), guarded rather
    -- than assumed.
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;
  v_reason := btrim(p_reason);
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'INVALID_REASON' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = '22023';
  end if;

  -- Lock the target row FIRST — this is what makes two concurrent
  -- suspend/reactivate calls on the SAME business serialize safely
  -- (phase instructions §21), independent of idempotency key.
  select status into v_status
  from public.businesses
  where id = p_business_id
  for update;

  if v_status is null then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status = 'archived' then
    raise exception 'INVALID_BUSINESS_STATE' using errcode = '23514';
  end if;

  v_params_hash := md5(concat_ws('|', p_business_id::text, 'SUSPEND_BUSINESS', v_reason));

  select existing_id, before_state, after_state into v_existing
  from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
  if v_existing.existing_id is not null then
    return jsonb_build_object(
      'action_id', v_existing.existing_id,
      'before', v_existing.before_state,
      'after', v_existing.after_state,
      'replayed', true
    );
  end if;

  v_before := jsonb_build_object('status', v_status);
  v_after  := jsonb_build_object('status', 'suspended');

  if v_status <> 'suspended' then
    update public.businesses set status = 'suspended' where id = p_business_id;
  end if;
  -- v_status = 'suspended' already: explicit idempotent no-op — no UPDATE
  -- is issued, but the action is still fully audited below.

  begin
    insert into public.platform_action_audit (
      actor_platform_admin_id, actor_user_id, action_type, target_business_id,
      reason, idempotency_key, params_hash, before_state, after_state
    ) values (
      v_admin_id, private.current_uid(), 'SUSPEND_BUSINESS', p_business_id,
      v_reason, p_idempotency_key, v_params_hash, v_before, v_after
    )
    returning id into v_audit_id;
  exception
    when unique_violation then
      -- Cross-business key-reuse race (the target-row lock above only
      -- excludes concurrent callers targeting the SAME business) — decide
      -- replay vs. conflict exactly like the idempotency helper above,
      -- mirroring private.record_provider_event's own established idiom.
      select existing_id, before_state, after_state into v_existing
      from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
      if v_existing.existing_id is null then
        raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = '23514';
      end if;
      return jsonb_build_object(
        'action_id', v_existing.existing_id,
        'before', v_existing.before_state,
        'after', v_existing.after_state,
        'replayed', true
      );
  end;

  return jsonb_build_object('action_id', v_audit_id, 'before', v_before, 'after', v_after, 'replayed', false);
end;
$$;

grant create on schema public to private_platform_action_writer;
alter function public.platform_suspend_business(uuid, text, text) owner to private_platform_action_writer;
revoke create on schema public from private_platform_action_writer;
revoke all on function public.platform_suspend_business(uuid, text, text) from public, anon;
grant execute on function public.platform_suspend_business(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 7 — public.platform_reactivate_business.
--
-- SUSPENDED -> ACTIVE ONLY. Reverses the suspension flag alone — never
-- touches subscription, roles, plan, or owner (phase instructions §8).
-- Reactivating an ACTIVE business is an idempotent no-op success, exactly
-- like suspend's own symmetric case. archived is still terminal here too.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.platform_reactivate_business(
  p_business_id      uuid,
  p_reason           text,
  p_idempotency_key  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id    uuid;
  v_status      text;
  v_reason      text;
  v_params_hash text;
  v_before      jsonb;
  v_after       jsonb;
  v_existing    record;
  v_audit_id    uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.businesses.reactivate') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id into v_admin_id
  from public.platform_admins
  where user_id = private.current_uid() and is_active = true;
  if v_admin_id is null then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;
  v_reason := btrim(p_reason);
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'INVALID_REASON' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = '22023';
  end if;

  select status into v_status
  from public.businesses
  where id = p_business_id
  for update;

  if v_status is null then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status = 'archived' then
    raise exception 'INVALID_BUSINESS_STATE' using errcode = '23514';
  end if;

  v_params_hash := md5(concat_ws('|', p_business_id::text, 'REACTIVATE_BUSINESS', v_reason));

  select existing_id, before_state, after_state into v_existing
  from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
  if v_existing.existing_id is not null then
    return jsonb_build_object(
      'action_id', v_existing.existing_id,
      'before', v_existing.before_state,
      'after', v_existing.after_state,
      'replayed', true
    );
  end if;

  v_before := jsonb_build_object('status', v_status);
  v_after  := jsonb_build_object('status', 'active');

  if v_status <> 'active' then
    update public.businesses set status = 'active' where id = p_business_id;
  end if;

  begin
    insert into public.platform_action_audit (
      actor_platform_admin_id, actor_user_id, action_type, target_business_id,
      reason, idempotency_key, params_hash, before_state, after_state
    ) values (
      v_admin_id, private.current_uid(), 'REACTIVATE_BUSINESS', p_business_id,
      v_reason, p_idempotency_key, v_params_hash, v_before, v_after
    )
    returning id into v_audit_id;
  exception
    when unique_violation then
      select existing_id, before_state, after_state into v_existing
      from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
      if v_existing.existing_id is null then
        raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = '23514';
      end if;
      return jsonb_build_object(
        'action_id', v_existing.existing_id,
        'before', v_existing.before_state,
        'after', v_existing.after_state,
        'replayed', true
      );
  end;

  return jsonb_build_object('action_id', v_audit_id, 'before', v_before, 'after', v_after, 'replayed', false);
end;
$$;

grant create on schema public to private_platform_action_writer;
alter function public.platform_reactivate_business(uuid, text, text) owner to private_platform_action_writer;
revoke create on schema public from private_platform_action_writer;
revoke all on function public.platform_reactivate_business(uuid, text, text) from public, anon;
grant execute on function public.platform_reactivate_business(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 8 — public.platform_extend_trial.
--
-- Only ever legal when business_subscriptions.status = 'TRIALING' — every
-- other case (ACTIVE, PAST_DUE, CANCELED, EXPIRED, INCOMPLETE, or no
-- subscription row at all) fails closed with TRIAL_EXTENSION_NOT_SUPPORTED,
-- exactly as phase instructions §10 require ("do not guess... fail closed
-- and document unsupported case"). new trial_ends_at = existing
-- trial_ends_at + p_days (never a caller-supplied absolute timestamp —
-- phase instructions §9). This never touches business_subscriptions.status,
-- plan_id, or any provider field — see this migration's own header note on
-- why plan override itself is out of scope.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.platform_extend_trial(
  p_business_id      uuid,
  p_days             integer,
  p_reason           text,
  p_idempotency_key  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id       uuid;
  v_sub_status     text;
  v_trial_ends_at  timestamptz;
  v_new_trial_end  timestamptz;
  v_reason         text;
  v_params_hash    text;
  v_before         jsonb;
  v_after          jsonb;
  v_existing       record;
  v_audit_id       uuid;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.subscriptions.extend_trial') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select id into v_admin_id
  from public.platform_admins
  where user_id = private.current_uid() and is_active = true;
  if v_admin_id is null then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;
  if p_days is null or p_days < 1 or p_days > 30 then
    raise exception 'INVALID_TRIAL_DAYS' using errcode = '22023';
  end if;
  v_reason := btrim(p_reason);
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'INVALID_REASON' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = '22023';
  end if;

  -- Lock the SUBSCRIPTION row (not businesses — this action never touches
  -- businesses at all), serializing concurrent trial-extend calls on the
  -- same business exactly like suspend/reactivate serialize on their own
  -- target row.
  select status, trial_ends_at into v_sub_status, v_trial_ends_at
  from public.business_subscriptions
  where business_id = p_business_id
  for update;

  if v_sub_status is null then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = '22023';
  end if;
  if v_sub_status <> 'TRIALING' then
    raise exception 'TRIAL_EXTENSION_NOT_SUPPORTED' using errcode = '23514';
  end if;

  v_params_hash := md5(concat_ws('|', p_business_id::text, 'EXTEND_TRIAL', v_reason, p_days::text));

  select existing_id, before_state, after_state into v_existing
  from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
  if v_existing.existing_id is not null then
    return jsonb_build_object(
      'action_id', v_existing.existing_id,
      'before', v_existing.before_state,
      'after', v_existing.after_state,
      'replayed', true
    );
  end if;

  v_new_trial_end := v_trial_ends_at + make_interval(days => p_days);
  v_before := jsonb_build_object('trial_ends_at', v_trial_ends_at);
  v_after  := jsonb_build_object('trial_ends_at', v_new_trial_end);

  update public.business_subscriptions
  set trial_ends_at = v_new_trial_end
  where business_id = p_business_id;

  begin
    insert into public.platform_action_audit (
      actor_platform_admin_id, actor_user_id, action_type, target_business_id,
      reason, idempotency_key, params_hash, before_state, after_state
    ) values (
      v_admin_id, private.current_uid(), 'EXTEND_TRIAL', p_business_id,
      v_reason, p_idempotency_key, v_params_hash, v_before, v_after
    )
    returning id into v_audit_id;
  exception
    when unique_violation then
      select existing_id, before_state, after_state into v_existing
      from private.check_platform_action_idempotency(p_idempotency_key, v_params_hash);
      if v_existing.existing_id is null then
        raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = '23514';
      end if;
      return jsonb_build_object(
        'action_id', v_existing.existing_id,
        'before', v_existing.before_state,
        'after', v_existing.after_state,
        'replayed', true
      );
  end;

  return jsonb_build_object('action_id', v_audit_id, 'before', v_before, 'after', v_after, 'replayed', false);
end;
$$;

grant create on schema public to private_platform_action_writer;
alter function public.platform_extend_trial(uuid, integer, text, text) owner to private_platform_action_writer;
revoke create on schema public from private_platform_action_writer;
revoke all on function public.platform_extend_trial(uuid, integer, text, text) from public, anon;
grant execute on function public.platform_extend_trial(uuid, integer, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 9 — Read model: list_platform_business_actions.
--
-- Gated on platform.audit.view, per phase instructions §37 ("prefer
-- reusing platform.audit.view for READ visibility if semantically
-- appropriate... do not make mutation permission imply audit-read
-- automatically") — OPERATIONS/BILLING can perform mutations but do not
-- automatically gain visibility into the platform-wide action history;
-- only SUPER_ADMIN holds platform.audit.view in the frozen 1O-A matrix,
-- unchanged here. Reuses the existing private_platform_directory_reader
-- role additively (1O-C's own established "reuse the reader role, no new
-- BYPASSRLS role" precedent) rather than minting a second reader role.
-- ═══════════════════════════════════════════════════════════════════════
grant select (id, target_business_id, action_type, reason, before_state, after_state, created_at, actor_user_id)
  on public.platform_action_audit to private_platform_directory_reader;

-- Actor email lookup for platform admins — mirrors 1O-B/1O-C's own
-- get_business_owner_email/get_business_actor_emails pattern exactly
-- (owned by `postgres`, the only role allowed to touch auth.users), but
-- scoped to platform admins who have actually acted on the ONE requested
-- business's own platform_action_audit rows — never a generic user
-- lookup.
create or replace function private.get_platform_action_actor_emails(p_business_id uuid)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct paa.actor_user_id, lower(btrim(u.email))
  from public.platform_action_audit paa
  join auth.users u on u.id = paa.actor_user_id
  where paa.target_business_id = p_business_id;
$$;

revoke all on function private.get_platform_action_actor_emails(uuid) from public, anon, authenticated;
grant execute on function private.get_platform_action_actor_emails(uuid) to private_platform_directory_reader;

create or replace function public.list_platform_business_actions(
  p_business_id uuid,
  p_page        integer default 1,
  p_page_size   integer default 25
)
returns table (
  action_id     uuid,
  action_type   text,
  actor_email   text,
  reason        text,
  before_state  jsonb,
  after_state   jsonb,
  occurred_at   timestamptz,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page      integer;
  v_page_size integer;
  v_offset    integer;
begin
  if private.current_uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.has_platform_permission('platform.audit.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'INVALID_BUSINESS_ID' using errcode = '22023';
  end if;

  v_page := coalesce(p_page, 1);
  if v_page < 1 then
    raise exception 'INVALID_PAGE' using errcode = '22023';
  end if;
  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'INVALID_PAGE_SIZE' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  return query
  with base as (
    select paa.id as action_id, paa.action_type, ae.email as actor_email, paa.reason,
           paa.before_state, paa.after_state, paa.created_at as occurred_at
    from public.platform_action_audit paa
    left join private.get_platform_action_actor_emails(p_business_id) ae on ae.user_id = paa.actor_user_id
    where paa.target_business_id = p_business_id
  ),
  counted as (
    select base.*, count(*) over () as total_count from base
  )
  select counted.action_id, counted.action_type, counted.actor_email, counted.reason,
         counted.before_state, counted.after_state, counted.occurred_at, counted.total_count
  from counted
  order by counted.occurred_at desc, counted.action_id desc
  limit v_page_size
  offset v_offset;
end;
$$;

grant create on schema public to private_platform_directory_reader;
alter function public.list_platform_business_actions(uuid, integer, integer)
  owner to private_platform_directory_reader;
revoke create on schema public from private_platform_directory_reader;
revoke all on function public.list_platform_business_actions(uuid, integer, integer) from public, anon;
grant execute on function public.list_platform_business_actions(uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 10 — Plan override: DEFERRED, not implemented.
--
-- subscription_plans.code is a closed catalog enum and non-MANUAL
-- business_subscriptions rows carry a real provider_subscription_code
-- tying the row to an actual Paystack-side subscription. A platform-only
-- RPC that rewrote plan_id/price_id locally would leave that Paystack
-- subscription charging (or entitling) a DIFFERENT plan than the local
-- row now claims — exactly the provider/local desync phase instructions
-- §11/§55/§74 identify as a stop condition ("if platform plan override
-- would desync provider billing: DO NOT implement it in 1O-D"). Reaching
-- correct behavior would require either (a) also calling Paystack's own
-- subscription-update API synchronously and rolling back the local write
-- on provider failure, or (b) restricting override to MANUAL-provider
-- rows only, both of which are real, separately-reviewable design
-- decisions this phase does not make on its own authority. No
-- platform.subscriptions.override_plan permission, table, or function is
-- created in this migration.
-- ═══════════════════════════════════════════════════════════════════════
