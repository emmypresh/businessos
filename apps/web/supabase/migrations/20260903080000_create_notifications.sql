-- Phase 1K: notifications + alerts — DATABASE FOUNDATION ONLY.
--
-- This migration creates the durable notification record itself: what
-- happened, to which business/branch, and why — never who it was shown
-- to (that is public.notification_recipients, a separate migration) and
-- never how a given user wants to be notified about it (that is
-- public.notification_preferences, also separate). Mirrors
-- 20260902090000_create_audit_events.sql's own three-migration split
-- philosophy (table -> recipients/writer -> preferences), and reuses
-- that migration's design principles wherever they transfer directly,
-- documenting any deliberate deviation inline.
--
-- SCOPE: a targeted, permission-and-branch-aware in-app notification
-- system for business-relevant events (low stock, overdue invoices,
-- staff actions, security alerts, ...) — NOT a generic arbitrary
-- messaging system. There is no "send an arbitrary message to
-- an arbitrary user" capability anywhere in this schema: every row this
-- table can ever hold is produced by a single trusted internal writer
-- (private.create_notification, in its own migration) with a fixed,
-- validated shape. No mutation RPC is instrumented to CALL that writer
-- in this round — exactly like audit_events' own DB-foundation-only
-- round, that is deliberately deferred to a future Phase 1K application
-- round, via additive migrations granting EXECUTE one writer role at a
-- time.
--
-- WHY THREE TABLES (public.notifications / notification_recipients /
-- notification_preferences), NOT ONE WIDE TABLE: a notification is ONE
-- historical fact ("low stock on product X at branch Y"), but it may
-- have MANY recipients (every INVENTORY_VIEW holder assigned to that
-- branch), each with their OWN independent read/seen state — modeling
-- that as one row per (notification, recipient) is the only
-- normalized shape that does not either duplicate the notification's
-- own content per recipient (wasteful, and a durability risk if a
-- future edit path ever touched the content once per recipient instead
-- of once) or lose per-recipient state entirely. Preferences are a
-- third, orthogonal concern (a standing user setting, not tied to any
-- one notification instance) and belong in their own table for the same
-- reason business_member_branches is not folded into business_members.
--
-- TENANT ISOLATION: every row belongs to exactly one business_id, NOT
-- NULL, FK'd to public.businesses — identical in spirit to audit_events.
--
-- BUSINESS-DELETE DURABILITY: business_id uses `on delete restrict`,
-- mirroring audit_events' own SEC-01J-informed choice exactly (see that
-- migration's header comment for the full rationale) — applied here
-- PROACTIVELY, not rediscovered by the same review finding twice. A
-- business's notification history must not be silently erased by a
-- future business-deletion path any more than its audit history should;
-- there is still no business-deletion RPC anywhere in this codebase, so
-- this is a zero-cost structural guarantee today and a real one the
-- moment such a path is ever built.
--
-- APPEND-ORIENTED / HISTORICALLY STABLE: a notification's own content
-- (title, body, severity, category, type, resource reference, metadata)
-- is never edited after creation — there is no UPDATE policy for
-- `authenticated` on this table at all, and no UPDATE grant either. Only
-- a RECIPIENT's own presentation state (read_at/seen_at, on the
-- recipients table) is ever mutated post-creation. This is stronger than
-- audit_events even needs to be (audit_events has no legitimate post-hoc
-- mutation of ANY kind, including recipient-style state, since it has no
-- recipients) but the same append-only posture applies to the
-- notification record itself here for the same reason: a historical
-- "this alert fired" fact must remain trustworthy regardless of what
-- happens to the underlying resource or business afterward.
--
-- NO POLYMORPHIC FK: resource_type/resource_id identify the affected
-- object by convention only, never a real foreign key — identical
-- rationale to audit_events (the referenced row may later be archived,
-- repriced, or renamed; the notification must remain durable regardless
-- of the resource's current state). No resource_label_snapshot column is
-- added here (unlike audit_events) because a notification's own `title`
-- and `body` ARE the human-readable snapshot — a separate label field
-- would duplicate that purpose with no distinct meaning.
--
-- CATEGORY TAXONOMY REUSE: the exact same seven values as
-- audit_events.category ('COMMERCE', 'INVENTORY', 'FINANCE', 'CUSTOMER',
-- 'ORGANIZATION', 'SECURITY', 'SYSTEM') are reused verbatim, not a
-- parallel taxonomy invented for this table. Every notification type
-- this phase's own brief names (inventory.low_stock/out_of_stock ->
-- INVENTORY; invoice.overdue/payment.recorded/expense.posted -> FINANCE;
-- return.completed -> COMMERCE; staff.invited/branch.deactivated ->
-- ORGANIZATION; security alerts -> SECURITY) maps cleanly onto this
-- existing set, and a business-facing notion of "what kind of thing is
-- this" should not fragment into two different small enums maintained
-- in two different tables for no product reason.
--
-- NOTIFICATION_TYPE: unlike category, this is deliberately NOT a closed
-- enum — it follows audit_events.action's exact structural convention
-- instead (lowercase, dot-segmented, regex + length bound, no fixed
-- value list) for the identical reason: this phase's own brief already
-- names eight-plus future types, and more will be added continuously as
-- new mutations are instrumented. A closed CHECK enum would need a
-- migration for every single new notification type ever added; the
-- regex only enforces SHAPE (machine-readable, stable, bounded), never
-- the specific vocabulary, exactly like action does for audit_events.

create table public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete restrict,
  -- Branch optionality — a notification may be business-wide (null) or
  -- scoped to one branch (e.g. "low stock at the Ikeja branch"). NO
  -- ACTION + DEFERRABLE INITIALLY DEFERRED, identical to audit_events'
  -- own branch_id FK, for the identical reason (harmless today, since no
  -- code path hard-deletes a branch; consistent with every other
  -- Phase 1C-1J child table's own composite FK).
  branch_id           uuid,
  category            text not null check (category in (
                        'COMMERCE', 'INVENTORY', 'FINANCE', 'CUSTOMER',
                        'ORGANIZATION', 'SECURITY', 'SYSTEM'
                      )),
  notification_type   text not null
                        check (notification_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(notification_type) <= 100),
  title               text not null
                        check (length(btrim(title)) >= 1 and length(title) <= 200),
  body                text
                        check (body is null or length(body) <= 2000),
  severity            text not null default 'INFO'
                        check (severity in ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL')),
  -- RESOURCE REFERENCES: convention only, never a real FK — see header
  -- comment. Same biconditional as audit_events: a resource_id without a
  -- resource_type would be meaningless.
  resource_type       text,
  resource_id         uuid,
  -- METADATA CONSTRAINTS: identical to audit_events — object-only
  -- (jsonb_typeof is the authoritative shape check) and bounded to 16 KB
  -- of serialized text. Same rationale: generous enough for a handful of
  -- small structured context fields (e.g. { "quantity_on_hand": 2,
  -- "threshold": 10 }), small enough that this table can never become an
  -- indiscriminate blob store. Enforced identically here AND in
  -- private.create_notification (defense in depth, matching this
  -- codebase's dual-validation convention).
  metadata            jsonb not null default '{}'::jsonb,
  -- DEDUPLICATION / IDEMPOTENCY: an OPAQUE, caller-constructed key,
  -- unique per business when present (see the partial unique index
  -- below). Deliberately NOT a fixed, DB-enforced format beyond a length
  -- bound — the right dedup granularity differs per notification type
  -- (e.g. "one low-stock alert per product until restocked" wants a key
  -- like 'inventory.low_stock:product:<id>'; "one overdue-invoice
  -- reminder per invoice per day" wants a key that also encodes a date
  -- bucket) — that is a per-type POLICY decision that belongs with each
  -- future instrumented mutation RPC (Phase 1K application layer), not a
  -- structural rule this foundation table can usefully centralize. What
  -- the schema DOES guarantee structurally: whatever key a caller
  -- chooses, a second call with the SAME business_id + dedup_key can
  -- never produce a second notification — see
  -- private.create_notification's own replay handling.
  dedup_key           text
                        check (dedup_key is null or length(dedup_key) <= 200),
  created_at          timestamptz not null default now(),

  check (resource_id is null or resource_type is not null),

  -- SEC-1K-01 remediation (Codex DB review): the METADATA CONSTRAINTS
  -- comment above always claimed parity with audit_events' own
  -- table-level enforcement, but the two CHECK constraints themselves
  -- were missing here — private.create_notification validated
  -- jsonb_typeof/octet_length before every insert, but the table itself
  -- had no independent backstop, unlike audit_events (which carries
  -- both `check (jsonb_typeof(metadata) = 'object')` and
  -- `check (octet_length(metadata::text) <= 16384)` directly on the
  -- table — see create_audit_events.sql). Fixed by mirroring that exact
  -- pattern verbatim. This is deliberately DEFENSE IN DEPTH, not a
  -- replacement for the writer's own check: private.create_notification
  -- keeps validating both rules itself (so a caller gets a clear,
  -- structured `INVALID_NOTIFICATION_METADATA`/`NOTIFICATION_METADATA_
  -- TOO_LARGE` exception before ever reaching the table), while these
  -- CHECK constraints exist so that ANY future write path — including
  -- one that bypassed the writer entirely — can never leave a
  -- non-object or oversized metadata value in this table, exactly like
  -- audit_events already guarantees for itself.
  check (jsonb_typeof(metadata) = 'object'),
  check (octet_length(metadata::text) <= 16384),

  -- Composite key so notification_recipients can FK against
  -- (id, business_id) together, making a cross-tenant
  -- notification/recipient combination structurally unrepresentable —
  -- mirrors every other Phase 1C-1J parent/child table pair's identical
  -- `unique (id, business_id)` convention.
  unique (id, business_id),

  foreign key (branch_id, business_id)
    references public.business_branches (id, business_id)
    on delete no action deferrable initially deferred
);

-- Deduplication uniqueness + lookup index in one structure: a business
-- can never hold two notifications with the same dedup_key, and the
-- index itself is exactly the lookup private.create_notification's own
-- replay path performs. Partial (WHERE dedup_key IS NOT NULL) so a
-- one-off notification with no dedup key never collides with another
-- one-off notification (standard Postgres unique-index NULL semantics:
-- every NULL is distinct from every other NULL).
create unique index notifications_business_dedup_key_idx
  on public.notifications (business_id, dedup_key)
  where dedup_key is not null;

-- INDEXING — one per the query shape this phase's own instructions name
-- (business-scoped lookup, branch filtering, notification type,
-- deduplication lookup — covered above — and future retention), mirrors
-- audit_events' own "lead with business_id, no more than the named
-- shapes need" discipline exactly.
create index notifications_business_created_idx
  on public.notifications (business_id, created_at desc, id desc);
create index notifications_business_type_idx
  on public.notifications (business_id, notification_type, created_at desc);
create index notifications_business_resource_idx
  on public.notifications (business_id, resource_type, resource_id, created_at desc)
  where resource_type is not null;
create index notifications_branch_created_idx
  on public.notifications (branch_id, created_at desc)
  where branch_id is not null;

-- Row Level Security ---------------------------------------------------
--
-- READ MODEL: unlike audit.view (a business-wide OVERSIGHT permission —
-- see this phase's own PERMISSIONS decision, documented in the writer
-- migration's header comment, for why notifications deliberately do NOT
-- introduce an equivalent "notifications.view" permission), a
-- notification is only ever visible to a caller who is BOTH (a) a
-- recipient of it (a row exists for them in notification_recipients)
-- and (b) a currently active member of the business it belongs to. (b)
-- is enforced independently here, not merely inherited from (a)'s own
-- table, for the same defense-in-depth reason audit_events checks
-- has_permission directly rather than trusting a join — a plain
-- PostgREST query against THIS table alone must be safe on its own.
--
-- APPEND-ONLY: no INSERT/UPDATE/DELETE policy exists for `authenticated`
-- at all — identical posture to audit_events, and for the same reason
-- (the only writer is a trusted, narrowly-granted private function).

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

-- The actual SELECT policy is created in the NEXT migration
-- (20260903080100_create_notification_recipients.sql), not here — it
-- must reference public.notification_recipients (see the READ MODEL
-- comment above), which does not exist yet at this point in the
-- migration sequence. RLS is already ENABLED and FORCED immediately
-- below, so `authenticated` reads exactly zero rows (fail-closed, never
-- an error) in the brief window before that policy is added within the
-- same `supabase db reset`/migration run.

-- GRANTS — explicit, never relying on defaults (this project's own
-- `api.auto_expose_new_tables = false` convention). SELECT only, for
-- `authenticated` (gated by the RLS policy above) and `service_role`
-- (BYPASSRLS, for admin/internal tooling) — no INSERT/UPDATE/DELETE/
-- TRUNCATE grant to either, and none to `anon`/`PUBLIC` at all.
revoke all on public.notifications from public, anon, authenticated, service_role;
grant select (
  id, business_id, branch_id, category, notification_type, title, body,
  severity, resource_type, resource_id, metadata, dedup_key, created_at
) on public.notifications to authenticated, service_role;
revoke references, trigger, truncate on public.notifications from anon, authenticated;

-- RETENTION (documented, not implemented — per this phase's own explicit
-- instruction not to build deletion/retention automation now): this
-- table has no TTL, partition, or archival mechanism today, and will
-- grow monotonically with normal business activity, exactly like
-- audit_events. Any future retention/archival policy MUST be an
-- admin/system-controlled, explicitly authorized operation — never a
-- path reachable by an ordinary authenticated user's own DELETE, which
-- would contradict this table's append-oriented purpose. The
-- business_id-leading `notifications_business_created_idx` above is
-- already shaped to support a future time-bounded archival scan
-- efficiently, without adding a dedicated index solely for that
-- not-yet-built job.
