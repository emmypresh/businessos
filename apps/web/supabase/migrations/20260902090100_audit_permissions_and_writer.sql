-- Phase 1J: audit.view permission seeding + the trusted, sole write path
-- for public.audit_events (private.record_audit_event).
--
-- ══════════════════════════════════════════════════════════════════════
-- WRITE ARCHITECTURE — WHY OPTION B (internal private function called by
-- existing/future trusted mutation RPCs), NOT triggers, NOT an
-- application-layer second write.
-- ══════════════════════════════════════════════════════════════════════
--
-- Three patterns were evaluated, per this phase's own explicit request:
--
--   A. DATABASE TRIGGERS on each mutated table. Atomic and hard to
--      bypass, but a trigger only ever sees the table's OWN row-level
--      before/after state — it cannot express "the caller's intent was a
--      RETURN with restock=true" versus "a raw UPDATE happened to this
--      row for some other reason," and a trigger fired on every write to
--      every audited table becomes noisy and hard to keep semantically
--      meaningful as new mutation shapes are added. Rejected as the
--      PRIMARY mechanism for this reason, though nothing here forecloses
--      a future, narrowly-scoped trigger for a specific table where a
--      trigger genuinely is the right tool (e.g. detecting a DIRECT,
--      unexpected table mutation that bypassed every known RPC entirely —
--      a defense-in-depth backstop, not the main recording path).
--   B. AN INTERNAL PRIVATE FUNCTION, CALLED BY THE MUTATION'S OWN
--      TRUSTED RPC, inside the SAME transaction. Atomic (the audit row
--      commits or rolls back together with the business mutation it
--      describes — no "mutation succeeded but audit failed" split
--      outcome), semantic (the calling RPC already knows exactly what
--      happened and why — "this is a RETURN, this is its reason, this is
--      its refund amount" — context a trigger can never reconstruct from
--      row deltas alone), and trusted (only a SECURITY DEFINER function
--      already granted EXECUTE on this one can ever call it — see the
--      grants below). CHOSEN.
--   C. A SEPARATE APPLICATION-LAYER RPC CALL, invoked by the Server
--      Action AFTER its mutation call succeeds. Simplest to build, but
--      structurally unsound for an audit trail specifically: (1) NOT
--      atomic — the business mutation can commit while the second,
--      independent network round-trip to record the audit event fails
--      (a dropped connection, a server restart between the two calls),
--      silently producing an incomplete history exactly where a security
--      audit trail can least afford one; (2) if the audit-recording RPC
--      is reachable by an ordinary authenticated caller at all (which it
--      would have to be, to be callable from a Server Action), that same
--      caller can invoke it DIRECTLY, at any time, with any
--      action/category/resource combination — fabricating
--      "staff.deleted" or "refund.approved" events that never happened.
--      Rejected.
--
-- CONCLUSION: private.record_audit_event below is NEVER exposed via a
-- public.* wrapper, and NEVER granted EXECUTE to `authenticated` at all.
-- It is designed to be called ONLY from inside another SECURITY DEFINER
-- mutation RPC's own function body, in the same transaction, using
-- already-validated values that RPC itself derived (the caller's real
-- identity via private.current_uid(), the resource ids it just
-- inserted, etc.) — never a raw, untrusted, caller-supplied value. This
-- round instruments NO existing mutation RPC yet (explicitly deferred,
-- per this phase's own "DATABASE FOUNDATION ONLY" scope) — future
-- Phase 1J work grants EXECUTE on this function to each specific
-- existing writer role (private_sale_writer, private_invoice_writer,
-- private_sale_return_writer, ...) via its own additive migration, one
-- at a time, as each mutation RPC is instrumented — never a blanket
-- grant, and never by editing that RPC's own frozen migration file (a
-- CREATE OR REPLACE with the identical signature in a NEW migration,
-- mirroring apply_inventory_movement's own established extension
-- pattern).
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Every future `grant execute on function private.record_audit_event  │
-- │ ... to private_<x>_writer` is itself a security-relevant change —   │
-- │ it hands that RPC the ability to write permanent, business-visible  │
-- │ history — and should be reviewed with the same scrutiny as any      │
-- │ other new cross-role EXECUTE dependency in this codebase.            │
-- └─────────────────────────────────────────────────────────────────────┘

insert into public.permissions (key, description) values
  ('audit.view', 'View the business audit and activity trail.')
on conflict (key) do nothing;

-- Seeded matrix, per this phase's own recommended list, inspected against
-- this codebase's existing philosophy first: every other Phase 1C-1I
-- "oversight" permission (reports.view, invoices.view, payments.view) is
-- granted to the SAME management/financial tier and withheld from the
-- floor-operations tier (SALES/INVENTORY) and from VIEWER's own generic
-- read-only role — audit.view follows that identical, already-established
-- pattern exactly, never a new philosophy invented for this one
-- permission. audit.manage is deliberately NOT introduced — there is no
-- concrete Phase 1J need for it yet (audit history is written only by
-- trusted internal mechanisms, never "managed" by any user), and adding
-- an unused permission key would be exactly the kind of speculative
-- surface this codebase's own conventions avoid elsewhere.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name in ('OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT')
  and p.key = 'audit.view'
on conflict do nothing;

-- SALES, INVENTORY, and VIEWER deliberately get no audit.view — the
-- audit trail is a business-security/oversight surface, not a
-- floor-operations or generic-read-only concern, mirroring
-- reports.view's own identical exclusion of those same three roles.

-- private_audit_writer -------------------------------------------------
--
-- NOLOGIN NOINHERIT: cannot be used to establish a session, and does not
-- automatically inherit any other role's privileges. BYPASSRLS: required
-- because public.audit_events FORCES row level security with no INSERT
-- policy for any role at all — the only way to insert is to bypass RLS
-- entirely, exactly like every other Phase 1C-1I private writer role.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_audit_writer') then
    create role private_audit_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_audit_writer to postgres;

grant usage on schema public to private_audit_writer;
grant usage on schema private to private_audit_writer;

-- Minimum privileges only. INSERT plus SELECT(id) — Postgres's own
-- `INSERT ... RETURNING id` requires SELECT privilege on every returned
-- column, in addition to INSERT (the exact same requirement that
-- surfaced, and was fixed, for private_sale_return_writer's own
-- `sale_returns` grant in Phase 1I — applied proactively here rather
-- than rediscovered by the same failure again). No UPDATE/DELETE
-- privilege at all — this role's own function body never issues either.
grant insert on public.audit_events to private_audit_writer;
grant select (id) on public.audit_events to private_audit_writer;

-- Read-only, for the branch/business consistency check below — narrowed
-- to exactly the two columns that check reads.
grant select (id, business_id) on public.business_branches to private_audit_writer;

-- record_audit_event -----------------------------------------------------
--
-- The SOLE write path for public.audit_events. See this file's own
-- header comment for the full write-architecture rationale. Every
-- validation rule here is enforced BEFORE the INSERT, and duplicated (as
-- CHECK constraints) on the table itself as a structural backstop —
-- matching this codebase's own established dual-validation convention.
--
-- ACTOR AUTHORITY: p_actor_user_id is a plain parameter, never re-derived
-- from private.current_uid() inside this function. This is deliberate,
-- not an oversight: this function has NO application-facing caller at
-- all (see the grants below — EXECUTE is never granted to
-- `authenticated`) — its ONLY callers are other SECURITY DEFINER mutation
-- RPCs, which have ALREADY authenticated the real caller via their own
-- private.current_uid() call before ever reaching this function, and
-- which may in principle call this on behalf of a genuinely
-- non-interactive SYSTEM actor (no session, no auth.uid() at all) in the
-- future. Re-deriving identity here would therefore be both redundant
-- for the USER case and actively wrong for a future SYSTEM case. The
-- caller-forgery risk this might otherwise create is closed structurally,
-- one level up: nothing untrusted can ever reach this parameter, because
-- nothing untrusted can ever call this function.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ FUTURE-INSTRUMENTATION TRUST-BOUNDARY REQUIREMENT (Codex DB review,  │
-- │ noted as non-exploitable INFO for this round — no user-facing role   │
-- │ and no current mutation function holds EXECUTE on this function      │
-- │ yet, so p_actor_user_id cannot currently be forged by anyone).       │
-- │                                                                       │
-- │ Before granting EXECUTE on private.record_audit_event to ANY future   │
-- │ mutation writer role, that writer's OWN function body must derive     │
-- │ the actor identity it passes as p_actor_user_id from its OWN fresh,   │
-- │ server-authoritative identity check (private.current_uid(), exactly   │
-- │ as every existing Phase 1C-1I mutation RPC already does for its own   │
-- │ authorization) — NEVER from a client-supplied parameter of any kind.  │
-- │ A future writer that accepted an arbitrary caller-supplied actor id   │
-- │ and forwarded it here would reintroduce exactly the impersonation     │
-- │ risk this function's own design otherwise closes structurally. This   │
-- │ MUST be checked, specifically, as part of the security review for     │
-- │ every future "grant execute ... to private_<x>_writer" change noted   │
-- │ in this file's own header comment above.                              │
-- └─────────────────────────────────────────────────────────────────────┘
create or replace function private.record_audit_event(
  p_business_id             uuid,
  p_actor_type              text,
  p_actor_user_id           uuid,
  p_action                  text,
  p_category                text,
  p_branch_id               uuid default null,
  p_actor_email_snapshot    text default null,
  p_actor_name_snapshot     text default null,
  p_resource_type           text default null,
  p_resource_id             uuid default null,
  p_resource_label_snapshot text default null,
  p_outcome                 text default 'SUCCESS',
  p_metadata                jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_found uuid;
  v_id           uuid;
begin
  if p_business_id is null or p_actor_type is null or p_action is null or p_category is null then
    raise exception 'p_business_id, p_actor_type, p_action, and p_category are required'
      using errcode = '22023';
  end if;

  if p_actor_type not in ('USER', 'SYSTEM') then
    raise exception 'INVALID_AUDIT_ACTOR_TYPE' using errcode = '22023';
  end if;
  -- Real biconditional, matching the table's own CHECK: a USER event
  -- without an actor and a non-USER event WITH one are both structurally
  -- rejected here, before the row is ever built.
  if (p_actor_type = 'USER') <> (p_actor_user_id is not null) then
    raise exception 'INVALID_AUDIT_ACTOR' using errcode = '22023';
  end if;

  if p_action !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' or length(p_action) > 100 then
    raise exception 'INVALID_AUDIT_ACTION' using errcode = '22023';
  end if;

  if p_category not in ('COMMERCE', 'INVENTORY', 'FINANCE', 'CUSTOMER', 'ORGANIZATION', 'SECURITY', 'SYSTEM') then
    raise exception 'INVALID_AUDIT_CATEGORY' using errcode = '22023';
  end if;

  if coalesce(p_outcome, 'SUCCESS') not in ('SUCCESS', 'FAILED', 'DENIED') then
    raise exception 'INVALID_AUDIT_OUTCOME' using errcode = '22023';
  end if;

  if p_resource_id is not null and p_resource_type is null then
    raise exception 'INVALID_AUDIT_RESOURCE' using errcode = '22023';
  end if;

  -- METADATA: object-only, bounded to 16 KB of serialized text — see
  -- create_audit_events.sql's own header comment for the exact rationale
  -- and the chosen bound. Checked here, BEFORE the insert, exactly like
  -- every Phase 1H/1I money/quantity precision check in this codebase
  -- validates at the DATABASE boundary independently of any
  -- application-layer check that may or may not have already run.
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'INVALID_AUDIT_METADATA' using errcode = '22023';
  end if;
  if octet_length(p_metadata::text) > 16384 then
    raise exception 'AUDIT_METADATA_TOO_LARGE' using errcode = '22023';
  end if;

  -- BRANCH CONSISTENCY (design principle 4 + "BRANCH CONSISTENCY"
  -- section): a supplied branch must belong to the SAME business — never
  -- trusted from the caller's own claim. A mismatched/foreign/nonexistent
  -- branch is rejected with one generic code, matching this codebase's
  -- own non-disclosure posture for foreign/nonexistent resources
  -- elsewhere (there is no meaningful caller here to "disclose" anything
  -- to anyway, since this function has no untrusted caller at all — but
  -- the uniform treatment costs nothing and keeps this function
  -- consistent with the rest of the schema).
  if p_branch_id is not null then
    select id into v_branch_found
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_found is null then
      raise exception 'AUDIT_BRANCH_MISMATCH' using errcode = '22023';
    end if;
  end if;

  insert into public.audit_events (
    business_id, branch_id, actor_type, actor_user_id,
    actor_email_snapshot, actor_name_snapshot, action, category,
    resource_type, resource_id, resource_label_snapshot, outcome, metadata
  ) values (
    p_business_id, p_branch_id, p_actor_type, p_actor_user_id,
    p_actor_email_snapshot, p_actor_name_snapshot, p_action, p_category,
    p_resource_type, p_resource_id, p_resource_label_snapshot,
    coalesce(p_outcome, 'SUCCESS'), p_metadata
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant create on schema private to private_audit_writer;
alter function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) owner to private_audit_writer;
revoke create on schema private from private_audit_writer;

-- No EXECUTE grant to ANY role here — not `authenticated`, not
-- `service_role`, not `anon`, not `PUBLIC` (Postgres grants EXECUTE on a
-- newly created function to PUBLIC by default; explicitly revoked, never
-- left to that default). This function has NO caller at all yet — future
-- Phase 1J instrumentation work grants EXECUTE to specific existing
-- private writer roles, one at a time, in its own additive migrations —
-- see this file's own header comment.
revoke all on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
