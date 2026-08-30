-- Phase 1G: branch-aware sales.
--
-- Every sale gets an authoritative branch_id, backfilled deterministically
-- for history and required (with independently-checked branch access) for
-- every new sale. public.create_sale keeps its exact existing name and
-- every existing parameter, in the exact existing order — only ONE new
-- trailing parameter is added, with a default, via CREATE OR REPLACE
-- FUNCTION (Postgres allows appending defaulted parameters to the end of
-- an existing function's signature; it does not allow reordering or
-- removing any existing one, and this does neither). PostgREST resolves
-- RPC calls by NAMED parameter from the JSON body it receives, so the
-- current Phase 1F application — which has no concept of branch and never
-- sends a `p_branch_id` key at all — keeps calling this exact function
-- exactly as before and simply receives the server-side default described
-- below; nothing in the existing app breaks.
--
-- Codex adversarial review Phase 1G round 2, Medium 2A: that server-side
-- default is the CALLER'S OWN active primary branch assignment, never the
-- business-wide default branch directly (see "2b" in the function body
-- below for the full reasoning and the confirmed defect this fixes) —
-- create_sale itself no longer reads business_branches.is_default at all.
-- The structural proof below remains true and still matters elsewhere
-- (ensure_member_branch_access.sql's own backfill, and the fallback this
-- function raises NO_PRIMARY_BRANCH_ASSIGNED for is intended to be
-- unreachable BECAUSE of it), so it is kept for that reason.
--
-- Structural proof "every business has exactly one valid, ACTIVE default
-- branch" (the review's own required precondition for a deterministic
-- backfill): (1) business_branches_one_default_idx is a partial unique
-- index on (business_id) WHERE is_default = true — AT MOST one, enforced
-- by Postgres itself. (2) create_business_branches.sql's own one-time
-- backfill + private.create_default_business_branch's AFTER INSERT
-- trigger on `businesses` together guarantee AT LEAST one default branch
-- is created for every business, past and future, unconditionally — there
-- is no code path that creates a business without one. (3) The table's own
-- CHECK (not is_default or status = 'ACTIVE') makes a non-ACTIVE default
-- row structurally unrepresentable, and public.deactivate_business_branch
-- independently refuses to deactivate whichever branch currently holds
-- is_default (DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED) — so the default
-- branch, once created, can never become anything other than ACTIVE.
-- set_default_business_branch is the only RPC that ever changes which
-- branch holds is_default, and it does so as an atomic unset-then-set pair
-- inside one function body/transaction, so exactly one ACTIVE default
-- branch exists at every commit boundary, without exception. This is
-- proven directly from the frozen Phase 1F migrations, not assumed.

alter table public.sales
  add column branch_id uuid,
  -- Historical branch identity, captured once at creation — mirrors
  -- customer_name_snapshot's/inventory_location_name_snapshot's own "never
  -- re-derive from a later-mutable row" treatment exactly: a branch rename
  -- after the fact must not alter how an already-completed sale renders.
  add column branch_name_snapshot text;

-- Backfill: derive branch_id from the sale's OWN already-recorded
-- inventory_location_id, via the previous migration's now-populated
-- inventory_locations.branch_id — not "assume every historical sale
-- belongs to the business's default branch" as a separate, parallel guess.
-- These two derivations happen to coincide for every row that exists
-- today (every historical sale used the business's one pre-Phase-1G
-- location, which the previous migration mapped to the business's default
-- branch), but deriving it via the location this specific sale actually
-- recorded against is the more principled, self-consistent join, and
-- generalizes correctly if that invariant is ever revisited.
update public.sales s
set branch_id = il.branch_id, branch_name_snapshot = bb.name
from public.inventory_locations il
join public.business_branches bb on bb.id = il.branch_id and bb.business_id = il.business_id
where il.id = s.inventory_location_id and il.business_id = s.business_id;

alter table public.sales
  alter column branch_id set not null,
  alter column branch_name_snapshot set not null;

alter table public.sales
  add constraint sales_branch_id_business_id_fkey
  foreign key (branch_id, business_id)
  references public.business_branches (id, business_id)
  on delete no action deferrable initially deferred;

create index sales_business_branch_idx on public.sales (business_id, branch_id);

-- Grants ----------------------------------------------------------------
--
-- authenticated/service_role's existing SELECT grant on public.sales is
-- column-restricted (create_sales_and_sale_items.sql) — the two new
-- columns must be added explicitly, they are not implicitly visible the
-- way an unrestricted whole-table grant's new columns would be.
grant select (branch_id, branch_name_snapshot) on public.sales to authenticated, service_role;

-- private_sale_writer's existing INSERT grant on public.sales is already
-- unrestricted (create_sale_creation_requests_and_rpc.sql's own "grant
-- insert on public.sales" — the whole table, unlike its narrowed SELECT/
-- UPDATE grants on the same table), so it can already write the two new
-- columns with no additional GRANT needed. It DOES need two new things to
-- independently resolve and authorize a branch before ever reaching the
-- idempotency claim: a narrow read of the branch's own name/status, and
-- EXECUTE on the existing has_branch_access helper.
-- Codex adversarial review Phase 1G round 2, Medium 2A: an omitted branch
-- now resolves via the CALLER'S OWN active primary branch assignment, not
-- the business-wide default (see this function's own body below for the
-- full reasoning) — narrow reads on business_members/business_member_branches
-- are required for that lookup.
grant select (id, business_id, name, status) on public.business_branches to private_sale_writer;
grant execute on function private.has_branch_access(uuid, uuid) to private_sale_writer;
grant select (id, business_id, user_id, status) on public.business_members to private_sale_writer;
grant select (member_id, business_id, branch_id, is_primary) on public.business_member_branches to private_sale_writer;

-- CRITICAL: Postgres's CREATE OR REPLACE FUNCTION only replaces an
-- existing function when its argument-TYPE list is unchanged — appending
-- a brand new parameter (even one with a default) changes that list, so
-- CREATE OR REPLACE alone would silently create a SECOND, coexisting
-- overload rather than replacing the original nine-parameter one
-- (confirmed empirically: PostgREST then fails every ordinary call with
-- PGRST203, "could not choose the best candidate function", since a call
-- omitting p_branch_id matches both). The OLD nine-parameter signature is
-- therefore dropped explicitly first — this drops only that exact
-- function object (and its grants/ownership with it, both fully
-- re-established below for the new ten-parameter one); it does not touch
-- the migration FILE that originally created it.
drop function if exists public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text);

create or replace function public.create_sale(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_items          jsonb,
  p_customer_id    uuid default null,
  p_discount       numeric default 0,
  p_payment_status text default 'UNPAID',
  p_payment_method text default null,
  p_amount_paid    numeric default 0,
  p_notes          text default null,
  -- NEW, appended last, defaulted — see this file's own header comment for
  -- why this is backward-compatible for the current, unmodified Phase 1F
  -- application. NULL means "the caller did not choose a branch" (the
  -- current app's only possible behavior today); see the server-side
  -- default resolved below.
  p_branch_id      uuid default null
)
returns uuid  -- sale_id ONLY — never the full row, never a composite that
              -- could later leak an internal column (e.g. a future cost
              -- report field) merely because the table gained one.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                  uuid;

  -- Item normalization locals (correction 3): ONE typed representation,
  -- used identically for duplicate detection, sorting, the canonical
  -- payload, line_total, sale_items.quantity, and the inventory movement
  -- call — never re-derived or re-cast at a different precision later.
  v_raw_item              jsonb;
  v_product_id_text       text;
  v_product_id            uuid;
  v_quantity_wide         numeric;
  v_quantity              numeric(14,3);
  v_seen_products         uuid[] := array[]::uuid[];
  v_norm_items            jsonb := '[]'::jsonb;
  v_norm_items_sorted     jsonb;
  v_max_items             constant int := 100;
  -- The exact maximum representable value of a numeric(14,2) column
  -- (precision 14, scale 2 -> 12 digits before the decimal point):
  -- 999,999,999,999.99. Every money-shaped value this function computes
  -- or accepts is validated against this constant in an UNCONSTRAINED
  -- `numeric` local BEFORE ever being assigned/cast into a numeric(14,2)
  -- variable or column — an out-of-range assignment would otherwise
  -- raise Postgres's own raw "numeric field overflow" error, leaking
  -- internal implementation detail as the public error contract instead
  -- of a controlled one.
  v_max_money             constant numeric := 999999999999.99;

  -- Payment canonicalization locals (correction 4). Deliberately
  -- UNCONSTRAINED `numeric`, not numeric(14,2), for every value received
  -- from or derived for a caller-influenced input — see v_max_money above.
  v_discount              numeric;
  v_payment_status        text;
  v_payment_method        text;
  v_canonical_amount_paid numeric;
  v_notes                 text;

  -- Phase 1G branch locals. Resolved and AUTHORIZED before the
  -- idempotency claim (never inside the "new claim only" section below) —
  -- deliberately unlike customer_id/product_id/inventory_location_id,
  -- which are pure REFERENCED-RESOURCE state (safe to leave unvalidated on
  -- an exact replay, per this function's own established philosophy).
  -- Branch access is CALLER standing, exactly like the sales.create
  -- permission check three lines below has always been — this project's
  -- own precedent (every AUTHORIZE step in every RPC in this schema is
  -- unconditionally re-checked, replay or not; only REFERENCED entities'
  -- mutable descriptive state, like a customer's archived flag, is
  -- deferred to the new-claim-only section) is what this mirrors. This is
  -- also exactly why has_branch_access alone (which already requires the
  -- branch to be real, same-tenant, and currently ACTIVE — see its own
  -- definition in create_business_member_branches.sql) is sufficient
  -- authorization here without a SEPARATE resource-existence check: a
  -- caller who fails it gets a single, consistent "you can't do this"
  -- outcome regardless of whether the underlying reason is a foreign
  -- branch, a nonexistent one, an inactive one, or a real same-tenant
  -- branch they simply aren't assigned to — matching this schema's
  -- existing non-disclosure posture for exactly this kind of authorization
  -- gate (see insufficient_privilege's own universal treatment elsewhere).
  v_branch_id             uuid;
  v_branch_name           text;
  -- Codex adversarial review Phase 1G round 2, Medium 4: the branch
  -- identity that goes into the canonical idempotency payload is
  -- DELIBERATELY a separate concept from v_branch_id (this call's own,
  -- always-freshly-resolved authorization target) — see the "2c" step
  -- below for the full reasoning.
  v_canonical_branch_id   uuid;

  v_canonical_payload     jsonb;
  v_stored_request        private.sale_creation_requests;
  v_sale_id                uuid;

  -- New-claim-only locals — current-state validation, never consulted on
  -- a replay.
  v_customer_status         text;
  v_customer_name            text;
  v_customer_phone            text;
  v_customer_email             text;
  v_customer_address            text;
  v_location_id                  uuid;
  v_location_name                 text;
  v_seq_number                     bigint;
  v_sale_number                     text;
  v_item                             record;
  v_product_status                    text;
  v_product_track_inventory            boolean;
  v_product_name                        text;
  v_product_sku                          text;
  v_product_cost                          numeric(14,2);
  -- unit_price is read directly from products.selling_price, which is
  -- itself already a numeric(14,2) COLUMN — inherently bounded at the
  -- source, so numeric(14,2) here introduces no new overflow risk.
  v_unit_price                             numeric(14,2);
  -- Everything computed FROM unit_price (a multiplication, a running
  -- sum, a subtraction) is deliberately unconstrained `numeric` until
  -- explicitly range-checked — see v_max_money.
  v_line_total_wide                         numeric;
  v_subtotal                                 numeric := 0;
  v_total                                     numeric;
  v_final_amount_paid                          numeric;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_items is null then
    raise exception 'p_business_id, p_creation_key, and p_items are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never "mutable referenced
  -- state" of a customer/product/location, so this is always safe to
  -- re-check on every call, replay or not.
  if not private.has_permission(p_business_id, 'sales.create') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 2b) RESOLVE + AUTHORIZE THE BRANCH — see this variable's own
  -- declaration comment above for why this happens here, unconditionally,
  -- rather than in the new-claim-only section further down.
  if p_branch_id is not null then
    v_branch_id := p_branch_id;
  else
    -- Codex adversarial review Phase 1G round 2, Medium 2A: an omitted
    -- branch resolves via the AUTHENTICATED CALLER'S OWN active PRIMARY
    -- branch assignment — never the business-wide default (the confirmed
    -- defect: a Branch-B-only SALES member, using the current, unmodified
    -- Phase 1F application — which has no branch concept and never sends
    -- p_branch_id at all — would otherwise always resolve to Main Branch,
    -- a branch they may have no access to at all, incorrectly failing
    -- insufficient_privilege even though they are a perfectly legitimate,
    -- fully-provisioned Branch-B operator). Every Phase 1F LOCKED
    -- INVARIANT (replace_member_branches', accept_business_invitation's,
    -- and this phase's own ensure_member_branch_access.sql's) guarantees
    -- an ACTIVE member always has at least one assignment and EXACTLY one
    -- primary among them — this is therefore expected to always resolve
    -- for a real, active member; NO_PRIMARY_BRANCH_ASSIGNED below is
    -- defense in depth, not an expected path. This is NOT a trust-
    -- whatever fallback: has_branch_access is still checked immediately
    -- below for this resolved value exactly like it would be for an
    -- explicitly-chosen one — a caller whose primary branch has since
    -- become INACTIVE is correctly denied here, never silently let
    -- through or silently redirected to a different branch.
    select bmb.branch_id into v_branch_id
    from public.business_members bm
    join public.business_member_branches bmb
      on bmb.member_id = bm.id and bmb.business_id = bm.business_id
    where bm.business_id = p_business_id
      and bm.user_id = v_uid
      and bm.status = 'active'
      and bmb.is_primary = true;

    if v_branch_id is null then
      raise exception 'NO_PRIMARY_BRANCH_ASSIGNED' using errcode = '22023';
    end if;
  end if;

  select name into v_branch_name
  from public.business_branches
  where id = v_branch_id and business_id = p_business_id;

  if v_branch_name is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
  end if;

  if not private.has_branch_access(p_business_id, v_branch_id) then
    -- Deliberately the SAME generic code has_permission's own check above
    -- uses — see this variable's declaration comment for the full
    -- non-disclosure reasoning (this single check already subsumes
    -- foreign-tenant, nonexistent, inactive, and genuinely-unassigned).
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 2c) CANONICAL BRANCH IDENTITY for the idempotency payload — Codex
  -- adversarial review Phase 1G round 2, Medium 4. An EXPLICIT p_branch_id
  -- is always the canonical value, compared strictly on every replay
  -- (never silently substituted). An OMITTED one must NEVER be
  -- re-resolved against CURRENT mutable state (the caller's primary
  -- assignment, or — the original confirmed defect — the business
  -- default) before the idempotency comparison below: doing so would make
  -- an exact replay of an already-completed sale spuriously conflict the
  -- moment the caller's primary branch changes. Instead, when omitted,
  -- this peeks at whatever this EXACT creation_key already has stored (if
  -- anything) and reuses THAT value unconditionally for the comparison;
  -- only a genuinely first-ever claim for this key falls through to the
  -- v_branch_id just resolved (and already access-checked) above. This is
  -- deliberately a SEPARATE read from "2b"'s own AUTHORIZATION check
  -- immediately above — that check always uses the CALLER'S CURRENT
  -- standing (so a caller who has since lost access is still correctly
  -- denied, replay or not, exactly like sales.create itself); this step
  -- only governs which value the REPLAY-COMPARISON below treats as
  -- canonical.
  if p_branch_id is not null then
    v_canonical_branch_id := p_branch_id;
  else
    select (canonical_payload->>'branch_id')::uuid into v_canonical_branch_id
    from private.sale_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_canonical_branch_id is null then
      v_canonical_branch_id := v_branch_id;
    end if;
  end if;

  -- 3) NORMALIZE CALLER REQUEST — pure input-shape validation. Every
  -- malformed-input error below is controlled (raised explicitly, before
  -- any raw cast that could otherwise surface an internal Postgres syntax
  -- error to the caller) and happens BEFORE any lookup against
  -- customer/product/location current state.

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > v_max_items then
    raise exception 'TOO_MANY_SALE_ITEMS' using errcode = '22023';
  end if;

  for v_raw_item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_raw_item) is distinct from 'object' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;

    -- product_id: format-validated as a JSON string matching UUID shape
    -- BEFORE any cast — a malformed value never reaches a raw ::uuid
    -- cast error.
    if jsonb_typeof(v_raw_item->'product_id') is distinct from 'string' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_product_id_text := v_raw_item->>'product_id';
    if v_product_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_product_id := v_product_id_text::uuid;  -- safe now, shape already proven

    -- quantity: type-checked as a JSON number, then cast to an
    -- UNCONSTRAINED numeric (never overflows) BEFORE the range check —
    -- only once bounded is it narrowed to numeric(14,3), so an
    -- absurd/adversarial magnitude never reaches a raw "numeric field
    -- overflow" error either.
    if jsonb_typeof(v_raw_item->'quantity') is distinct from 'number' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_quantity_wide := (v_raw_item->'quantity')::text::numeric;
    if v_quantity_wide <= 0 or v_quantity_wide > 1000000 then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_quantity := v_quantity_wide::numeric(14,3);
    -- Excess precision must be REJECTED, never silently rounded. Casting
    -- to numeric(14,3) rounds (1.2345 -> 1.235, 0.0001 -> 0.000) rather
    -- than raising — so a caller sending more than 3 decimal places would
    -- otherwise have their stated quantity silently altered before it
    -- ever reaches sale_items/inventory deduction, and two DIFFERENT
    -- excess-precision requests could even collapse to the same rounded
    -- value. Proving the narrowed candidate is numerically EQUAL to the
    -- original unconstrained value is what makes this a genuine
    -- round-trip proof rather than textual decimal-place counting.
    if v_quantity <> v_quantity_wide then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;

    -- Duplicate detection on the SAME normalized product_id — a pure
    -- check of the caller's own input, not a DB lookup, so it is safe
    -- pre-claim.
    if v_product_id = any(v_seen_products) then
      raise exception 'DUPLICATE_PRODUCT_LINE' using errcode = '22023';
    end if;
    v_seen_products := array_append(v_seen_products, v_product_id);

    v_norm_items := v_norm_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id::text,
      'quantity', v_quantity::text
    ));
  end loop;

  -- Sort by product_id ascending — the ONE normalized representation,
  -- deterministic regardless of caller input order, used identically for
  -- the canonical payload below AND the execution loop further down
  -- (never re-derived at a different precision or order).
  select jsonb_agg(elem order by (elem->>'product_id')::uuid)
  into v_norm_items_sorted
  from jsonb_array_elements(v_norm_items) elem;

  -- p_discount arrives as an unconstrained `numeric` parameter — a caller
  -- bypassing Zod can send an arbitrarily large value (e.g. 1e100)
  -- directly to this RPC boundary. Received into an unconstrained local
  -- and range-checked explicitly here, BEFORE it is ever compared against
  -- a numeric(14,2) value or embedded in arithmetic that assigns into
  -- one — never narrowed to numeric(14,2) at all in this function; the
  -- eventual `sales.discount` column does that safely on INSERT/UPDATE
  -- only once this check has already proven the value fits.
  v_discount := coalesce(p_discount, 0);
  if v_discount < 0 then
    raise exception 'INVALID_DISCOUNT' using errcode = '22023';
  end if;
  if v_discount > v_max_money then
    raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  v_payment_status := coalesce(p_payment_status, 'UNPAID');
  if v_payment_status not in ('UNPAID', 'PARTIALLY_PAID', 'PAID') then
    raise exception 'invalid payment status' using errcode = '22023';
  end if;
  v_payment_method := nullif(btrim(p_payment_method), '');
  if v_payment_method is not null and v_payment_method not in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER') then
    raise exception 'invalid payment method' using errcode = '22023';
  end if;

  -- 4) PAYMENT INTENT CANONICALIZATION (correction 4) — amount_paid is
  -- meaningful only for PARTIALLY_PAID. UNPAID forces both amount_paid
  -- and payment_method to a single deterministic value regardless of
  -- what the caller sent; PAID's caller-supplied amount_paid NEVER
  -- influences canonical identity (it is recomputed from the
  -- server-derived total on the new-claim path only); PARTIALLY_PAID's
  -- caller amount_paid IS canonical. This is what makes the same
  -- semantic request never conflict merely because the caller sent an
  -- ignored amount_paid value.
  if v_payment_status = 'UNPAID' then
    if v_payment_method is not null then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
    v_canonical_amount_paid := 0;
  elsif v_payment_status = 'PAID' then
    v_canonical_amount_paid := null;  -- caller's value is never part of intent
  else -- PARTIALLY_PAID
    -- p_amount_paid is another unconstrained-`numeric` parameter a caller
    -- can send an extreme value to directly — range-checked here, still
    -- in unconstrained `numeric`, BEFORE the eventual (already-safe,
    -- because now proven in-range) narrowing below.
    if p_amount_paid is null or p_amount_paid <= 0 then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
    if p_amount_paid > v_max_money then
      raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
    end if;
    if v_payment_method is null then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
    v_canonical_amount_paid := p_amount_paid;
  end if;

  v_notes := nullif(btrim(p_notes), '');

  -- CONSTRUCT CANONICAL CALLER INTENT — never includes unit_price
  -- (server-derived, not caller intent), never includes computed
  -- subtotal/total/line_total, never includes inventory_location_id
  -- (resolved post-claim, §5 of the corrections — never part of replay
  -- comparison). branch_id IS included (Phase 1G): unlike the inventory
  -- location, the branch is caller INTENT, not an implementation detail —
  -- a reused creation_key with a genuinely different branch must be
  -- rejected as payload reuse, never silently resolved to whichever
  -- branch happened to be requested first.
  v_canonical_payload := jsonb_build_object(
    'customer_id', p_customer_id,
    'items', v_norm_items_sorted,
    'discount', v_discount::text,
    'payment_status', v_payment_status,
    'payment_method', v_payment_method,
    'amount_paid', v_canonical_amount_paid::text,
    'notes', v_notes,
    'branch_id', v_canonical_branch_id::text
  );

  -- 5) CLAIM
  insert into private.sale_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 6) REPLAY DECISION — nothing about customer/product/location
    -- current state has been consulted before this point.
    select * into v_stored_request
    from private.sale_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'SALE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.sale_id;  -- exact replay, unconditionally
  end if;

  -- 7) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current-state
  -- validation begins.

  if p_customer_id is not null then
    -- Scoped directly in the WHERE clause (correction 7) — a
    -- foreign-tenant row is never loaded at all, not loaded-then-compared.
    select status, name, phone, email, address
    into v_customer_status, v_customer_name, v_customer_phone, v_customer_email, v_customer_address
    from public.customers
    where id = p_customer_id and business_id = p_business_id;

    if not found then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
    end if;
    if v_customer_status = 'archived' then
      raise exception 'CUSTOMER_ARCHIVED' using errcode = '23514';   -- real, same-tenant: informative
    end if;
  end if;

  -- Phase 1G: resolve stock deduction against the SELECTED BRANCH's own
  -- canonical location — never the business-wide default location
  -- (is_default) a different branch might otherwise share. This is the
  -- ONE behavioral change to location resolution; for every current
  -- single-branch business it resolves to the EXACT same location the old
  -- business-wide lookup would have found (the previous migration mapped
  -- them 1:1), so existing single-branch behavior is unchanged in
  -- practice, not just in intent. Uses v_canonical_branch_id (this
  -- request's own authoritative branch identity), not v_branch_id — on
  -- this new-claim-only path the two are always identical in value (see
  -- "2c" above), but v_canonical_branch_id is the semantically correct
  -- one to build the actual sale row from.
  select id, name into v_location_id, v_location_name
  from public.inventory_locations
  where business_id = p_business_id and branch_id = v_canonical_branch_id
    and is_branch_default = true and status = 'active';

  if v_location_id is null then
    -- Structurally unreachable given business_branches_create_default_location
    -- (previous migration) fires for every branch unconditionally; fails
    -- loudly rather than silently proceeding if it somehow were bypassed.
    raise exception 'NO_DEFAULT_LOCATION' using errcode = '22023';
  end if;

  insert into private.business_sale_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_sale_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  -- lpad(string, length) TRUNCATES (keeping only the leftmost `length`
  -- characters) when the input is already longer than `length` — a
  -- documented but easy-to-miss Postgres behavior, confirmed live
  -- (lpad('1000000', 6, '0') = '100000', silently colliding with the
  -- truncated form of 1000001 too). greatest(6, length(...)) pads to AT
  -- LEAST 6 digits for the common case and never truncates once the
  -- counter exceeds 999999 — the target width is never smaller than the
  -- number's own digit count.
  v_sale_number := 'SALE-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.sales (
    business_id, customer_id,
    customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot,
    inventory_location_id, inventory_location_name_snapshot,
    branch_id, branch_name_snapshot,
    sale_number, creation_key, created_by
  ) values (
    p_business_id, p_customer_id,
    v_customer_name, v_customer_phone, v_customer_email, v_customer_address,
    v_location_id, v_location_name,
    v_canonical_branch_id, v_branch_name,
    v_sale_number, p_creation_key, v_uid
  )
  returning id into v_sale_id;

  -- Process lines in the SAME product_id-ascending order already fixed
  -- above (v_norm_items_sorted) — the deterministic lock order, matching
  -- Phase 1C's product -> location -> balance sequence for every line.
  for v_item in select * from jsonb_array_elements(v_norm_items_sorted)
  loop
    select name, sku, status, track_inventory, selling_price, cost_price
    into v_product_name, v_product_sku, v_product_status, v_product_track_inventory, v_unit_price, v_product_cost
    from public.products
    where id = (v_item.value->>'product_id')::uuid and business_id = p_business_id
    for share;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
    end if;
    if v_product_status <> 'active' then
      raise exception 'PRODUCT_ARCHIVED' using errcode = '23514';
    end if;

    -- PRICE AUTHORITY: always the locked row's selling_price. The caller
    -- never supplies unit_price at all — it is not part of p_items'
    -- shape, so there is nothing for a forged value to even populate.
    v_quantity := (v_item.value->>'quantity')::numeric(14,3);

    -- unit_price * quantity is computed into an UNCONSTRAINED numeric
    -- local first (Postgres numeric arithmetic itself never overflows —
    -- only an ASSIGNMENT into a precision/scale-constrained destination
    -- can), rounded, and explicitly range-checked BEFORE it is ever
    -- assigned into the numeric(14,2) sale_items.line_total column or
    -- accumulated into subtotal. A product with an extreme (but validly
    -- stored, since products.selling_price has no upper CHECK bound)
    -- selling_price multiplied by a large validated quantity can
    -- realistically exceed numeric(14,2)'s representable range — this
    -- is not a hypothetical.
    v_line_total_wide := round(v_unit_price * v_quantity, 2);
    if v_line_total_wide > v_max_money then
      raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
    end if;
    v_subtotal := v_subtotal + v_line_total_wide;

    insert into public.sale_items (
      business_id, sale_id, product_id, product_name_snapshot, sku_snapshot,
      unit_price, quantity, line_total, unit_cost_snapshot
    ) values (
      p_business_id, v_sale_id, (v_item.value->>'product_id')::uuid, v_product_name, v_product_sku,
      v_unit_price, v_quantity, v_line_total_wide, v_product_cost
    );

    if v_product_track_inventory then
      -- INSUFFICIENT_STOCK (or any other exception here) rolls back this
      -- entire transaction — the sales insert, the sequence claim, and
      -- the request-ledger claim all together. No partial completion.
      perform private.apply_inventory_movement(
        p_business_id, (v_item.value->>'product_id')::uuid, v_location_id, 'SALE',
        v_quantity, v_product_cost, 'sale', v_sale_id,
        'Sale ' || v_sale_number, null, gen_random_uuid(), v_uid
      );
    end if;
  end loop;

  -- Each individual line_total was already proven <= v_max_money above,
  -- but the RUNNING SUM across up to v_max_items lines can still exceed
  -- numeric(14,2)'s representable range even when every line
  -- individually fits (100 lines each near the per-line maximum would
  -- vastly exceed it) — checked once, cheaply, here, still in
  -- unconstrained `numeric`, before subtotal is ever compared against
  -- discount or assigned into the numeric(14,2) sales.subtotal column.
  if v_subtotal > v_max_money then
    raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  if v_discount > v_subtotal then
    raise exception 'INVALID_DISCOUNT' using errcode = '22023';
  end if;
  v_total := v_subtotal - v_discount;
  -- total = subtotal - discount, with discount already proven
  -- 0 <= discount <= subtotal <= v_max_money, so total is structurally
  -- bounded within [0, v_max_money] already — this check makes that
  -- invariant explicit rather than merely implied, and is cheap insurance
  -- against a future edit to the arithmetic above silently breaking it.
  if v_total > v_max_money or v_total < 0 then
    raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  -- Payment reconciliation against the now-known total — this is the
  -- sale's OWN computed output, not external mutable state, so
  -- validating it here (new-claim path only) does not violate the replay
  -- ordering rule.
  if v_payment_status = 'PAID' then
    v_final_amount_paid := v_total;
    if v_total > 0 and v_payment_method is null then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
  elsif v_payment_status = 'UNPAID' then
    v_final_amount_paid := 0;
  else -- PARTIALLY_PAID
    if v_total = 0 or v_canonical_amount_paid >= v_total then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
    v_final_amount_paid := v_canonical_amount_paid;
  end if;

  update public.sales
  set subtotal = v_subtotal, discount = v_discount, total = v_total,
      payment_status = v_payment_status, payment_method = v_payment_method,
      amount_paid = v_final_amount_paid, notes = v_notes,
      status = 'COMPLETED', completed_at = now()
  where id = v_sale_id;

  update private.sale_creation_requests set sale_id = v_sale_id
  where business_id = p_business_id and creation_key = p_creation_key;

  return v_sale_id;
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface — required in
-- full here (unlike a genuine in-place CREATE OR REPLACE) because the
-- DROP above means this is a freshly-created function object, owned by
-- whichever role ran this migration until explicitly transferred. Mirrors
-- create_sale_creation_requests_and_rpc.sql's own original ownership/grant
-- block exactly, just for the new ten-parameter signature.
grant create on schema public to private_sale_writer;
alter function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  owner to private_sale_writer;
revoke create on schema public from private_sale_writer;

revoke all on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  from public, anon, service_role;
grant execute on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  to authenticated;
