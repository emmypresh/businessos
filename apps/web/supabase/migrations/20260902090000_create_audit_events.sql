-- Phase 1J: audit + activity trail — DATABASE FOUNDATION ONLY.
--
-- This migration creates the durable, append-only audit table itself,
-- its indexes, and its read-only RLS/grant surface. The trusted write
-- mechanism (private.record_audit_event) is deliberately a SEPARATE
-- migration (20260902090100_audit_permissions_and_writer.sql) — see that
-- file's own header comment for the write-architecture rationale.
--
-- SCOPE: a business-security and operational audit trail, not a full
-- analytics/event-tracking system. No existing Phase 1A-1I mutation RPC
-- is instrumented by this round — that is deliberately deferred to a
-- future Phase 1J round, via its own additive migrations extending each
-- mutation RPC individually (never by editing a frozen migration file).
--
-- APPEND-ONLY (design principle 1): there is no INSERT/UPDATE/DELETE
-- policy for `authenticated` at all, and no GRANT of those privileges
-- either — see the grants section below. The only path that can ever
-- write a row is private.record_audit_event, owned by a dedicated,
-- narrow, NOLOGIN role.
--
-- TENANT ISOLATION (design principle 3): every row belongs to exactly
-- one business_id, NOT NULL, FK'd to public.businesses.
--
-- Codex DB review, SEC-01J ("Audit history deleted by business cascade"):
-- business_id's own FK is `on delete restrict` — deliberately NOT
-- `cascade`, and NOT `set null` either. A business-security audit trail
-- exists specifically to survive whatever happened to the business it
-- describes; a CASCADE would let an authorized business deletion
-- silently erase every audit record proving what that business's own
-- staff ever did — the exact opposite of this table's purpose, and the
-- one design choice this phase's own review correctly rejected as a
-- durability defect. RESTRICT was chosen over SET NULL because
-- business_id is this row's own TENANT IDENTITY, not an optional
-- reference — a NULL business_id would detach a historical event from
-- the very business it belongs to, which this schema's own "every audit
-- record belongs to exactly one business" principle (and its NOT NULL
-- constraint, deliberately never weakened) forecloses. RESTRICT was
-- chosen over CASCADE-to-an-archive-table or any other soft-delete
-- machinery because no business archival/soft-delete workflow exists in
-- this codebase yet (there is no business deletion RPC of any kind, as
-- of this migration — confirmed by inspection) — RESTRICT is the
-- smallest, safest choice available today: it makes a business
-- undeletable, using only Postgres's own default FK enforcement, for as
-- long as it has any audit history at all, with zero new schema
-- surface. `restrict` and `no action` differ only in a same-transaction
-- deferred-constraint edge case that never applies here (this FK is NOT
-- declared DEFERRABLE); RESTRICT was chosen as the more explicit,
-- self-documenting keyword for a reader — Postgres treats them
-- identically in every other respect for a NOT DEFERRABLE constraint.
--
-- PRODUCT CONSEQUENCE (documented, not solved in this round): BusinessOS
-- cannot currently hard-delete a business once it has any audit history
-- — which, once instrumentation work begins, will be effectively
-- immediately for any real business. This is an ACCEPTED, deliberate
-- limitation for Phase 1J, not an oversight. A future phase must
-- introduce a genuine archival/soft-delete/controlled-retention workflow
-- for business removal (e.g. a status flag plus a narrow, audited,
-- admin-only "archive this business" operation) rather than a
-- destructive `DELETE FROM public.businesses` — building that workflow
-- is explicitly OUT of scope for this round.
--
-- BRANCH OPTIONALITY (design principle 4): branch_id is nullable (many
-- audit-worthy actions — business settings changes, staff role changes,
-- security events — are business-wide, not tied to any one branch). When
-- present, it must belong to the SAME business — enforced via a
-- composite tenant-consistent FK, mirroring every other Phase 1C-1I
-- child table's own identical treatment.
--
-- NO POLYMORPHIC FK (per this phase's own explicit instruction):
-- resource_type/resource_id identify the affected object by convention
-- only, never by a real foreign key — the referenced row may later be
-- archived or (in principle) deleted, and audit history must remain
-- durable regardless. resource_label_snapshot preserves human
-- readability independent of the resource's own current state.

create table public.audit_events (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses (id) on delete restrict,
  -- Branch optionality + tenant-consistent composite FK — see header
  -- comment. NO ACTION (never CASCADE) — re-inspected under SEC-01J
  -- specifically to confirm it introduces no destructive path of its
  -- own: a branch is never hard-deleted by any existing code path (only
  -- deactivated — see business_branches' own status column), so this FK
  -- is a structural safety net, not a path any current code exercises,
  -- and it was already correct before this remediation — left unchanged.
  -- Kept DEFERRABLE INITIALLY DEFERRED, matching every other Phase 1C-1I
  -- child-table's own identical composite FK (originally so a
  -- whole-business CASCADE delete could drop businesses ->
  -- business_branches -> child-row together in one transaction without a
  -- false cascade-ordering violation) — this no longer matters in
  -- practice for THIS table specifically, since business_id's own new
  -- RESTRICT (see above, SEC-01J) blocks any whole-business delete before
  -- Postgres would ever reach business_branches or evaluate this
  -- constraint at all, but the deferrable declaration is harmless and
  -- changing it is unrelated to the SEC-01J fix — left as-is to avoid
  -- expanding this remediation's own scope.
  branch_id                uuid,
  -- ACTOR MODEL (design principle 2, "server authority" +
  -- "actor model"): USER today; SYSTEM reserved for a future
  -- non-interactive/scheduled writer (there is no code path that
  -- produces SYSTEM rows yet). EDGE/INTEGRATION are deliberately NOT
  -- added as recognized values yet — widening this CHECK later, when a
  -- real non-human writer exists, is a normal additive migration; adding
  -- speculative values nothing can ever produce would only be a false
  -- affordance. A USER row must always carry actor_user_id (and a
  -- non-USER row must never carry one) — enforced as a real biconditional
  -- below, matching this schema's own established
  -- "(status = X) = (column is not null)" convention.
  actor_type               text not null check (actor_type in ('USER', 'SYSTEM')),
  actor_user_id            uuid references auth.users (id),
  -- Historical actor identity, captured once at write time — never
  -- re-derived from the live business_members/auth.users row. A later
  -- name/email change, or the member being removed entirely, must not
  -- alter how an already-recorded event renders. Deliberately NOT the
  -- member's own phone/address or any other contact/PII beyond what is
  -- already always visible to any audit.view holder as "who did this"
  -- (design principle 6, "minimal sensitive data").
  actor_email_snapshot     text,
  actor_name_snapshot      text,
  -- ACTION NAMING: stable, machine-readable, lowercase
  -- dot-and-underscore-segmented keys (e.g. "sale.created",
  -- "return.created") — never human prose. Bounded length as a cheap,
  -- deterministic guard against a runaway/malformed caller (this table
  -- has no untrusted caller today, since only
  -- private.record_audit_event can ever insert into it — but the CHECK
  -- exists as the same structural backstop every other Phase 1C-1I table
  -- keeps even though only its own RPC ever writes to it).
  action                   text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(action) <= 100),
  -- CATEGORY: a bounded, deliberately small classification model — see
  -- this migration's own header comment on why these seven values (not
  -- more) cover every use case this phase's own product brief names.
  category                 text not null check (category in (
                              'COMMERCE', 'INVENTORY', 'FINANCE', 'CUSTOMER',
                              'ORGANIZATION', 'SECURITY', 'SYSTEM'
                            )),
  -- RESOURCE REFERENCES: convention only, never a real FK — see header
  -- comment. resource_id without resource_type would be meaningless (an
  -- id identifying nothing in particular), so that one combination is
  -- structurally rejected; resource_type alone (no specific id — e.g. a
  -- bulk/collection-level action) is permitted.
  resource_type            text,
  resource_id              uuid,
  resource_label_snapshot  text,
  -- OUTCOME: SUCCESS is the only value any current code path produces.
  -- FAILED/DENIED are recognized by the schema now (per this phase's own
  -- instruction to "design schema to support them but only instrument
  -- SUCCESS initially") so a future round can start recording them
  -- without a schema migration, but private.record_audit_event's own
  -- default is 'SUCCESS' and nothing in this round ever passes another
  -- value.
  outcome                  text not null default 'SUCCESS' check (outcome in ('SUCCESS', 'FAILED', 'DENIED')),
  -- METADATA CONSTRAINTS (design principle 6 + "METADATA" section):
  -- object-only (never an array or top-level scalar — jsonb_typeof is
  -- the authoritative shape check, not merely "is valid JSON"), and
  -- bounded to 16 KB of its own serialized text form. 16 KB was chosen
  -- as a generous-but-real ceiling for a handful of small, structured
  -- context fields (e.g. { "quantity": 5, "reason": "DAMAGED" }) — large
  -- enough that no legitimate audit annotation is ever truncated, small
  -- enough that this table can never become an indiscriminate log/blob
  -- dump (a single row's metadata is capped at roughly the size of two
  -- pages of plain text). Enforced identically here AND in
  -- private.record_audit_event (defense in depth, matching this
  -- codebase's own dual-validation convention throughout).
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),

  check (resource_id is null or resource_type is not null),
  check ((actor_type = 'USER') = (actor_user_id is not null)),
  check (jsonb_typeof(metadata) = 'object'),
  check (octet_length(metadata::text) <= 16384),

  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

-- INDEXING — one per the query shape this phase's own "QUERYABILITY"
-- section names, and no more (design principle: "avoid excessive
-- indexes"). Every index leads with business_id: audit_events has no
-- query pattern that is ever NOT scoped to a single business.
create index audit_events_business_created_idx
  on public.audit_events (business_id, created_at desc, id desc);
create index audit_events_business_actor_created_idx
  on public.audit_events (business_id, actor_user_id, created_at desc)
  where actor_user_id is not null;
create index audit_events_business_action_created_idx
  on public.audit_events (business_id, action, created_at desc);
create index audit_events_business_resource_idx
  on public.audit_events (business_id, resource_type, resource_id, created_at desc)
  where resource_type is not null;
create index audit_events_branch_created_idx
  on public.audit_events (branch_id, created_at desc)
  where branch_id is not null;

-- Row Level Security ---------------------------------------------------
--
-- READ MODEL (design principle: branch visibility decision, documented):
-- audit.view is BUSINESS-WIDE, never narrowed to the caller's own
-- operational branch assignment. Security/audit oversight is precisely
-- the kind of function that needs a COMPLETE organizational history, not
-- a partial one silently filtered by whichever branches the viewer
-- happens to be assigned to today — mirrors invoices.view's/sales.view's
-- own established "business-wide, not branch-scoped" precedent exactly,
-- and is the opposite of create_sale_return's own branch-authority model
-- (which restricts MUTATION to the caller's own branch — a completely
-- different concern from READING an audit trail of everything that
-- already happened).
--
-- APPEND-ONLY: no INSERT/UPDATE/DELETE policy exists for `authenticated`
-- at all — those operations are denied by RLS regardless of any future
-- policy oversight elsewhere, and are ALSO denied at the GRANT layer
-- below (defense in depth: even a future accidental permissive policy
-- could not restore write access without an explicit GRANT too).

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy audit_events_select on public.audit_events
  for select
  to authenticated
  using (private.has_permission(business_id, 'audit.view'));

-- GRANTS — explicit, never relying on defaults (this Supabase project's
-- own `api.auto_expose_new_tables = false` convention, matching every
-- other Phase 1C-1I table's own header comment). SELECT only, for
-- `authenticated` (gated by the RLS policy above) and `service_role`
-- (which bypasses RLS entirely, for admin/internal tooling) — no
-- INSERT/UPDATE/DELETE/TRUNCATE grant to either, and none to `anon` or
-- `PUBLIC` at all.
revoke all on public.audit_events from public, anon, authenticated, service_role;
grant select (
  id, business_id, branch_id, actor_type, actor_user_id, actor_email_snapshot,
  actor_name_snapshot, action, category, resource_type, resource_id,
  resource_label_snapshot, outcome, metadata, created_at
) on public.audit_events to authenticated, service_role;
revoke references, trigger, truncate on public.audit_events from anon, authenticated;

-- RETENTION (documented, not implemented — per this phase's own explicit
-- instruction not to build deletion/retention automation now): this
-- table has no TTL, partition, or archival mechanism today, and will grow
-- monotonically with normal business activity. Any future retention or
-- archival policy MUST be an admin/system-controlled, explicitly
-- authorized operation (e.g. a narrow, audited, superuser-run
-- maintenance job) — never a path reachable by an ordinary authenticated
-- user's own DELETE, since that would contradict this table's entire
-- append-only purpose. No such mechanism exists yet; this comment exists
-- so a future implementer does not casually add a user-facing "clear
-- history" action.
