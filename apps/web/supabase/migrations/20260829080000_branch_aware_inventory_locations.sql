-- Phase 1G: branch-aware inventory locations.
--
-- DESIGN AUDIT SUMMARY (Phase 1G, Task 1 — see the accompanying report for
-- the full reasoning): business_branches (Phase 1F — an organizational/
-- operational branch) and inventory_locations (Phase 1C — a physical stock
-- ledger location) stay deliberately SEPARATE concepts, exactly as
-- create_business_branches.sql's own header comment already promises. This
-- migration establishes the one canonical/default relationship Phase 1G
-- actually needs: every inventory_locations row now belongs to exactly one
-- branch, and every ACTIVE branch has exactly one canonical ("branch
-- default") location that public.create_sale (next migration) resolves
-- stock deduction against. A branch may still gain additional, non-default
-- locations in a later phase without disturbing this — is_branch_default
-- is a per-branch flag, not a table-wide one.
--
-- CRITICAL: this does NOT touch inventory_locations.is_default at all, in
-- meaning or in its existing partial unique index
-- (inventory_locations_one_default_idx, business_id-scoped). That column
-- keeps its EXACT Phase 1C meaning — "the one business-wide default
-- location" — because private.get_default_inventory_location_id
-- (create_product_rpc.sql) is a `language sql` function that returns a
-- bare scalar via an implicit single-row expectation
-- (`select id from inventory_locations where business_id = ... and
-- is_default = true and status = 'active'`); if a multi-branch business
-- ever had MORE than one row with is_default = true, that existing,
-- currently-shipped, unmodified function would raise a raw "more than one
-- row returned by a subquery used as an expression" error the next time
-- any caller bundles opening stock into a product — a live backward-
-- compatibility break of the current Phase 1F application, which this
-- phase must not cause. is_branch_default is therefore a BRAND NEW, wholly
-- separate column with its own BRANCH-scoped (not business-scoped) partial
-- unique index — the two flags can never collide or interact.
--
-- Structural proof this backfill is deterministic (no ambiguity to guess
-- around): Phase 1C's create_inventory_locations.sql gives `authenticated`
-- no INSERT/UPDATE/DELETE path on this table AT ALL ("no location-
-- management UI/RPC exists... authenticated has SELECT only"), and no
-- later Phase 1D/1E/1F migration ever added one either — the ONLY two
-- places any inventory_locations row is ever created are that migration's
-- own one-time backfill (exactly one row per pre-existing business) and
-- private.create_default_inventory_location's AFTER INSERT trigger on
-- `businesses` (exactly one row per new business). Therefore EVERY
-- business, without exception, has EXACTLY ONE inventory_locations row
-- today — confirmed by inspection of the frozen migration, not assumed.
-- Mapping that one row to the business's own default branch (itself
-- structurally guaranteed to exist and be ACTIVE — see the header comment
-- on the sales migration for that proof) is therefore lossless and
-- unambiguous. Any OTHER (non-default) branch that already exists at
-- migration time — created via Phase 1F's own create_business_branch RPC,
-- before this phase ships — currently has ZERO locations of its own
-- (nothing before this migration ever gave a non-default branch a
-- location), so a fresh one is created for it below; this is additive,
-- never a reassignment of any location a historical sale/ledger row
-- already references.

-- Canonical location naming ------------------------------------------
--
-- Codex adversarial review Phase 1G round 2, Medium 1: Phase 1F permits a
-- branch name up to 100 characters (business_branches' own
-- `check (length(name) <= 100 ...)`), but inventory_locations.name is
-- ALSO capped at 100 characters (`check (length(name) <= 100 ...)`,
-- create_inventory_locations.sql) — the naive `branch.name || ' Store'`
-- derivation this migration originally used could therefore exceed that
-- limit by up to 6 characters for any branch name over 94 characters,
-- raising a raw SQLSTATE 23514 and rolling back an otherwise perfectly
-- legitimate branch creation or upgrade. ONE deterministic helper is used
-- everywhere a canonical location name is derived (the historical
-- secondary-branch backfill below, and the future-branch trigger further
-- down) so the rule can never drift between the two call sites.
--
-- inventory_locations has no name-uniqueness constraint at all (confirmed
-- directly against create_inventory_locations.sql — only
-- inventory_locations_one_default_idx, a partial index on is_default, and
-- a plain business_id/status index exist) — so this deliberately does NOT
-- invent any uniqueness/collision-avoidance scheme; a long-enough branch
-- name and a very-slightly-different long-enough branch name could in
-- principle truncate to the identical location name, which is cosmetic
-- only and not a constraint violation.
--
-- The DEFAULT branch of a business always gets the fixed, Phase-1C-
-- established "Main Store" name (never a branch-name derivation, even if
-- the default branch is later renamed via update_business_branch) — this
-- is what keeps a fresh single-branch business's location name IDENTICAL
-- to a backfilled pre-existing business's own (untouched) "Main Store"
-- name, matching every existing test's own hardcoded expectation. For any
-- OTHER branch, the name is `<branch name> || ' Store'`, TRUNCATED to fit
-- inventory_locations' 100-character bound wherever the branch name alone
-- would make that exceed it: the branch-name portion is truncated to
-- exactly 94 characters (100 minus the 6-character ' Store' suffix, which
-- is therefore ALWAYS fully present, never itself cut mid-word) and
-- re-trimmed (in case truncation landed mid-whitespace), so the result is
-- always a valid, deterministic, non-random name for any branch name from
-- 1 to 100 characters — never a raw truncation bug, never a constraint
-- failure. A short branch name (the overwhelmingly common case, e.g.
-- "Benin Branch") is completely unaffected and reads exactly as before
-- ("Benin Branch Store").
create or replace function private.canonical_branch_location_name(p_branch_name text, p_is_default_branch boolean)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_is_default_branch then 'Main Store'
    when length(p_branch_name) + 6 <= 100 then p_branch_name || ' Store'
    else btrim(left(p_branch_name, 94)) || ' Store'
  end;
$$;

revoke all on function private.canonical_branch_location_name(text, boolean) from public;

alter table public.inventory_locations
  add column branch_id uuid,
  add column is_branch_default boolean not null default false;

-- Backfill 1/2: the business's one pre-existing location -> its one
-- default branch. Unconditional single UPDATE, not a loop — both sides are
-- proven exactly-one-row-per-business above, so this is a plain 1:1 join,
-- not a heuristic.
update public.inventory_locations il
set branch_id = bb.id, is_branch_default = true
from public.business_branches bb
where bb.business_id = il.business_id and bb.is_default = true;

-- Backfill 2/2: every OTHER (non-default) branch that already exists gets
-- its own brand-new canonical location — additive only, never touches a
-- location any historical row already references. The NOT EXISTS guard
-- makes this safely re-runnable (idempotent), matching every other
-- backfill in this codebase. Uses the SAME canonical-naming helper as the
-- future-branch trigger below — a pre-existing branch with a valid,
-- maximum-length (100-character) name upgrades cleanly, never raising
-- SQLSTATE 23514 (Medium 1's own confirmed reproduction).
insert into public.inventory_locations (business_id, branch_id, name, is_branch_default, is_default, status, created_by)
select bb.business_id, bb.id, private.canonical_branch_location_name(bb.name, false), true, false, 'active', bb.created_by
from public.business_branches bb
where bb.is_default = false
  and not exists (
    select 1 from public.inventory_locations il where il.branch_id = bb.id
  );

-- Every row now has a branch_id (both backfills above are exhaustive over
-- "the business's one existing location" and "every branch without one" —
-- together they cover every inventory_locations row that existed before
-- this migration, and every business_branches row).
alter table public.inventory_locations
  alter column branch_id set not null;

-- Tenant-consistent composite FK, matching every other Phase 1C/1D/1E/1F
-- child-table FK exactly: NO ACTION (not RESTRICT — RESTRICT cannot be
-- deferred in Postgres) + DEFERRABLE INITIALLY DEFERRED, so a whole-
-- business DELETE can cascade business_branches/inventory_locations
-- together in one transaction without tripping a false violation on
-- cascade-ordering, while a standalone branch row stays protected (a
-- branch is never hard-deleted by application code, but the FK itself does
-- not depend on that being true).
alter table public.inventory_locations
  add constraint inventory_locations_branch_id_business_id_fkey
  foreign key (branch_id, business_id)
  references public.business_branches (id, business_id)
  on delete no action deferrable initially deferred;

-- At most one canonical location per BRANCH — deliberately branch-scoped,
-- never business-scoped (see the header comment for why this must stay
-- entirely separate from inventory_locations_one_default_idx).
create unique index inventory_locations_one_branch_default_idx
  on public.inventory_locations (branch_id)
  where is_branch_default = true;

create index inventory_locations_business_branch_idx
  on public.inventory_locations (business_id, branch_id);

-- Future branches ---------------------------------------------------------
--
-- Every NEW branch (created via the existing, UNMODIFIED
-- public.create_business_branch RPC — this trigger fires regardless of
-- which writer performs the INSERT, so that RPC needs no changes at all)
-- automatically gets its own canonical location, exactly mirroring
-- private.create_default_inventory_location's own "AFTER INSERT ON
-- businesses" pattern. A business_branches row is always inserted ACTIVE
-- (create_business_branch never creates one INACTIVE), so "new operational
-- locations require an ACTIVE branch" holds trivially — there is no code
-- path that fires this trigger for a non-ACTIVE branch.
create or replace function private.create_default_branch_inventory_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Codex adversarial review Phase 1G round 2, Medium 1: a future branch
  -- created with a valid, maximum-length (100-character) name must never
  -- roll back with a raw SQLSTATE 23514 — the shared
  -- private.canonical_branch_location_name helper above (used identically
  -- by the historical secondary-branch backfill) guarantees a valid,
  -- deterministic, never-random inventory_locations.name for any branch
  -- name from 1 to 100 characters, truncating only the branch-name
  -- portion (never the ' Store' suffix itself) when necessary.
  insert into public.inventory_locations (business_id, branch_id, name, is_branch_default, is_default, status, created_by)
  values (
    new.business_id, new.id,
    private.canonical_branch_location_name(new.name, new.is_default),
    true, false, 'active', new.created_by
  );
  return new;
end;
$$;

revoke all on function private.create_default_branch_inventory_location() from public;

create trigger business_branches_create_default_location
  after insert on public.business_branches
  for each row
  execute function private.create_default_branch_inventory_location();

-- Phase 1C's OWN business-wide-default trigger, patched to not create a
-- REDUNDANT second location -----------------------------------------
--
-- CRITICAL ordering fact, verified directly against trigger-name
-- alphabetical order (how Postgres sequences multiple AFTER INSERT
-- triggers on the same table/event): for a NEW business,
-- "businesses_create_default_business_branch" sorts before
-- "businesses_create_default_inventory_location" ("...default_business_branch"
-- < "...default_inventory_location"), so by the time THIS trigger fires,
-- the default branch — and, via ITS OWN AFTER INSERT trigger just above,
-- that branch's canonical location — already exist. Left unmodified, the
-- ORIGINAL private.create_default_inventory_location body would try to
-- INSERT a brand-new location row with no branch_id at all, which the
-- NOT NULL constraint added above would reject outright — a live
-- creation-of-a-new-business failure, not a hypothetical. Patched instead
-- to REUSE that already-created row (setting is_default = true on it) —
-- exactly mirroring this migration's own backfill treatment of every
-- pre-existing business above ("reuse the one location, don't create a
-- second") — so a fresh single-branch business still ends up with exactly
-- ONE location, which is simultaneously the business-wide default
-- (is_default) AND its one branch's canonical location
-- (is_branch_default), matching the backfilled state exactly.
create or replace function private.create_default_inventory_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_locations
  set is_default = true
  where business_id = new.id and is_branch_default = true;

  return new;
end;
$$;

-- Grants --------------------------------------------------------------
--
-- No RLS policy change: inventory_locations_select stays "any active
-- business member" (create_inventory_locations.sql's own established
-- read-visibility posture) — Phase 1G does not narrow who can SEE which
-- locations, only who can WRITE stock through one (enforced at the
-- movement-RPC layer, next migration). The existing `grant select on
-- public.inventory_locations to authenticated, service_role` is an
-- UNRESTRICTED whole-table grant (confirmed in create_inventory_locations.sql
-- — "carries no sensitive data"), so the two new columns are already
-- visible to every existing grantee without any GRANT statement here,
-- including private_sale_writer's own identical whole-table SELECT grant.
--
-- private_product_creator is the one EXISTING role that does NOT have a
-- whole-table grant on this table (deliberately narrowed to a single
-- accessor function, get_default_inventory_location_id — see that
-- function's own comment). It needs to independently resolve a location's
-- branch_id for the new has_branch_access check the next migration adds to
-- create_product's bundled-opening-stock path, AND (Codex adversarial
-- review Phase 1G round 2, Medium 2B) to resolve an OMITTED opening
-- location via the caller's own primary branch's canonical location —
-- narrowed to EXACTLY the five columns either need (id/business_id for
-- every WHERE clause, branch_id/status for the access check,
-- is_branch_default for the primary-branch canonical-location lookup),
-- never name/is_default/created_by/timestamps.
grant select (id, business_id, branch_id, status, is_branch_default)
  on public.inventory_locations to private_product_creator;

-- set_default_business_branch — business-default / legacy-inventory-
-- default synchronization ------------------------------------------------
--
-- Codex adversarial review Phase 1G round 2, Medium 3: business_branches.
-- is_default (WHICH BRANCH is the business's operating default) and
-- inventory_locations.is_default (Phase 1C's own LEGACY, business-wide
-- "the one location create_product's opening-stock path defaults to when
-- no location is named" flag — deliberately kept a wholly separate
-- concept from is_branch_default, see this migration's own header
-- comment) previously had NO relationship enforced when the business
-- default branch changed: public.set_default_business_branch (Phase 1F,
-- frozen — business_branch_rpcs.sql) only ever touched
-- business_branches.is_default. Switching the business default to Branch
-- B left inventory_locations.is_default stuck on the OLD default branch's
-- location — a caller bundling opening stock without an explicit location
-- would keep landing on the stale branch's stock indefinitely, and once
-- that branch was later deactivated, would start failing outright.
--
-- Replaces (CREATE OR REPLACE, IDENTICAL signature — a genuine in-place
-- replacement, unlike create_sale's/create_expense's/get_financial_summary's
-- own appended-parameter cases: Postgres preserves the existing owner
-- (private_branch_writer) and its existing business_branches grants/ACL
-- automatically for a same-signature replace) the frozen Phase 1F
-- function — this is the sanctioned CREATE OR REPLACE pattern, not an
-- edit to business_branch_rpcs.sql itself, which remains byte-identical.
-- Every existing Phase 1F behavior (authentication, branches.manage,
-- tenant validation, ACTIVE-target validation, the existing advisory lock
-- at salt 2, the "already default: no-op" short-circuit,
-- BRANCH_NOT_FOUND/BRANCH_NOT_ACTIVE) is reproduced verbatim; the ONLY
-- addition is the atomic inventory-default sync below, which runs inside
-- the SAME advisory-lock-protected transaction as the branch swap, so the
-- existing concurrency guarantee extends to it for free — no new lock
-- salt needed. private_branch_writer previously never touched
-- inventory_locations at all — narrow new grants are required for that
-- new read/write: SELECT on exactly the five columns this function's two
-- lookups/UPDATEs reference (id/business_id/branch_id/is_branch_default
-- for the canonical-location lookup; is_default is ALSO needed for
-- SELECT — not just UPDATE — because it is a WHERE-clause predicate on
-- the first UPDATE below, and a WHERE-clause column needs SELECT
-- privilege exactly like a SELECT-list column does), and UPDATE narrowed
-- to exactly the one column (is_default) this function ever writes on
-- this table — never branch_id/is_branch_default/name/status/created_by/
-- timestamps.
grant select (id, business_id, branch_id, is_branch_default, is_default) on public.inventory_locations to private_branch_writer;
grant update (is_default) on public.inventory_locations to private_branch_writer;

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
  v_uid                      uuid;
  v_found_id                 uuid;
  v_status                   text;
  v_is_default               boolean;
  v_new_default_location_id  uuid;
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

  -- Codex adversarial review Phase 1G round 2, Medium 3: resolve+validate
  -- the target branch's own canonical inventory location BEFORE mutating
  -- anything — every branch created after business_branches_create_default_location
  -- (this migration's own earlier trigger) fires unconditionally gets one,
  -- so this is structurally expected to always succeed; failing loudly
  -- here (rather than silently leaving a half-updated default state, or
  -- worse, leaving the business with zero inventory-wide defaults) is
  -- defense in depth for a target branch that somehow lacks one. Ordinary
  -- transactional rollback would prevent a half-updated state regardless
  -- of statement order, but resolving this first — before either UPDATE
  -- below runs — matches this codebase's own "validate before mutate"
  -- convention.
  select id into v_new_default_location_id
  from public.inventory_locations
  where business_id = p_business_id and branch_id = p_branch_id and is_branch_default = true;

  if v_new_default_location_id is null then
    raise exception 'NO_CANONICAL_LOCATION_FOR_BRANCH' using errcode = '22023';
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
  -- an implicit blocking-semantics argument. The NEW inventory-default
  -- sync below runs under this SAME lock, so it inherits the identical
  -- protection without a fourth salt.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 2));

  update public.business_branches set is_default = false
  where business_id = p_business_id and is_default = true;

  update public.business_branches set is_default = true
  where id = p_branch_id and business_id = p_business_id;

  -- Keep the LEGACY, business-wide inventory_locations.is_default
  -- synchronized: the new default branch's own canonical location becomes
  -- the single business-wide inventory default; whichever location held
  -- it before (structurally always at most one, per
  -- inventory_locations_one_default_idx) stops. Every OTHER branch's own
  -- is_branch_default assignment is completely untouched — only the ONE
  -- business-wide is_default flag ever moves.
  update public.inventory_locations set is_default = false
  where business_id = p_business_id and is_default = true and id <> v_new_default_location_id;

  update public.inventory_locations set is_default = true
  where id = v_new_default_location_id;

  return v_found_id;
end;
$$;
