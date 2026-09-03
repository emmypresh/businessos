-- Phase 1K: the trusted, sole write path for public.notifications /
-- public.notification_recipients — private.create_notification.
--
-- ══════════════════════════════════════════════════════════════════════
-- WRITER ARCHITECTURE — mirrors private.record_audit_event
-- (20260902090100_audit_permissions_and_writer.sql) exactly, for the
-- identical reasons documented there in full: atomic (a notification and
-- its recipient fan-out commit or roll back together, inside whatever
-- transaction the CALLING mutation RPC is already running), and never
-- exposed to `authenticated` — no public.* wrapper exists, and EXECUTE is
-- granted to NO role at all by this migration (see the closing REVOKE).
-- This round instruments NO existing mutation RPC (DATABASE FOUNDATION
-- ONLY, per this phase's own explicit scope) — a future Phase 1K
-- application round grants EXECUTE to each specific existing writer role
-- that needs to raise a notification (e.g. private_inventory_writer for
-- inventory.low_stock), one at a time, via its own additive migration,
-- exactly like record_audit_event's own future-instrumentation plan.
-- ══════════════════════════════════════════════════════════════════════
--
-- RECIPIENT TARGETING POLICY IS DELIBERATELY NOT BAKED INTO THIS
-- FUNCTION. "Who should be notified about THIS inventory.low_stock
-- event" (every INVENTORY_VIEW holder assigned to the affected branch?
-- Every ADMIN regardless of branch?) is a per-notification-type PRODUCT
-- decision that differs by type and will keep changing as new types are
-- added — embedding it here would make this generic writer grow a
-- bespoke targeting rule per notification type, exactly the kind of
-- "generic arbitrary messaging system" complexity this phase's own
-- instructions warn against. Instead, this function accepts an ALREADY
-- RESOLVED, ALREADY SERVER-DERIVED array of target user ids
-- (p_recipient_user_ids) — the calling mutation RPC (future work)
-- resolves that list itself, using the EXISTING private.has_permission /
-- private.has_branch_access helpers (never inventing parallel
-- authorization logic, per this phase's own explicit instruction), and
-- this function's own responsibility is narrower and structural: (1)
-- validate every proposed target is a REAL, ACTIVE member of the
-- SAME business (defense in depth — never trust the caller's resolution
-- was correct, exactly like record_audit_event never trusts a supplied
-- branch_id without checking it), and (2) insert the notification and
-- its recipient rows atomically and idempotently.
--
-- DEDUPLICATION / REPLAY: if p_dedup_key is supplied, a second call with
-- the SAME (business_id, dedup_key) is a no-op beyond returning the
-- EXISTING notification's id — no new notification row, and no recipient
-- fan-out is attempted on a replay (see the IF v_id IS NULL branch
-- below). This is a deliberate, simplest-consistent choice: a
-- repeated background condition-check (e.g. a low-stock scan that runs
-- every few minutes while stock remains low) or a transaction retry must
-- never re-notify already-notified recipients. A recipient SET that
-- would legitimately differ between the original alert and a later
-- retry (e.g. a new member gained branch access in between) is an
-- accepted, documented limitation of this foundation — resolving that
-- drift, if ever needed, is a Phase 1K APPLICATION-layer concern
-- (re-raising a fresh alert with a new dedup_key once the old one is
-- resolved is the existing, sufficient mechanism), not something this
-- foundation function attempts to solve generically.
--
-- BOS EDGE READINESS: this function's own idempotency contract (stable
-- returned uuid, deterministic replay via dedup_key, explicit
-- business_id/branch_id parameters, no assumption that the caller is a
-- live browser session) is exactly what a future local-server/BOS Edge
-- ingestion path needs to safely retry an at-least-once delivery of the
-- same underlying event without double-notifying anyone — no additional
-- schema work is anticipated to support that later, only a future grant
-- of EXECUTE to whatever trusted writer role BOS Edge ingestion runs as.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS FUNCTION.       │
-- │ Every future `grant execute on function private.create_notification  │
-- │ ... to private_<x>_writer` hands that RPC the ability to raise a     │
-- │ permanent, user-visible notification and MUST be reviewed with the   │
-- │ same scrutiny as any other new cross-role EXECUTE dependency in this │
-- │ codebase — see record_audit_event's own identical standing           │
-- │ requirement, which this note deliberately mirrors.                   │
-- └─────────────────────────────────────────────────────────────────────┘
create or replace function private.create_notification(
  p_business_id        uuid,
  p_category           text,
  p_notification_type  text,
  p_title              text,
  p_recipient_user_ids uuid[],
  p_branch_id          uuid default null,
  p_body               text default null,
  p_severity           text default 'INFO',
  p_resource_type      text default null,
  p_resource_id        uuid default null,
  p_metadata           jsonb default '{}'::jsonb,
  p_dedup_key          text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_found uuid;
  v_id           uuid;
  v_user_id      uuid;
  v_missing      uuid;
begin
  if p_business_id is null or p_category is null or p_notification_type is null or p_title is null then
    raise exception 'p_business_id, p_category, p_notification_type, and p_title are required'
      using errcode = '22023';
  end if;

  if p_category not in ('COMMERCE', 'INVENTORY', 'FINANCE', 'CUSTOMER', 'ORGANIZATION', 'SECURITY', 'SYSTEM') then
    raise exception 'INVALID_NOTIFICATION_CATEGORY' using errcode = '22023';
  end if;

  if p_notification_type !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' or length(p_notification_type) > 100 then
    raise exception 'INVALID_NOTIFICATION_TYPE' using errcode = '22023';
  end if;

  if length(btrim(p_title)) < 1 or length(p_title) > 200 then
    raise exception 'INVALID_NOTIFICATION_TITLE' using errcode = '22023';
  end if;

  if p_body is not null and length(p_body) > 2000 then
    raise exception 'INVALID_NOTIFICATION_BODY' using errcode = '22023';
  end if;

  if coalesce(p_severity, 'INFO') not in ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL') then
    raise exception 'INVALID_NOTIFICATION_SEVERITY' using errcode = '22023';
  end if;

  if p_resource_id is not null and p_resource_type is null then
    raise exception 'INVALID_NOTIFICATION_RESOURCE' using errcode = '22023';
  end if;

  -- METADATA: object-only, bounded to 16 KB — identical rule and bound
  -- to private.record_audit_event, checked here BEFORE the insert as the
  -- same kind of database-boundary validation this codebase applies
  -- everywhere, independent of whatever the future calling RPC already
  -- checked.
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'INVALID_NOTIFICATION_METADATA' using errcode = '22023';
  end if;
  if octet_length(p_metadata::text) > 16384 then
    raise exception 'NOTIFICATION_METADATA_TOO_LARGE' using errcode = '22023';
  end if;

  if p_dedup_key is not null and length(p_dedup_key) > 200 then
    raise exception 'INVALID_NOTIFICATION_DEDUP_KEY' using errcode = '22023';
  end if;

  -- BRANCH CONSISTENCY: a supplied branch must belong to the SAME
  -- business — never trusted from the caller's own claim, identical
  -- rule and error posture to record_audit_event's own
  -- AUDIT_BRANCH_MISMATCH check.
  if p_branch_id is not null then
    select id into v_branch_found
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_found is null then
      raise exception 'NOTIFICATION_BRANCH_MISMATCH' using errcode = '22023';
    end if;
  end if;

  -- RECIPIENT VALIDATION: a non-empty, sanity-bounded array, every
  -- element of which must be a REAL, currently ACTIVE member of THIS
  -- business — never trusted merely because the caller supplied it.
  -- Fails the WHOLE call if even one target is invalid (atomic,
  -- fail-closed) rather than silently notifying a partial set.
  if p_recipient_user_ids is null or array_length(p_recipient_user_ids, 1) is null then
    raise exception 'INVALID_NOTIFICATION_RECIPIENTS' using errcode = '22023';
  end if;
  if array_length(p_recipient_user_ids, 1) > 10000 then
    raise exception 'INVALID_NOTIFICATION_RECIPIENTS' using errcode = '22023';
  end if;
  -- A NULL element inside the array (e.g. array[null]::uuid[]) would
  -- otherwise silently evade the NOT EXISTS membership check below —
  -- `bm.user_id = NULL` is never true NOR false (it's UNKNOWN), so
  -- `NOT EXISTS(...)` for a NULL element would itself select that NULL
  -- into v_missing, and `v_missing is not null` would then evaluate to
  -- FALSE, letting a null-uuid recipient through undetected. The table's
  -- own `user_id uuid not null` constraint would still reject the
  -- eventual INSERT (this is not an exploitable gap), but only with a
  -- raw, uncontrolled NOT NULL-violation error instead of this
  -- function's own clear, structured one — closed explicitly here
  -- rather than left to that accidental backstop. `array_position(arr,
  -- null)` cannot be used for this (it uses `=` semantics, which is
  -- never true for NULL, so it always returns NULL regardless of actual
  -- content); `array_remove(arr, null)` is Postgres's own documented
  -- special case that DOES strip real NULL elements, so a
  -- cardinality mismatch before/after proves at least one was present.
  if cardinality(p_recipient_user_ids) <> cardinality(array_remove(p_recipient_user_ids, null)) then
    raise exception 'INVALID_NOTIFICATION_RECIPIENTS' using errcode = '22023';
  end if;

  select bm_check.uid into v_missing
  from unnest(p_recipient_user_ids) as bm_check(uid)
  where not exists (
    select 1 from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = bm_check.uid
      and bm.status = 'active'
  )
  limit 1;

  if v_missing is not null then
    raise exception 'NOTIFICATION_RECIPIENT_NOT_MEMBER' using errcode = '22023';
  end if;

  -- DEDUPLICATION: attempt the insert; ON CONFLICT means an identical
  -- (business_id, dedup_key) notification already exists — a replay.
  -- p_dedup_key IS NULL bypasses the conflict target entirely (every
  -- NULL is distinct under the partial unique index), so a one-off
  -- notification with no dedup key always inserts fresh.
  if p_dedup_key is not null then
    insert into public.notifications (
      business_id, branch_id, category, notification_type, title, body,
      severity, resource_type, resource_id, metadata, dedup_key
    ) values (
      p_business_id, p_branch_id, p_category, p_notification_type, p_title, p_body,
      coalesce(p_severity, 'INFO'), p_resource_type, p_resource_id, p_metadata, p_dedup_key
    )
    on conflict (business_id, dedup_key) where dedup_key is not null do nothing
    returning id into v_id;

    if v_id is null then
      -- Replay: return the EXISTING notification's id, untouched.
      -- Recipient fan-out is deliberately skipped entirely on a replay —
      -- see this file's own header comment on why recipient-set drift
      -- across replays is an accepted, documented limitation.
      select id into v_id
      from public.notifications
      where business_id = p_business_id and dedup_key = p_dedup_key;
      return v_id;
    end if;
  else
    insert into public.notifications (
      business_id, branch_id, category, notification_type, title, body,
      severity, resource_type, resource_id, metadata, dedup_key
    ) values (
      p_business_id, p_branch_id, p_category, p_notification_type, p_title, p_body,
      coalesce(p_severity, 'INFO'), p_resource_type, p_resource_id, p_metadata, null
    )
    returning id into v_id;
  end if;

  -- Recipient fan-out — only reached on a genuinely NEW notification.
  -- ON CONFLICT DO NOTHING makes this idempotent independent of
  -- dedup_key, in case the SAME user id ever appears twice in
  -- p_recipient_user_ids within a single call.
  foreach v_user_id in array p_recipient_user_ids loop
    insert into public.notification_recipients (notification_id, business_id, user_id)
    values (v_id, p_business_id, v_user_id)
    on conflict (notification_id, user_id) do nothing;
  end loop;

  return v_id;
end;
$$;

-- private_notification_writer --------------------------------------------
--
-- NOLOGIN NOINHERIT: cannot establish a session, does not automatically
-- inherit any other role's privileges. BYPASSRLS: required because both
-- public.notifications and public.notification_recipients FORCE row
-- level security with no INSERT policy for any role — the only way to
-- insert is to bypass RLS entirely, identical to private_audit_writer.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_notification_writer') then
    create role private_notification_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_notification_writer to postgres;

grant usage on schema public to private_notification_writer;
grant usage on schema private to private_notification_writer;

-- Minimum privileges only. INSERT plus SELECT on exactly the columns
-- this function body reads or returns — never a broader grant. SELECT
-- (id, business_id, dedup_key) covers both the RETURNING clause on
-- first insert and the replay lookup; the WHERE clause in that lookup
-- also references business_id/dedup_key, which therefore also require
-- SELECT privilege, not just the columns nominally "returned".
grant insert on public.notifications to private_notification_writer;
grant select (id, business_id, dedup_key) on public.notifications to private_notification_writer;

-- INSERT plus SELECT on exactly the two arbiter columns of the
-- `ON CONFLICT (notification_id, user_id) DO NOTHING` clause this
-- function's own recipient fan-out loop issues. Postgres requires
-- SELECT privilege on every column the ON CONFLICT clause needs to
-- check for a conflict — even for DO NOTHING, not only DO UPDATE — the
-- exact same category of gotcha private_sale_return_writer's own
-- `sale_returns` grant hit in Phase 1I (and private_audit_writer's own
-- header comment already documents for RETURNING); discovered here via
-- a live "permission denied for table notification_recipients" error
-- and fixed proactively rather than left as a footgun for later.
grant insert on public.notification_recipients to private_notification_writer;
grant select (notification_id, user_id) on public.notification_recipients to private_notification_writer;

-- Read-only, for the branch/business consistency check — narrowed to
-- exactly the two columns that check reads, mirroring
-- private_audit_writer's identical business_branches grant.
grant select (id, business_id) on public.business_branches to private_notification_writer;

-- Read-only, for the recipient-membership validation — narrowed to
-- exactly the three columns that check reads.
grant select (business_id, user_id, status) on public.business_members to private_notification_writer;

grant create on schema private to private_notification_writer;
alter function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) owner to private_notification_writer;
revoke create on schema private from private_notification_writer;

-- No EXECUTE grant to ANY role here — not `authenticated`, not
-- `service_role`, not `anon`, not `PUBLIC` (Postgres grants EXECUTE on a
-- newly created function to PUBLIC by default; explicitly revoked, never
-- left to that default). This function has NO caller at all yet — a
-- future Phase 1K application round grants EXECUTE to specific existing
-- private writer roles, one at a time — see this file's own header
-- comment.
revoke all on function private.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, text, uuid, jsonb, text
) from public, anon, authenticated, service_role;
