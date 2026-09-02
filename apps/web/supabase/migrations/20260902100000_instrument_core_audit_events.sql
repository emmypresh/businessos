-- Phase 1J — APPLICATION + INSTRUMENTATION. Wires a focused, representative
-- MVP set of existing mutation RPCs to write a semantic audit event, in
-- the SAME transaction as the business mutation they describe, via the
-- frozen private.record_audit_event (20260902090100_audit_permissions_and_writer.sql).
--
-- This migration NEVER edits any frozen Phase 1A-1J migration file — every
-- function below is reproduced via CREATE OR REPLACE with its EXACT
-- existing signature (so PostgREST's own resolution, every existing
-- grant, and every existing caller are all unaffected), with the audit
-- call added as one small, additive block immediately before each
-- function's own final `return` on its NEW-MUTATION path only. No
-- existing validation, authorization, idempotency, or business logic is
-- changed anywhere in this file — every line that is not new is a
-- byte-for-byte copy of the frozen version it replaces.
--
-- WHY THESE TEN, AND ONLY THESE TEN (per this phase's own explicit
-- "representative MVP subset, not every mutation" scope): sale.created,
-- return.created, expense.posted, invoice.created, payment.recorded,
-- inventory.adjusted, customer.created, branch.created,
-- branch.deactivated, staff.invited, and product.created — one
-- high-value event per major engine (COMMERCE, FINANCE, INVENTORY,
-- CUSTOMER, ORGANIZATION), covering every category this phase's own
-- product brief names. No update/delete/void path is instrumented this
-- round (explicitly deferred, matching the round's own "do not force
-- instrumentation of update/delete operations" instruction).
--
-- ACTOR DERIVATION: every instrumented function ALREADY calls
-- private.current_uid() at its own top (existing authentication step) —
-- v_uid is passed to record_audit_event as p_actor_user_id UNCHANGED,
-- never re-derived, never accepted as a new parameter, and never
-- reachable by any client-supplied value (this migration adds no new
-- parameter to any of these ten functions). actor_email_snapshot is
-- derived via private.current_verified_email() — the ONE existing,
-- already-audited place in this schema that safely reads auth.users
-- (20260828080700_business_invitation_rpcs.sql's own header comment) —
-- never from a client-supplied string. actor_name_snapshot is left NULL
-- for all ten: no authoritative display-name source exists anywhere in
-- this schema (business_members carries no name column, and
-- auth.users.raw_user_meta_data is client-editable, explicitly
-- disqualified elsewhere in this codebase as an authorization/identity
-- source) — per this phase's own instruction, "email-only snapshot is
-- acceptable" when no such source exists.
--
-- ATOMICITY: every `perform private.record_audit_event(...)` call sits
-- INSIDE the same function body, after the business mutation's own
-- INSERT/UPDATE has already executed, but before the function returns —
-- if it raises, the entire enclosing transaction (the business mutation
-- included) rolls back together, exactly matching this phase's own
-- required "both succeed or both roll back" semantics. No Server Action
-- anywhere makes a second, separate network call to record an event.
--
-- REPLAY: every one of these ten functions already has its own
-- established idempotency-ledger pattern (sale/return/invoice/payment/
-- expense/product/customer/branch/invitation creation) EXCEPT
-- deactivate_business_branch and record_inventory_movement, which are
-- addressed individually below. In every ledger-backed function, the
-- audit call is placed strictly AFTER the "only a newly claimed request
-- reaches here" boundary — an exact replay returns earlier, at the
-- pre-existing REPLAY DECISION branch, and never reaches the new audit
-- code at all. This is proven by dedicated integration tests, not merely
-- asserted by placement.
--
-- FABRICATION RESISTANCE: private.record_audit_event itself still has
-- ZERO EXECUTE grant to `authenticated`/`anon`/`service_role`/`PUBLIC` —
-- unchanged by this migration. The only new grants below are EXECUTE to
-- the SPECIFIC, ALREADY-TRUSTED private writer role that owns each
-- instrumented function — the same narrow role that already owns 100% of
-- that mutation's own authority. No unrelated private function gains the
-- ability to call record_audit_event as a side effect of any grant here.

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW COMPLETED FOR EACH GRANT BELOW, per the frozen        │
-- │ foundation's own standing requirement (20260902090100_audit_          │
-- │ permissions_and_writer.sql's header comment): every private writer    │
-- │ role granted EXECUTE here derives its own p_actor_user_id from its    │
-- │ OWN pre-existing private.current_uid() call — none accepts an actor   │
-- │ id as a caller-supplied parameter, satisfying the actor trust-        │
-- │ boundary requirement that comment specifically flagged for review     │
-- │ before any such grant.                                                │
-- └─────────────────────────────────────────────────────────────────────┘
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_sale_writer, private_sale_return_writer, private_expense_writer,
      private_invoice_writer, private_invoice_payment_writer, private_inventory_writer,
      private_customer_creator, private_branch_writer, private_invitation_writer,
      private_product_creator;

grant execute on function private.current_verified_email() to
  private_sale_writer, private_sale_return_writer, private_expense_writer,
  private_invoice_writer, private_invoice_payment_writer, private_inventory_writer,
  private_customer_creator, private_branch_writer, private_invitation_writer,
  private_product_creator;

-- Additional narrow column reads needed ONLY for the new
-- resource_label_snapshot each function now derives — no broader grant
-- than the single new column each one actually reads.
grant select (invoice_number) on public.invoices to private_invoice_payment_writer;
grant select (name) on public.business_branches to private_branch_writer;

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
  -- Phase 1J instrumentation: the caller's own verified email, resolved
  -- once, only after authentication succeeds — never a client-supplied
  -- value. See this migration's own header comment for the full
  -- actor-derivation rationale.
  v_actor_email                                 text;
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

  -- Phase 1J instrumentation: sale.created — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at line ~529's own
  -- `return v_stored_request.sale_id`, never reaching here). No product
  -- cost anywhere in the metadata — item_count and money totals only.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'sale.created', 'COMMERCE',
    v_canonical_branch_id, v_actor_email, null,
    'sale', v_sale_id, v_sale_number, 'SUCCESS',
    jsonb_build_object(
      'total_amount', v_total::text,
      'amount_paid', v_final_amount_paid::text,
      'item_count', jsonb_array_length(v_norm_items_sorted)
    )
  );

  return v_sale_id;
end;
$$;

-- Defensive re-assertion, not a real change: CREATE OR REPLACE with this
-- EXACT, unchanged signature preserves the function's existing owner
-- (private_sale_writer) and its existing ACL automatically — no DROP
-- occurs anywhere in this file. These lines are restated explicitly
-- anyway, matching this codebase's own "explicit, never implicit" grant
-- convention, and are no-ops against the already-correct state.
alter function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  owner to private_sale_writer;
revoke all on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  from public, anon, service_role;
grant execute on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text, uuid)
  to authenticated;

create or replace function public.create_sale_return(
  p_business_id  uuid,
  p_creation_key uuid,
  p_sale_id      uuid,
  p_items        jsonb,
  p_refund_amount numeric default 0,
  p_refund_method text default null,
  p_reason        text default null,
  p_notes         text default null
)
returns uuid  -- sale_return_id ONLY — never the full row, matching
              -- create_invoice's/create_sale's own "never leak an
              -- internal column merely because the table gained one"
              -- reasoning.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                 uuid;

  -- Item normalization locals — ONE typed representation, used
  -- identically for duplicate detection, the canonical payload, AND the
  -- execution loop below (never re-derived or re-cast at a different
  -- precision later). Submission order is PRESERVED (never re-sorted)
  -- for `position` assignment — see this file's own header comment on
  -- why a SEPARATE sorted pass is used purely for locking.
  v_raw_item            jsonb;
  v_sale_item_id_text   text;
  v_sale_item_id        uuid;
  v_quantity_wide       numeric;
  v_quantity            numeric(14,3);
  v_restock             boolean;
  v_seen_sale_items     uuid[] := array[]::uuid[];
  v_norm_items          jsonb := '[]'::jsonb;
  v_max_items           constant int := 100;
  v_max_money           constant numeric := 999999999999.99;

  v_refund_amount       numeric;
  v_refund_method       text;
  v_reason              text;
  v_notes               text;

  v_canonical_payload   jsonb;
  v_stored_request      private.sale_return_creation_requests;
  v_sale_return_id      uuid;

  -- New-claim-only locals — current-state validation, never consulted on
  -- a replay.
  v_sale_found          uuid;
  v_sale_status         text;
  v_sale_branch_id      uuid;
  v_sale_branch_name    text;
  v_sale_amount_paid    numeric(14,2);
  v_branch_status       text;
  v_seq_number          bigint;
  v_return_number       text;
  v_restock_location_id uuid;
  v_needs_restock       boolean := false;

  -- Lock/validate pass (sale_item_id-ascending order) — a JSONB map
  -- keyed by sale_item_id, storing each item's locked snapshot so the
  -- SEPARATE, submission-order insert pass below never re-queries
  -- sale_items (and never re-acquires a lock it already holds).
  v_snapshots           jsonb := '{}'::jsonb;
  v_sorted_item         record;
  v_item                jsonb;
  v_sale_item           record;
  v_already_returned    numeric;
  v_line_total_wide     numeric;
  v_return_value_basis  numeric := 0;
  v_cumulative_refund   numeric;

  -- Insert pass (caller's own submission order).
  v_position            int := 0;
  v_snapshot            jsonb;

  -- Phase 1J instrumentation locals.
  v_restocked_count     int := 0;
  v_actor_email         text;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_sale_id is null or p_items is null then
    raise exception 'p_business_id, p_creation_key, p_sale_id, and p_items are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never inferred from
  -- anything about the referenced sale, so this is always safe to
  -- re-check on every call, replay or not.
  if not private.has_permission(p_business_id, 'returns.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST — pure input-shape validation, entirely
  -- before any lookup against sale/sale_item current state.

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > v_max_items then
    raise exception 'TOO_MANY_RETURN_ITEMS' using errcode = '22023';
  end if;

  for v_raw_item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_raw_item) is distinct from 'object' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;

    -- sale_item_id: format-validated as a JSON string matching UUID
    -- shape BEFORE any cast — a malformed value never reaches a raw
    -- ::uuid cast error.
    if jsonb_typeof(v_raw_item->'sale_item_id') is distinct from 'string' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_sale_item_id_text := v_raw_item->>'sale_item_id';
    if v_sale_item_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_sale_item_id := v_sale_item_id_text::uuid;

    -- Duplicate detection on THIS request's own input only — a pure
    -- check of caller-submitted data, not a DB lookup, so it is safe
    -- pre-claim. Returning the SAME sale_item across SEPARATE return
    -- transactions (different creation_keys) is explicitly allowed and
    -- governed by the return-quantity invariant below instead.
    if v_sale_item_id = any(v_seen_sale_items) then
      raise exception 'DUPLICATE_SALE_ITEM_LINE' using errcode = '22023';
    end if;
    v_seen_sale_items := array_append(v_seen_sale_items, v_sale_item_id);

    -- quantity: same round-trip-proof pattern as create_invoice's/
    -- create_sale's own (type-checked as a JSON number, cast to an
    -- UNCONSTRAINED numeric, range-checked, THEN narrowed to
    -- numeric(14,3) and proven exactly equal to the wide value — excess
    -- precision is REJECTED, never silently rounded).
    if jsonb_typeof(v_raw_item->'quantity') is distinct from 'number' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_quantity_wide := (v_raw_item->'quantity')::text::numeric;
    if v_quantity_wide <= 0 or v_quantity_wide > 1000000 then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_quantity := v_quantity_wide::numeric(14,3);
    if v_quantity <> v_quantity_wide then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;

    -- restock: required, explicit, boolean — never defaulted, so there
    -- is no ambiguous "did the caller mean to restock this?" state.
    if jsonb_typeof(v_raw_item->'restock') is distinct from 'boolean' then
      raise exception 'MALFORMED_RETURN_ITEMS' using errcode = '22023';
    end if;
    v_restock := (v_raw_item->>'restock')::boolean;

    v_norm_items := v_norm_items || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_sale_item_id::text,
      'quantity', v_quantity::text,
      'restock', v_restock
    ));
  end loop;

  -- p_refund_amount arrives as an unconstrained `numeric` parameter — a
  -- caller bypassing app-layer validation can send an arbitrarily large
  -- or excess-precision value directly to this RPC boundary. Received
  -- into an unconstrained local and range/precision-checked explicitly
  -- here, BEFORE it is ever compared against a numeric(14,2) value or
  -- assigned into one.
  v_refund_amount := coalesce(p_refund_amount, 0);
  if v_refund_amount < 0 then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;
  if v_refund_amount > v_max_money then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;
  -- Codex security audit lesson (SEC-02, "explicit calendar/precision
  -- validation must happen at the DATABASE boundary, never trusted from
  -- the caller") applied here to money: round(numeric, 2) on Postgres's
  -- own exact-decimal numeric type is a genuine, exact round-trip proof —
  -- 1.999/0.005 must be REJECTED outright, never silently coerced.
  if round(v_refund_amount, 2) <> v_refund_amount then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;

  v_refund_method := nullif(btrim(p_refund_method), '');
  -- Structural biconditional, enforced here AND by the table's own CHECK
  -- constraint below (defense in depth, not redundancy for its own
  -- sake) — "refund_method should be nullable when refund_amount = 0...
  -- If refund_amount > 0: refund_method required" (this phase's own
  -- product brief).
  if v_refund_amount = 0 then
    if v_refund_method is not null then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
  else
    if v_refund_method is null then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
    if v_refund_method not in ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER') then
      raise exception 'INVALID_REFUND_METHOD' using errcode = '22023';
    end if;
  end if;

  v_reason := nullif(btrim(p_reason), '');
  if v_reason is not null and v_reason not in ('CUSTOMER_RETURN', 'DAMAGED', 'WRONG_ITEM', 'DEFECTIVE', 'OTHER') then
    raise exception 'INVALID_RETURN_REASON' using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_RETURN_NOTES' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — item order preserved exactly as
  -- submitted (mirrors create_invoice's own reasoning: never includes
  -- product/price snapshots or any computed total, all server-derived,
  -- not caller intent).
  v_canonical_payload := jsonb_build_object(
    'sale_id', p_sale_id,
    'items', v_norm_items,
    'refund_amount', v_refund_amount::text,
    'refund_method', v_refund_method,
    'reason', v_reason,
    'notes', v_notes
  );

  -- 4) CLAIM
  insert into private.sale_return_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the sale's current
    -- branch/status/quantities has been consulted before this point.
    select * into v_stored_request
    from private.sale_return_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'RETURN_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.sale_return_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current-state
  -- validation begins.

  -- Scoped directly in the WHERE clause — a foreign-tenant/nonexistent
  -- row is never loaded at all, not loaded-then-compared. Locked FOR
  -- UPDATE immediately: this is the SAME lock the cumulative-refund
  -- invariant relies on below (every sale_returns INSERT for this sale
  -- only ever happens after this lock is held).
  select id, status, branch_id, branch_name_snapshot, amount_paid
  into v_sale_found, v_sale_status, v_sale_branch_id, v_sale_branch_name, v_sale_amount_paid
  from public.sales
  where id = p_sale_id and business_id = p_business_id
  for update;

  if v_sale_found is null then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  -- SEC-01I remediation: lock the sale's OWN authoritative
  -- business_branches row FOR SHARE — genuinely conflicting with
  -- deactivate_business_branch's own FOR UPDATE — BEFORE its status is
  -- consulted for anything. See this file's own header comment ("BRANCH
  -- LIFECYCLE SERIALIZATION") for the full race this closes and why FOR
  -- SHARE, in this exact position, is deadlock-safe.
  select status into v_branch_status
  from public.business_branches
  where id = v_sale_branch_id and business_id = p_business_id
  for share;

  -- Non-disclosure, identical posture to the sale check above: a branch
  -- row absent from this business (structurally unreachable in practice —
  -- v_sale_branch_id came from the sale's own composite FK-enforced
  -- column — but checked uniformly regardless) and a branch that exists
  -- but is now INACTIVE are both treated as "sale not found", never a
  -- distinguishable "branch exists but became inactive" disclosure. The
  -- status used here comes from THIS transaction's own just-acquired lock
  -- — never a stale, pre-lock read — so a concurrent deactivation that
  -- wins the race is always reflected correctly.
  if v_branch_status is null or v_branch_status <> 'ACTIVE' then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  -- Branch authority (SEC-01 lesson): a same-business sale in a branch
  -- the caller cannot operationally access is treated IDENTICALLY to a
  -- nonexistent one — never a distinguishable error. Checked BEFORE the
  -- status-eligibility check below, so an inaccessible sale's own status
  -- is never disclosed either. Safe to evaluate here even though
  -- has_branch_access performs its own, otherwise-unlocked, internal read
  -- of business_branches: this transaction already holds the FOR SHARE
  -- lock acquired immediately above, so that internal read is guaranteed
  -- to observe THIS transaction's own already-locked, authoritative row.
  if not private.has_branch_access(p_business_id, v_sale_branch_id) then
    raise exception 'RETURN_SALE_NOT_FOUND' using errcode = '22023';
  end if;

  -- Eligibility: only a COMPLETED sale may be returned. This IS a real,
  -- same-tenant, same-branch, accessible sale, so a distinguishable
  -- error is safe (no enumeration risk — the caller already knows it
  -- exists).
  if v_sale_status <> 'COMPLETED' then
    raise exception 'RETURN_SALE_NOT_ELIGIBLE' using errcode = '23514';
  end if;

  -- 7) LOCK + VALIDATE EACH REFERENCED SALE ITEM, in ASCENDING
  -- sale_item_id order — a DETERMINISTIC lock order independent of the
  -- caller's own submitted item order, which is what makes two
  -- concurrent returns referencing overlapping sale_items structurally
  -- unable to deadlock (see this file's own header comment). Snapshots
  -- are stashed in v_snapshots, keyed by sale_item_id, for the SEPARATE
  -- submission-order insert pass below.
  for v_sorted_item in
    select value as item, (value->>'sale_item_id')::uuid as sale_item_id
    from jsonb_array_elements(v_norm_items)
    order by (value->>'sale_item_id')::uuid
  loop
    select id, product_id, product_name_snapshot, sku_snapshot, unit_price, quantity, unit_cost_snapshot
    into v_sale_item
    from public.sale_items
    where id = v_sorted_item.sale_item_id and sale_id = p_sale_id and business_id = p_business_id
    for update;

    if not found then
      -- Same non-disclosure posture as the sale itself: a sale_item_id
      -- that doesn't exist, belongs to a different sale, or belongs to a
      -- different tenant are all indistinguishable to the caller.
      raise exception 'RETURN_ITEM_NOT_FOUND' using errcode = '22023';
    end if;

    -- Return-quantity invariant, CRITICAL: the sale_item row is already
    -- locked above — a concurrent return against the SAME sale_item
    -- blocks here until this transaction commits or rolls back, so this
    -- SUM can never observe a stale, about-to-be-invalidated value.
    select coalesce(sum(quantity), 0) into v_already_returned
    from public.sale_return_items
    where business_id = p_business_id and sale_item_id = v_sale_item.id;

    if v_already_returned + (v_sorted_item.item->>'quantity')::numeric(14,3) > v_sale_item.quantity then
      raise exception 'RETURN_QUANTITY_EXCEEDED' using errcode = '22023';
    end if;

    v_line_total_wide := round(v_sale_item.unit_price * (v_sorted_item.item->>'quantity')::numeric(14,3), 2);
    if v_line_total_wide > v_max_money then
      raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
    end if;
    v_return_value_basis := v_return_value_basis + v_line_total_wide;

    v_snapshots := jsonb_set(v_snapshots, array[v_sale_item.id::text], jsonb_build_object(
      'product_id', v_sale_item.product_id::text,
      'product_name_snapshot', v_sale_item.product_name_snapshot,
      'sku_snapshot', v_sale_item.sku_snapshot,
      'unit_price_snapshot', v_sale_item.unit_price::text,
      'line_total', v_line_total_wide::text,
      'unit_cost_snapshot', v_sale_item.unit_cost_snapshot::text
    ));

    if (v_sorted_item.item->>'restock')::boolean then
      v_needs_restock := true;
    end if;
  end loop;

  -- 8) REFUND INVARIANTS.
  --
  -- (a) The returned-value basis: a refund tied to returned goods must
  -- never exceed what those goods were actually worth on the original
  -- sale.
  if v_refund_amount > v_return_value_basis then
    raise exception 'RETURN_REFUND_EXCEEDED' using errcode = '22023';
  end if;

  -- (b) The cumulative ceiling: total refunds across EVERY return ever
  -- recorded against this sale must never exceed what was actually
  -- collected on it. Race-safe because the sale row is already locked
  -- FOR UPDATE above, and every sale_returns INSERT for this sale only
  -- ever happens after that same lock is held — a concurrent second
  -- return attempt blocks on the sale lock, never observes a stale sum.
  select coalesce(sum(refund_amount), 0) into v_cumulative_refund
  from public.sale_returns
  where business_id = p_business_id and sale_id = p_sale_id;

  if v_cumulative_refund + v_refund_amount > v_sale_amount_paid then
    raise exception 'RETURN_REFUND_EXCEEDED' using errcode = '22023';
  end if;

  -- 9) ALLOCATE RETURN NUMBER.
  insert into private.business_return_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_return_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_return_number := 'RET-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  -- 10) INSERT THE RETURN HEADER.
  insert into public.sale_returns (
    business_id, return_number, sale_id, branch_id, branch_name_snapshot,
    refund_amount, refund_method, reason, notes, creation_key, created_by
  ) values (
    p_business_id, v_return_number, p_sale_id, v_sale_branch_id, v_sale_branch_name,
    v_refund_amount, v_refund_method, v_reason, v_notes, p_creation_key, v_uid
  )
  returning id into v_sale_return_id;

  -- 11) RESOLVE THE RESTOCK LOCATION ONCE, if any line actually needs it
  -- — the sale's OWN branch canonical/default location, never a
  -- caller-selectable destination ("the caller must never restock a
  -- Branch B sale into Branch A inventory" — this phase's own product
  -- brief; there is no p_inventory_location_id parameter at all).
  if v_needs_restock then
    select id into v_restock_location_id
    from public.inventory_locations
    where business_id = p_business_id and branch_id = v_sale_branch_id
      and is_branch_default = true and status = 'active';

    if v_restock_location_id is null then
      -- Structurally unreachable given every branch's own canonical
      -- default location is guaranteed to exist (Phase 1G's own proven
      -- invariant) — fails loudly rather than silently proceeding if
      -- that were somehow bypassed.
      raise exception 'NO_DEFAULT_LOCATION' using errcode = '22023';
    end if;
  end if;

  -- 12) INSERT THE RETURN ITEMS, in the CALLER'S OWN SUBMITTED ORDER
  -- (v_norm_items, not the ascending-id order used for locking above) —
  -- position must reflect the caller's own meaningful choice, never a
  -- lock-order artifact.
  for v_item in select * from jsonb_array_elements(v_norm_items)
  loop
    v_snapshot := v_snapshots->(v_item->>'sale_item_id');

    insert into public.sale_return_items (
      business_id, sale_return_id, sale_item_id, product_id,
      product_name_snapshot, sku_snapshot, quantity, unit_price_snapshot, line_total,
      restock, position
    ) values (
      p_business_id, v_sale_return_id, (v_item->>'sale_item_id')::uuid, (v_snapshot->>'product_id')::uuid,
      v_snapshot->>'product_name_snapshot', v_snapshot->>'sku_snapshot',
      (v_item->>'quantity')::numeric(14,3), (v_snapshot->>'unit_price_snapshot')::numeric(14,2),
      (v_snapshot->>'line_total')::numeric(14,2),
      (v_item->>'restock')::boolean, v_position
    );
    v_position := v_position + 1;

    if (v_item->>'restock')::boolean then
      -- INSUFFICIENT_STOCK (structurally unreachable for a positive-delta
      -- movement, but checked uniformly regardless) or any other
      -- exception here rolls back this entire transaction — the return
      -- header, every item already inserted, the sequence claim, and the
      -- request-ledger claim all together. No partial completion.
      perform private.apply_inventory_movement(
        p_business_id, (v_snapshot->>'product_id')::uuid, v_restock_location_id, 'SALE_RETURN',
        (v_item->>'quantity')::numeric(14,3),
        nullif(v_snapshot->>'unit_cost_snapshot', '')::numeric(14,2),
        'sale_return', v_sale_return_id,
        'Return ' || v_return_number, null, gen_random_uuid(), v_uid
      );
      v_restocked_count := v_restocked_count + 1;
    end if;
  end loop;

  update private.sale_return_creation_requests set sale_return_id = v_sale_return_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: return.created — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's
  -- own pre-existing "return v_stored_request.sale_return_id;" REPLAY
  -- DECISION line, never reaching here). Branch is the sale's OWN
  -- authoritative branch (v_sale_branch_id, already locked and validated
  -- above) — never caller-supplied. creation_key is deliberately excluded
  -- from metadata, per this phase's own explicit instruction.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'return.created', 'COMMERCE',
    v_sale_branch_id, v_actor_email, null,
    'sale_return', v_sale_return_id, v_return_number, 'SUCCESS',
    jsonb_build_object(
      'refund_amount', v_refund_amount::text,
      'reason', v_reason,
      'restocked_item_count', v_restocked_count
    )
  );

  return v_sale_return_id;
end;
$$;

grant create on schema public to private_sale_return_writer;
alter function public.create_sale_return(uuid, uuid, uuid, jsonb, numeric, text, text, text)
  owner to private_sale_return_writer;
revoke create on schema public from private_sale_return_writer;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant, matching create_invoice's/create_sale's own
-- precedent — service_role already bypasses RLS and has no legitimate
-- reason to call this.
revoke all on function public.create_sale_return(uuid, uuid, uuid, jsonb, numeric, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_sale_return(uuid, uuid, uuid, jsonb, numeric, text, text, text)
  to authenticated;

create or replace function public.create_invoice(
  p_business_id  uuid,
  p_creation_key uuid,
  p_customer_id  uuid,
  p_branch_id    uuid,
  p_items        jsonb,
  p_due_date     date default null,
  p_notes        text default null
)
returns uuid  -- invoice_id ONLY — never the full row, matching create_sale's
              -- own "never leak an internal column merely because the
              -- table gained one" reasoning.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;

  -- Item normalization locals — ONE typed representation, used
  -- identically for duplicate detection, the canonical payload, and the
  -- execution loop below.
  v_raw_item            jsonb;
  v_product_id_text     text;
  v_product_id          uuid;
  v_description         text;
  v_quantity_wide       numeric;
  v_quantity            numeric(14,3);
  v_unit_price_wide     numeric;
  v_seen_products       uuid[] := array[]::uuid[];
  v_norm_items          jsonb := '[]'::jsonb;
  v_max_items           constant int := 100;
  v_max_money           constant numeric := 999999999999.99;

  v_notes               text;
  v_canonical_payload   jsonb;
  v_stored_request      private.invoice_creation_requests;
  v_invoice_id          uuid;

  -- Phase 1J instrumentation local.
  v_actor_email         text;

  -- New-claim-only locals — current-state validation, never consulted on
  -- a replay.
  v_customer_status     text;
  v_customer_name       text;
  v_customer_phone      text;
  v_customer_email      text;
  v_branch_name         text;
  v_seq_number          bigint;
  v_invoice_number      text;
  v_item                record;
  v_product_status      text;
  v_product_name        text;
  v_product_sku         text;
  v_unit_price          numeric(14,2);
  v_line_total_wide     numeric;
  v_total               numeric := 0;
  -- 0-based, assigned strictly in the caller's own submitted order (see
  -- this file's own header comment on why that order is preserved,
  -- never re-sorted) — Codex adversarial review, remediation round 1,
  -- Low 5.
  v_position            int := 0;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_customer_id is null
     or p_branch_id is null or p_items is null then
    raise exception 'p_business_id, p_creation_key, p_customer_id, p_branch_id, and p_items are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never inferred from
  -- anything about the referenced customer/branch/products, so this is
  -- always safe to re-check on every call, replay or not.
  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST — pure input-shape validation, entirely
  -- before any lookup against customer/branch/product current state.

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > v_max_items then
    raise exception 'TOO_MANY_INVOICE_ITEMS' using errcode = '22023';
  end if;

  for v_raw_item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_raw_item) is distinct from 'object' then
      raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
    end if;

    -- product_id: optional. When present, format-validated as a UUID
    -- string BEFORE any cast — a malformed value never reaches a raw
    -- ::uuid cast error.
    if v_raw_item ? 'product_id' and jsonb_typeof(v_raw_item->'product_id') is distinct from 'null' then
      if jsonb_typeof(v_raw_item->'product_id') is distinct from 'string' then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      v_product_id_text := v_raw_item->>'product_id';
      if v_product_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      v_product_id := v_product_id_text::uuid;

      if v_product_id = any(v_seen_products) then
        raise exception 'DUPLICATE_PRODUCT_LINE' using errcode = '22023';
      end if;
      v_seen_products := array_append(v_seen_products, v_product_id);
      v_description := null;  -- server-derived from the product snapshot below — never caller-supplied for a product line
      v_unit_price_wide := null;  -- server-derived (current selling_price) — never caller-supplied for a product line
    else
      v_product_id := null;
      -- A custom (no product) line REQUIRES its own description AND
      -- unit_price — there is no product row to fall back on for either.
      if jsonb_typeof(v_raw_item->'description') is distinct from 'string' then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      v_description := nullif(btrim(v_raw_item->>'description'), '');
      if v_description is null or length(v_description) > 500 then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      if jsonb_typeof(v_raw_item->'unit_price') is distinct from 'number' then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      v_unit_price_wide := (v_raw_item->'unit_price')::text::numeric;
      if v_unit_price_wide < 0 or v_unit_price_wide > v_max_money then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
      -- Codex adversarial review, remediation round 1, Medium 1: a
      -- custom line's unit_price is CALLER-AUTHORITATIVE (there is no
      -- product row to derive it from), so — unlike a product-linked
      -- line's price, which the database itself always sources from
      -- products.selling_price, already a numeric(14,2) column — it must
      -- be independently proven to carry AT MOST 2 decimal places here,
      -- never silently rounded (1.999 must be REJECTED, never coerced to
      -- 2.00). round(numeric, 2) on Postgres's own exact-decimal numeric
      -- type carries no floating-point misclassification risk at all
      -- (unlike a JavaScript float multiplication trick) — this is a
      -- genuine, exact round-trip proof, the same technique quantity's
      -- own numeric(14,3) narrowing already uses one line down.
      if round(v_unit_price_wide, 2) <> v_unit_price_wide then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
    end if;

    -- quantity: same round-trip-proof pattern as create_sale's own
    -- (type-checked as a JSON number, cast to an UNCONSTRAINED numeric,
    -- range-checked, THEN narrowed to numeric(14,3) and proven exactly
    -- equal to the wide value — excess precision is REJECTED, never
    -- silently rounded).
    if jsonb_typeof(v_raw_item->'quantity') is distinct from 'number' then
      raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
    end if;
    v_quantity_wide := (v_raw_item->'quantity')::text::numeric;
    if v_quantity_wide <= 0 or v_quantity_wide > 1000000 then
      raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
    end if;
    v_quantity := v_quantity_wide::numeric(14,3);
    if v_quantity <> v_quantity_wide then
      raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
    end if;

    v_norm_items := v_norm_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id::text,
      'description', v_description,
      'quantity', v_quantity::text,
      'unit_price', v_unit_price_wide::text
    ));
  end loop;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_INVOICE_NOTES' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — item order preserved exactly as
  -- submitted (see this file's own header comment on why, unlike
  -- create_sale's sort). Never includes product/branch/customer names or
  -- any computed total (all server-derived, not caller intent).
  v_canonical_payload := jsonb_build_object(
    'customer_id', p_customer_id,
    'branch_id', p_branch_id,
    'due_date', p_due_date,
    'notes', v_notes,
    'items', v_norm_items
  );

  -- 4) CLAIM
  insert into private.invoice_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about customer/branch/product current
    -- state has been consulted before this point.
    select * into v_stored_request
    from private.invoice_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'INVOICE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.invoice_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current-state
  -- validation begins. This ordering is deliberate and load-bearing: an
  -- EXACT replay of an already-committed invoice returns at step 5,
  -- above, WITHOUT ever re-validating customer/branch/product current
  -- state — so a customer archived or a branch deactivated AFTER an
  -- invoice was already successfully created can never retroactively
  -- break replaying that same, already-settled result. Everything below
  -- this point only ever runs for a genuinely NEW creation attempt.
  --
  -- Codex security audit, SEC-03 ("Branch Deactivation Race"): both the
  -- customer and branch lookups below now take `for share` — a
  -- concurrent archive_customer/deactivate_business_branch attempt
  -- against the SAME row blocks (on Postgres's own row-lock conflict
  -- rules: FOR SHARE is incompatible with the exclusive-ish row lock an
  -- UPDATE always takes) until THIS transaction commits or rolls back,
  -- closing the TOCTOU window where a status flip could land between
  -- this validation and the invoice actually being committed. Products
  -- (in the execution loop below) already use this exact `for share`
  -- technique. Deadlock safety: every lock create_invoice ever takes —
  -- customer, branch, products — is FOR SHARE, and FOR SHARE never
  -- conflicts with another FOR SHARE (multiple concurrent create_invoice
  -- calls, or a read-only reader, can all hold it on the same row at
  -- once) — only a genuinely conflicting WRITE (archive/deactivate) ever
  -- blocks, and only ever in one direction (the writer waits for the
  -- reader; a reader never waits for another reader), so this can never
  -- participate in a deadlock cycle regardless of acquisition order. The
  -- order below (customer, then branch, then products) is nonetheless
  -- fixed and deterministic, matching this function's own pre-existing
  -- validation order exactly.
  --
  -- Scoped directly in the WHERE clause — a foreign-tenant/nonexistent
  -- row is never loaded at all, not loaded-then-compared. Nonexistent and
  -- foreign-tenant are deliberately indistinguishable to the caller.
  select status, name, phone, email
  into v_customer_status, v_customer_name, v_customer_phone, v_customer_email
  from public.customers
  where id = p_customer_id and business_id = p_business_id
  for share;

  if v_customer_name is null then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';
  end if;
  if v_customer_status = 'archived' then
    raise exception 'CUSTOMER_ARCHIVED' using errcode = '23514';
  end if;

  select name into v_branch_name
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for share;

  if v_branch_name is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;

  -- Operational branch access, not merely branch existence — invoice
  -- creation is an operational activity tied to where the caller can act,
  -- exactly like sale creation/opening stock/inventory adjustment. Same
  -- generic, non-disclosing error code has_permission's own check above
  -- uses (this single check already subsumes foreign-tenant,
  -- nonexistent, inactive, and genuinely-unassigned). has_branch_access's
  -- own internal re-read of this same row (private schema, Phase 1F) is
  -- still consistent with — and still covered by — the FOR SHARE lock
  -- already held above: the lock is transaction-scoped, not tied to a
  -- single statement, so it keeps blocking a concurrent deactivation
  -- through this entire function's remaining execution regardless of how
  -- many further reads happen within the same transaction.
  if not private.has_branch_access(p_business_id, p_branch_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  insert into private.business_invoice_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_invoice_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_invoice_number := 'INV-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.invoices (
    business_id, invoice_number, customer_id,
    customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot,
    branch_id, branch_name_snapshot,
    due_date, notes, total_amount, creation_key, created_by
  ) values (
    p_business_id, v_invoice_number, p_customer_id,
    v_customer_name, v_customer_phone, v_customer_email,
    p_branch_id, v_branch_name,
    p_due_date, v_notes, 0.01, p_creation_key, v_uid
    -- total_amount is a placeholder here (0.01, the smallest value that
    -- satisfies the > 0 CHECK) — it is unconditionally overwritten by the
    -- UPDATE below once the real total is known; a genuine zero-total
    -- invoice is rejected by INVOICE_AMOUNT_OUT_OF_RANGE before that
    -- UPDATE ever runs, so this placeholder is never observable by any
    -- reader.
  )
  returning id into v_invoice_id;

  -- Process lines in the caller's own submitted order (v_norm_items, not
  -- re-sorted) — see this file's own header comment.
  for v_item in select * from jsonb_array_elements(v_norm_items)
  loop
    if v_item.value->>'product_id' is not null then
      select name, sku, status, selling_price
      into v_product_name, v_product_sku, v_product_status, v_unit_price
      from public.products
      where id = (v_item.value->>'product_id')::uuid and business_id = p_business_id
      for share;

      if not found then
        raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
      end if;
      if v_product_status <> 'active' then
        raise exception 'PRODUCT_ARCHIVED' using errcode = '23514';
      end if;
      v_description := v_product_name;  -- server-authoritative line label, never the caller's
    else
      v_product_name := null;
      v_product_sku := null;
      v_description := v_item.value->>'description';
      v_unit_price := (v_item.value->>'unit_price')::numeric(14,2);
    end if;

    v_quantity := (v_item.value->>'quantity')::numeric(14,3);

    v_line_total_wide := round(v_unit_price * v_quantity, 2);
    if v_line_total_wide > v_max_money then
      raise exception 'INVOICE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
    end if;
    v_total := v_total + v_line_total_wide;

    insert into public.invoice_items (
      business_id, invoice_id, product_id, product_name_snapshot, sku_snapshot,
      description, quantity, unit_price, line_total, position
    ) values (
      p_business_id, v_invoice_id, (v_item.value->>'product_id')::uuid, v_product_name, v_product_sku,
      v_description, v_quantity, v_unit_price, v_line_total_wide, v_position
    );
    v_position := v_position + 1;
  end loop;

  if v_total > v_max_money then
    raise exception 'INVOICE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if v_total <= 0 then
    raise exception 'INVOICE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  update public.invoices set total_amount = v_total where id = v_invoice_id;

  update private.invoice_creation_requests set invoice_id = v_invoice_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: invoice.created — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's
  -- own pre-existing REPLAY DECISION line, never reaching here). Branch
  -- is p_branch_id itself — already validated same-tenant + operationally
  -- accessible above. No cost/COGS in metadata.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'invoice.created', 'FINANCE',
    p_branch_id, v_actor_email, null,
    'invoice', v_invoice_id, v_invoice_number, 'SUCCESS',
    jsonb_build_object(
      'total_amount', v_total::text,
      'item_count', jsonb_array_length(v_norm_items)
    )
  );

  return v_invoice_id;
end;
$$;

grant create on schema public to private_invoice_writer;
alter function public.create_invoice(uuid, uuid, uuid, uuid, jsonb, date, text)
  owner to private_invoice_writer;
revoke create on schema public from private_invoice_writer;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant, matching create_sale/create_expense's own
-- precedent — service_role already bypasses RLS and has no legitimate
-- reason to call this.
revoke all on function public.create_invoice(uuid, uuid, uuid, uuid, jsonb, date, text)
  from public, anon, service_role;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, jsonb, date, text)
  to authenticated;

create or replace function public.record_invoice_payment(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_invoice_id     uuid,
  p_amount         numeric,
  p_payment_method text,
  -- Codex security audit, SEC-02: TEXT, not timestamptz — see
  -- private.is_valid_offset_bearing_instant's own header comment above
  -- for the full reasoning. The caller's ORIGINAL lexical value must
  -- reach this function's body unparsed, so it can be independently
  -- validated before any implicit Postgres cast has a chance to silently
  -- normalize an ambiguous or impossible instant.
  p_paid_at        text,
  p_reference      text default null,
  p_note           text default null
)
returns uuid  -- payment_id ONLY.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_amount             numeric;
  v_payment_method     text;
  v_paid_at            timestamptz;
  v_reference          text;
  v_note               text;
  v_canonical_payload  jsonb;
  v_stored_request     private.invoice_payment_requests;
  v_payment_id         uuid;

  v_invoice_found      uuid;
  v_branch_id          uuid;
  v_status             text;
  v_total_amount       numeric(14,2);
  v_amount_paid        numeric(14,2);
  v_balance            numeric;
  v_new_amount_paid    numeric(14,2);
  v_new_status         text;
  v_max_money          constant numeric := 999999999999.99;

  -- Phase 1J instrumentation locals.
  v_invoice_number     text;
  v_actor_email        text;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_invoice_id is null
     or p_amount is null or p_payment_method is null or p_paid_at is null then
    raise exception 'p_business_id, p_creation_key, p_invoice_id, p_amount, p_payment_method, and p_paid_at are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never inferred from the
  -- referenced invoice's own state, so this is always safe before the
  -- invoice is even looked up.
  if not private.has_permission(p_business_id, 'payments.record') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST
  v_amount := p_amount;
  if v_amount <= 0 then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
  end if;
  if v_amount > v_max_money then
    raise exception 'PAYMENT_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  -- Codex adversarial review, remediation round 1, Medium 1: p_amount is
  -- caller-authoritative (there is no server-priced source for a payment
  -- amount) and arrives as `numeric`, so — unlike a JS float multiplied
  -- by 100 — round(numeric, 2) is an exact decimal round-trip proof, not
  -- a floating-point approximation: 1.999 must be REJECTED outright,
  -- never silently coerced to 2.00. Same technique as create_invoice's
  -- own custom-line unit_price check (create_invoice_rpc.sql).
  if round(v_amount, 2) <> v_amount then
    raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
  end if;

  v_payment_method := p_payment_method;
  if v_payment_method not in ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;

  v_reference := nullif(btrim(p_reference), '');
  if v_reference is not null and length(v_reference) > 200 then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  v_note := nullif(btrim(p_note), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'INVALID_PAYMENT_NOTE' using errcode = '22023';
  end if;

  -- Codex security audit, SEC-02: this is THE public trust boundary for
  -- p_paid_at — never assume the browser's own datetime-local->instant
  -- conversion or lib/validation/invoices.ts's own PaymentPaidAtSchema
  -- ran first; a direct authenticated RPC caller bypasses both entirely.
  -- Lexical + semantic validation happens BEFORE any cast, exactly
  -- mirroring the application-layer fix's own ordering — see
  -- private.is_valid_offset_bearing_instant's own header comment for the
  -- full technique.
  if not private.is_valid_offset_bearing_instant(p_paid_at) then
    raise exception 'INVALID_PAYMENT_DATE' using errcode = '22023';
  end if;
  -- Safe ONLY now: every calendar/clock/offset component has already
  -- been proven real and unambiguous, so this cast has nothing left to
  -- silently normalize — it can only ever produce the exact instant the
  -- caller's own string denoted.
  v_paid_at := p_paid_at::timestamptz;
  -- Same 1-day future grace window as PaymentPaidAtSchema
  -- (lib/validation/invoices.ts) — enforced independently here too, for
  -- the identical reason: a direct RPC caller must never be able to
  -- backdate the application layer's own future-date rule.
  if v_paid_at > now() + interval '1 day' then
    raise exception 'PAYMENT_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  -- Canonicalized to the PARSED UTC instant (v_paid_at, a timestamptz —
  -- internally just a UTC point in time with no retained textual form),
  -- never the raw p_paid_at text — so two different-but-equivalent
  -- explicit representations of the exact same instant
  -- ("2026-08-31T15:30:00+01:00" and "2026-08-31T14:30:00Z") fingerprint
  -- IDENTICALLY. jsonb_build_object's own serialization of a timestamptz
  -- value is deterministic for a given, fixed session timezone (a
  -- server-side setting, never caller-controlled — so this is consistent
  -- across every call, whatever that setting is), so the same instant
  -- always produces the same canonical_payload regardless of which of
  -- its many equally-valid textual spellings the caller originally
  -- submitted. This preserves record_invoice_payment's own pre-existing
  -- idempotency behavior exactly — the canonical payload
  -- already embedded the (implicitly cast) timestamptz value before this
  -- fix, never the raw text, so replay/mismatch semantics are unchanged.
  v_canonical_payload := jsonb_build_object(
    'invoice_id', p_invoice_id,
    'amount', v_amount::text,
    'payment_method', v_payment_method,
    'paid_at', v_paid_at,
    'reference', v_reference,
    'note', v_note
  );

  -- 4) CLAIM
  insert into private.invoice_payment_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the invoice's current state has
    -- been consulted before this point.
    select * into v_stored_request
    from private.invoice_payment_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'PAYMENT_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.payment_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE. Lock the invoice row
  -- BEFORE reading its balance — see this file's own header comment on
  -- why this is what makes concurrent overpayment structurally
  -- impossible, not merely unlikely.
  select id, branch_id, status, total_amount, amount_paid, invoice_number
  into v_invoice_found, v_branch_id, v_status, v_total_amount, v_amount_paid, v_invoice_number
  from public.invoices
  where id = p_invoice_id and business_id = p_business_id
  for update;

  if v_invoice_found is null then
    raise exception 'INVOICE_NOT_FOUND' using errcode = '22023';
  end if;
  if v_status = 'VOID' then
    raise exception 'INVOICE_VOID' using errcode = '23514';
  end if;
  if v_status = 'PAID' then
    raise exception 'INVOICE_ALREADY_PAID' using errcode = '23514';
  end if;

  v_balance := v_total_amount - v_amount_paid;
  if v_amount > v_balance then
    raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode = '22023';
  end if;

  v_new_amount_paid := v_amount_paid + v_amount;
  v_new_status := case when v_new_amount_paid = v_total_amount then 'PAID' else 'PARTIALLY_PAID' end;

  -- branch_id is ALWAYS the invoice's own — never a caller-supplied
  -- value (there is no p_branch_id parameter at all; see this migration's
  -- own header comment for the full reasoning).
  insert into public.invoice_payments (
    business_id, invoice_id, branch_id, amount, payment_method,
    reference, note, paid_at, creation_key, recorded_by
  ) values (
    p_business_id, p_invoice_id, v_branch_id, v_amount, v_payment_method,
    v_reference, v_note, v_paid_at, p_creation_key, v_uid
  )
  returning id into v_payment_id;

  update public.invoices
  set amount_paid = v_new_amount_paid, status = v_new_status
  where id = p_invoice_id and business_id = p_business_id;

  update private.invoice_payment_requests set payment_id = v_payment_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: payment.recorded — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's
  -- own pre-existing REPLAY DECISION line, never reaching here). Branch
  -- is the INVOICE's own authoritative branch (v_branch_id, read from the
  -- locked row) — never caller-supplied, matching this function's own
  -- header comment. No card/bank account detail in metadata — amount and
  -- method only.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'payment.recorded', 'FINANCE',
    v_branch_id, v_actor_email, null,
    'invoice_payment', v_payment_id, v_invoice_number, 'SUCCESS',
    jsonb_build_object(
      'amount', v_amount::text,
      'method', v_payment_method
    )
  );

  return v_payment_id;
end;
$$;

grant create on schema public to private_invoice_payment_writer;
alter function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  owner to private_invoice_payment_writer;
revoke create on schema public from private_invoice_payment_writer;

revoke all on function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.record_invoice_payment(uuid, uuid, uuid, numeric, text, text, text, text)
  to authenticated;

create or replace function public.create_expense(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_category_id    uuid,
  p_amount         numeric,
  p_payment_method text,
  p_incurred_at    timestamptz,
  p_payee          text default null,
  p_reference      text default null,
  p_notes          text default null,
  -- NEW, appended last, defaulted — Postgres allows appending defaulted
  -- parameters to an existing function's signature via CREATE OR REPLACE;
  -- it does not allow reordering or removing any existing one, and this
  -- does neither. PostgREST resolves RPC calls by NAMED parameter from the
  -- JSON body it receives, so the current Phase 1F application — which
  -- never sends a `p_branch_id` key at all — keeps calling this exact
  -- function exactly as before and simply gets NULL (business-wide),
  -- exactly matching every expense it has ever posted to date.
  p_branch_id      uuid default null
)
returns uuid  -- expense_id ONLY — never the full row, never a composite
              -- that could later leak an internal column merely because
              -- the table gained one.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;

  -- The exact maximum representable value of a numeric(14,2) column
  -- (precision 14, scale 2 -> 12 digits before the decimal point):
  -- 999,999,999,999.99. Mirrors create_sale's own v_max_money exactly —
  -- validated in an UNCONSTRAINED `numeric` local BEFORE ever being
  -- assigned into a numeric(14,2) column, so an out-of-range value never
  -- surfaces Postgres's own raw "numeric field overflow" error as the
  -- public contract.
  v_max_money          constant numeric := 999999999999.99;

  v_amount             numeric;
  -- The narrowed, numeric(14,2)-scaled candidate — used for the round-trip
  -- precision proof below, then as the ONE canonical representation of
  -- the amount from that point on (the INSERT, and the canonical payload
  -- both read v_amount_narrowed, never v_amount, once validated).
  v_amount_narrowed    numeric(14,2);
  v_payment_method     text;
  v_payee              text;
  v_reference          text;
  v_notes              text;
  v_incurred_at        timestamptz;

  v_canonical_payload  jsonb;
  -- Loaded via an explicit column list (never `select *`) — the narrowed
  -- SELECT grant on private.expense_creation_requests (see the role grant
  -- above) covers exactly canonical_payload/expense_id, not created_at,
  -- so `select * into a-full-row-record` would fail with "permission
  -- denied" for the excluded column.
  v_stored_payload     jsonb;
  v_stored_expense_id  uuid;
  v_expense_id         uuid;

  -- New-claim-only locals — current category/branch-state validation,
  -- never consulted on a replay.
  v_category_business_id uuid;
  v_category_name         text;
  v_category_status        text;
  v_branch_business_id      uuid;
  v_branch_name              text;
  v_branch_status             text;
  v_seq_number                bigint;
  v_expense_number              text;
  -- Phase 1J instrumentation local.
  v_actor_email                 text;
begin
  -- 1) AUTHENTICATE
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_category_id is null then
    raise exception 'p_business_id, p_creation_key, and p_category_id are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, never "mutable referenced
  -- category/branch state", so this is always safe to re-check on every
  -- call, replay or not. See this file's own header comment for why this
  -- deliberately stays the ONLY authorization gate — no has_branch_access
  -- check is added here, unlike create_sale's.
  if not private.has_permission(p_business_id, 'expenses.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY. Every malformed-input error
  -- below is controlled and happens BEFORE any lookup against the
  -- category's/branch's current state, and BEFORE the idempotency claim —
  -- so the claim's canonical payload is always built from already-
  -- validated, normalized values.

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;
  if p_amount > v_max_money then
    raise exception 'EXPENSE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  v_amount := p_amount;

  -- Excess precision (more than 2 decimal places) must be REJECTED, never
  -- silently rounded — mirrors create_sale's own quantity round-trip proof
  -- exactly (see that function's comment for the full reasoning). Casting
  -- to numeric(14,2) ROUNDS (1.234 -> 1.23) rather than raising, so
  -- proving the narrowed candidate is numerically EQUAL to the original
  -- unconstrained value is what makes this a genuine round-trip proof
  -- rather than textual decimal-place counting. Done here, on the
  -- unconstrained local, BEFORE the idempotency claim below — an
  -- excess-precision amount never reaches the request-ledger, the
  -- sequence table, or the expenses table at all.
  v_amount_narrowed := v_amount::numeric(14,2);
  if v_amount_narrowed <> v_amount then
    raise exception 'INVALID_EXPENSE_AMOUNT' using errcode = '22023';
  end if;

  v_payment_method := nullif(btrim(p_payment_method), '');
  if v_payment_method is null
     or v_payment_method not in ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER') then
    raise exception 'INVALID_EXPENSE_PAYMENT_METHOD' using errcode = '22023';
  end if;

  -- A small forward grace window (clock skew) is tolerated; an expense
  -- dated meaningfully in the future is never a valid "incurred" record.
  -- No lower bound — legitimate historical backfill entries are expected.
  if p_incurred_at is null or p_incurred_at > now() + interval '1 day' then
    raise exception 'INVALID_EXPENSE_DATE' using errcode = '22023';
  end if;
  v_incurred_at := p_incurred_at;

  v_payee := nullif(btrim(p_payee), '');
  if v_payee is not null and length(v_payee) > 200 then
    raise exception 'INVALID_EXPENSE_PAYEE' using errcode = '22023';
  end if;

  v_reference := nullif(btrim(p_reference), '');
  if v_reference is not null and length(v_reference) > 100 then
    raise exception 'INVALID_EXPENSE_REFERENCE' using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_EXPENSE_NOTES' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — category_id, amount,
  -- payment_method, payee, reference, notes, incurred_at, branch_id ONLY.
  -- Never includes expense_number, category_name_snapshot,
  -- branch_name_snapshot, status, created_by, or any other computed/
  -- internal field — business_id is already the claim row's own
  -- primary-key component, so it is likewise omitted here (mirrors
  -- create_sale's/create_customer's own payload shape exactly). branch_id
  -- IS included (Phase 1G): a reused creation_key with a genuinely
  -- different branch attribution (including NULL vs a real branch) must
  -- be rejected as payload reuse, never silently resolved to whichever
  -- was requested first. incurred_at is stored as epoch seconds (text),
  -- not the timestamptz's own to_json() rendering: that rendering is
  -- session-TimeZone-dependent, so the SAME instant could otherwise
  -- serialize differently across two calls and make an exact replay
  -- falsely look like a conflicting request. Epoch-seconds text is
  -- timezone-invariant and exact.
  --
  -- amount is canonicalized through v_amount_narrowed (the validated
  -- numeric(14,2) candidate), NOT v_amount (the raw unconstrained input) —
  -- numeric(14,2)::text always produces exactly 2 decimal places
  -- (1, 1.0, and 1.00 all narrow to the identical numeric(14,2) value,
  -- which formats as the identical text "1.00"), so semantically
  -- equivalent amounts canonicalize identically regardless of how the
  -- caller happened to format the number. Using the unvalidated v_amount
  -- here instead would let differently-formatted-but-equal amounts
  -- falsely conflict under the same creation_key.
  v_canonical_payload := jsonb_build_object(
    'category_id', p_category_id,
    'amount', v_amount_narrowed::text,
    'payment_method', v_payment_method,
    'payee', v_payee,
    'reference', v_reference,
    'notes', v_notes,
    'incurred_at', extract(epoch from v_incurred_at)::text,
    'branch_id', p_branch_id
  );

  -- 4) CLAIM
  insert into private.expense_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about the category's/branch's current
    -- state has been consulted before this point.
    select canonical_payload, expense_id into v_stored_payload, v_stored_expense_id
    from private.expense_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'EXPENSE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_expense_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE — current category/
  -- branch-state validation begins. Scoped directly in the WHERE clause —
  -- a foreign-tenant category/branch is never loaded at all, not
  -- loaded-then-compared.
  select business_id, name, status
  into v_category_business_id, v_category_name, v_category_status
  from public.expense_categories
  where id = p_category_id and business_id = p_business_id;

  if v_category_business_id is null then
    raise exception 'EXPENSE_CATEGORY_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
  end if;
  if v_category_status <> 'ACTIVE' then
    raise exception 'EXPENSE_CATEGORY_ARCHIVED' using errcode = '23514';   -- real, same-tenant: informative
  end if;

  -- Branch attribution is entirely OPTIONAL — a NULL p_branch_id (the
  -- default, and the only value the current, unmodified Phase 1F
  -- application will ever send) means "business-wide" and skips this
  -- block entirely, exactly preserving today's behavior.
  if p_branch_id is not null then
    select business_id, name, status
    into v_branch_business_id, v_branch_name, v_branch_status
    from public.business_branches
    where id = p_branch_id and business_id = p_business_id;

    if v_branch_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';  -- nonexistent/foreign: indistinguishable
    end if;
    if v_branch_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';   -- real, same-tenant: informative
    end if;
  end if;

  insert into private.business_expense_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_expense_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  -- lpad(string, length) TRUNCATES (keeping only the leftmost `length`
  -- characters) when the input is already longer than `length` — see
  -- create_sale's own comment for the confirmed-live example.
  -- greatest(6, length(...)) pads to AT LEAST 6 digits for the common case
  -- and never truncates once the counter exceeds 999999.
  v_expense_number := 'EXP-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.expenses (
    business_id, expense_number, category_id, category_name_snapshot,
    branch_id, branch_name_snapshot,
    amount, payment_method, payee, reference, notes, incurred_at,
    creation_key, created_by
  ) values (
    p_business_id, v_expense_number, p_category_id, v_category_name,
    p_branch_id, v_branch_name,
    v_amount_narrowed, v_payment_method, v_payee, v_reference, v_notes, v_incurred_at,
    p_creation_key, v_uid
  )
  returning id into v_expense_id;

  update private.expense_creation_requests set expense_id = v_expense_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: expense.posted — named to match this
  -- table's own status model exactly (public.expenses.status defaults to
  -- 'POSTED' immediately on creation; there is no separate draft/created
  -- state — see create_expenses.sql's own header comment), never
  -- "expense.created", so the audit action vocabulary mirrors the real
  -- domain model rather than inventing a generic synonym. Recorded only
  -- on this NEW-CLAIM path (an exact replay returns earlier, at this
  -- function's own pre-existing REPLAY DECISION line, never reaching
  -- here). Branch is p_branch_id itself (nullable — a business-wide
  -- expense has no branch, matching this function's own optional-branch
  -- design). Label prefers the payee (who was paid), falling back to the
  -- category name when no payee was given.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'expense.posted', 'FINANCE',
    p_branch_id, v_actor_email, null,
    'expense', v_expense_id, coalesce(v_payee, v_category_name), 'SUCCESS',
    jsonb_build_object(
      'amount', v_amount_narrowed::text,
      'category', v_category_name
    )
  );

  return v_expense_id;
end;
$$;

-- Ownership transfer + explicit, narrow EXECUTE surface — required in
-- full here (unlike a genuine in-place CREATE OR REPLACE) because the DROP
-- above means this is a freshly-created function object. Mirrors
-- create_expense_creation_requests_and_rpc.sql's own original ownership/
-- grant block exactly, just for the new ten-parameter signature.
grant create on schema public to private_expense_writer;
alter function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  owner to private_expense_writer;
revoke create on schema public from private_expense_writer;

revoke all on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  from public, anon, service_role;
grant execute on function public.create_expense(uuid, uuid, uuid, numeric, text, timestamptz, text, text, text, uuid)
  to authenticated;

create or replace function public.record_inventory_movement(
  p_business_id           uuid,
  p_product_id            uuid,
  p_inventory_location_id uuid,
  p_movement_type         text,
  p_quantity              numeric,
  p_idempotency_key       uuid,
  p_unit_cost             numeric default null,
  p_reason                text default null,
  p_note                  text default null,
  p_reference_type        text default null,
  p_reference_id          uuid default null
)
returns public.inventory_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                          uuid;
  v_branch_id                    uuid;
  v_effective_location_id        uuid;
  v_legacy_default_location_id   uuid;
  v_primary_branch_id            uuid;
  v_primary_location_id          uuid;
  -- Phase 1J instrumentation locals.
  v_ledger                       public.inventory_ledger;
  v_actor_email                  text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if not private.has_permission(p_business_id, 'inventory.adjust') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Phase 1G: the caller must also have operational access to whichever
  -- branch the TARGET LOCATION currently belongs to. A location that does
  -- not exist, or belongs to a different business, resolves v_branch_id to
  -- NULL here and is left for private.apply_inventory_movement's own
  -- existing, unchanged LOCATION_NOT_FOUND check to report — this
  -- function does not preempt that with a less specific error.
  v_effective_location_id := p_inventory_location_id;

  select branch_id into v_branch_id
  from public.inventory_locations
  where id = p_inventory_location_id and business_id = p_business_id;

  if v_branch_id is not null and not private.has_branch_access(p_business_id, v_branch_id) then
    -- Codex adversarial review Phase 1G round 2, Medium 2C: the current,
    -- UNMODIFIED Phase 1F inventory-adjustment application always supplies
    -- the business-wide LEGACY default inventory location (Phase 1C's own
    -- inventory_locations.is_default) — it has no branch/location chooser
    -- yet. A Branch-B-only staff member would otherwise ALWAYS fail here,
    -- even though they are a perfectly legitimate operator of their own
    -- (different) branch, purely because the application, not the caller,
    -- chose the wrong location id. This is a NARROW, explicitly-scoped
    -- transitional compatibility alias — it exists ONLY for this exact
    -- legacy shape, and is retired the moment the Phase 1G application
    -- sends a real, branch-aware location choice explicitly. It must
    -- NEVER generalize into "any inaccessible location silently becomes
    -- my own primary location": every other inaccessible-location case —
    -- a foreign location (LOCATION_NOT_FOUND, below, unaffected), an
    -- arbitrary inaccessible Branch C location, an inactive branch, or an
    -- accessible-but-non-default explicit location — is still rejected or
    -- honored exactly as before. All FOUR of the following must hold, or
    -- this call is rejected exactly as it already was pre-Medium-2C:
    --   1. the SUPPLIED location is EXACTLY the business's current legacy
    --      is_default location (never merely "some other inaccessible
    --      location the caller happens to not have access to");
    --   2. the caller does NOT have branch access to it (already proven
    --      true to even reach this branch);
    --   3. the caller has a valid ACTIVE primary branch assignment; and
    --   4. that primary branch has its own canonical ACTIVE operational
    --      location.
    -- Idempotency note: the RESOLVED (v_effective_location_id), never the
    -- caller-supplied legacy alias, is what gets passed to
    -- apply_inventory_movement below — that function's own idempotency
    -- comparison (inventory_ledger.inventory_location_id) therefore always
    -- reflects the ACTUAL operational location a movement was recorded
    -- against, never a stale alias.
    select id into v_legacy_default_location_id
    from public.inventory_locations
    where business_id = p_business_id and is_default = true;

    if p_inventory_location_id is not distinct from v_legacy_default_location_id then
      select bmb.branch_id into v_primary_branch_id
      from public.business_members bm
      join public.business_member_branches bmb
        on bmb.member_id = bm.id and bmb.business_id = bm.business_id
      where bm.business_id = p_business_id
        and bm.user_id = v_uid
        and bm.status = 'active'
        and bmb.is_primary = true;

      if v_primary_branch_id is not null and private.has_branch_access(p_business_id, v_primary_branch_id) then
        select id into v_primary_location_id
        from public.inventory_locations
        where business_id = p_business_id and branch_id = v_primary_branch_id
          and is_branch_default = true and status = 'active';
      end if;

      if v_primary_location_id is null then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;

      v_effective_location_id := v_primary_location_id;
    else
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_ledger := private.apply_inventory_movement(
    p_business_id, p_product_id, v_effective_location_id, p_movement_type,
    p_quantity, p_unit_cost, p_reference_type, p_reference_id,
    p_reason, p_note, p_idempotency_key, v_uid
  );

  -- Phase 1J instrumentation: inventory.adjusted — fires ONLY for the
  -- explicit MANUAL adjustment movement types (ADJUSTMENT_IN/
  -- ADJUSTMENT_OUT), never for OPENING_STOCK (create_product's own
  -- bundled opening-stock path already calls
  -- private.apply_inventory_movement directly, never through this public
  -- wrapper, so that path is structurally excluded regardless) and never
  -- for SALE/SALE_RETURN (those are called directly by create_sale/
  -- create_sale_return, bypassing this wrapper entirely — see this
  -- migration's own header comment: instrumenting apply_inventory_movement
  -- itself would fire a redundant, noisy low-level event on TOP of the
  -- already-semantic sale.created/return.created event those functions
  -- record, which this phase's own product brief explicitly says to
  -- avoid). private.apply_inventory_movement's own idempotency-replay
  -- path (a duplicate p_idempotency_key) returns the SAME already-committed
  -- ledger row from ITS OWN prior insert — but that replay can only ever
  -- be reached by calling this manual-adjustment RPC a second time with
  -- the identical key, which is exactly the same "exact replay never
  -- duplicates the audit event" property this migration's other
  -- instrumented functions establish; re-recording here on a replay would
  -- be observably identical in content (same ledger row, same actor,
  -- same everything) but would still create a SECOND audit_events row,
  -- so replay detection matters here too. It is provided by comparing
  -- this call's own idempotency key against the ledger row's own stored
  -- one: a genuinely NEW movement's ledger row always has
  -- idempotency_key = p_idempotency_key (the value THIS call supplied);
  -- an exact replay's returned row still carries that SAME key (it's the
  -- row's own immutable column), so this check cannot actually
  -- distinguish them by key alone. Instead, created_at is compared
  -- against the start of this call's own transaction: a freshly-inserted
  -- row's created_at is set by the SAME `now()` this transaction would
  -- observe; a replayed (pre-existing) row's created_at is strictly
  -- earlier. This is a conservative, cheap check — it can never
  -- false-negative (skip a real new movement), and a false-positive
  -- (recording an event for what was actually a replay) is structurally
  -- impossible because `now()` inside one transaction is fixed and a
  -- genuinely prior row's own created_at was necessarily committed
  -- before this transaction even began.
  if p_movement_type in ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') and v_ledger.created_at >= transaction_timestamp() then
    v_actor_email := private.current_verified_email();
    perform private.record_audit_event(
      p_business_id, 'USER', v_uid, 'inventory.adjusted', 'INVENTORY',
      v_branch_id, v_actor_email, null,
      'product', p_product_id, null, 'SUCCESS',
      jsonb_build_object(
        'quantity_delta', v_ledger.quantity_delta::text,
        'movement_type', p_movement_type
      )
    );
  end if;

  return v_ledger;
end;
$$;

create or replace function public.create_customer(
  p_business_id  uuid,
  p_creation_key uuid,
  p_name         text,
  p_phone        text default null,
  p_email        text default null,
  p_address      text default null,
  p_notes        text default null
)
returns uuid  -- customer_id ONLY — never the full row, never a composite
              -- that could later leak an internal column simply because
              -- the table gained one.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_name               text;
  v_phone              text;
  v_email              text;
  v_address            text;
  v_notes              text;
  v_canonical_payload  jsonb;
  v_customer_id        uuid;
  v_stored_request     private.customer_creation_requests;
  -- Phase 1J instrumentation local.
  v_actor_email        text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null then
    raise exception 'p_business_id and p_creation_key are required'
      using errcode = '22023';
  end if;

  -- business_id is validated, never trusted: this is what makes a forged
  -- business_id harmless.
  if not private.has_permission(p_business_id, 'customers.manage') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Normalize before both persistence and comparison — every field that
  -- participates in the canonical payload is derived from these
  -- normalized locals, never the raw parameters, so the stored request
  -- and any freshly-computed candidate for a retry are byte-identical
  -- when the caller's intent is identical.
  -- Every field is validated against the EXACT same rule the
  -- customers table's own CHECK constraints enforce (create_customers.sql),
  -- BEFORE the INSERT, so a malformed value never reaches the database's
  -- own constraint machinery — an unhandled CHECK violation returns the
  -- constraint name, the SQLSTATE, and the full attempted row (business
  -- id, generated customer id, created_by, timestamps, notes contents)
  -- through PostgREST, which is not an acceptable public error boundary
  -- for ordinary invalid input. The table CHECKs remain as a structural
  -- backstop for any OTHER writer (there is none today — customers has
  -- no INSERT policy for `authenticated` at all — but the backstop is
  -- cheap insurance against a future writer forgetting this validation).
  v_name := btrim(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'INVALID_CUSTOMER_NAME'
      using errcode = '22023';
  end if;

  v_phone := nullif(btrim(p_phone), '');
  if v_phone is not null and length(v_phone) not between 1 and 32 then
    raise exception 'INVALID_CUSTOMER_PHONE'
      using errcode = '22023';
  end if;

  v_email := nullif(btrim(p_email), '');
  if v_email is not null and (
    length(v_email) > 254
    or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception 'INVALID_CUSTOMER_EMAIL'
      using errcode = '22023';
  end if;

  v_address := nullif(btrim(p_address), '');
  if v_address is not null and length(v_address) > 500 then
    raise exception 'INVALID_CUSTOMER_ADDRESS'
      using errcode = '22023';
  end if;

  v_notes := nullif(btrim(p_notes), '');
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'INVALID_CUSTOMER_NOTES'
      using errcode = '22023';
  end if;

  v_canonical_payload := jsonb_build_object(
    'name', v_name,
    'phone', v_phone,
    'email', v_email,
    'address', v_address,
    'notes', v_notes
  );

  -- Claim (business_id, creation_key) atomically. This INSERT is the SOLE
  -- arbiter of "who creates this customer" — not any constraint on the
  -- customers table itself. Two concurrent callers with the same key:
  -- exactly one INSERT here succeeds; Postgres blocks the other on the
  -- winner's row lock until the winner's transaction resolves, then
  -- re-evaluates the conflict against the final state — no
  -- check-then-insert race window.
  insert into private.customer_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if found then
    -- We won the claim: create the customer now.
    insert into public.customers (business_id, name, phone, email, address, notes, created_by)
    values (p_business_id, v_name, v_phone, v_email, v_address, v_notes, v_uid)
    returning id into v_customer_id;

    update private.customer_creation_requests
    set customer_id = v_customer_id
    where business_id = p_business_id and creation_key = p_creation_key;

    -- Phase 1J instrumentation: customer.created — recorded only on this
    -- WON-CLAIM path (a lost claim/replay falls through to the "we lost
    -- the claim" branch below, returning early, never reaching here).
    -- Customers are not branch-scoped in this schema, so branch_id is
    -- NULL (business-wide). No phone/email duplication in metadata — the
    -- name alone is the resource label.
    v_actor_email := private.current_verified_email();
    perform private.record_audit_event(
      p_business_id, 'USER', v_uid, 'customer.created', 'CUSTOMER',
      null, v_actor_email, null,
      'customer', v_customer_id, v_name, 'SUCCESS', '{}'::jsonb
    );

    return v_customer_id;
  end if;

  -- We lost the claim (or it already existed from a prior call): load the
  -- WINNING/ORIGINAL request and compare against it — never against the
  -- customer row's current, possibly since-edited values. This is what
  -- makes a retry of the original request still recognized correctly even
  -- after the customer has been renamed/re-contacted in the meantime.
  select * into v_stored_request
  from private.customer_creation_requests
  where business_id = p_business_id and creation_key = p_creation_key;

  if v_stored_request.canonical_payload is distinct from v_canonical_payload then
    raise exception 'CUSTOMER_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
  end if;

  return v_stored_request.customer_id;
end;
$$;

alter function public.create_customer(uuid, uuid, text, text, text, text, text)
  owner to private_customer_creator;
revoke all on function public.create_customer(uuid, uuid, text, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_customer(uuid, uuid, text, text, text, text, text)
  to authenticated;

create or replace function public.create_business_branch(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_name           text,
  p_code           text default null,
  p_address_line1  text default null,
  p_address_line2  text default null,
  p_city           text default null,
  p_state          text default null,
  p_country_code   text default 'NG',
  p_phone          text default null
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_name               text;
  v_code               text;
  v_address_line1      text;
  v_address_line2      text;
  v_city               text;
  v_state              text;
  v_country_code       text;
  v_phone              text;
  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_branch_id   uuid;
  v_branch_id          uuid;
  v_constraint         text;
  -- Phase 1J instrumentation local.
  v_actor_email        text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null then
    raise exception 'p_business_id and p_creation_key are required' using errcode = '22023';
  end if;

  if not private.has_permission(p_business_id, 'branches.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- NORMALIZE + VALIDATE INPUT SHAPE ONLY — every rule here mirrors
  -- business_branches' own CHECK constraints exactly, applied BEFORE the
  -- idempotency claim, so the claim's canonical payload is always built
  -- from already-validated, normalized values. Name is canonicalized
  -- (internal whitespace collapsed) BEFORE the length check, so the
  -- length bound applies to the exact form that gets persisted and
  -- compared for uniqueness — never the raw, pre-collapse string.
  v_name := private.canonicalize_branch_name(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'INVALID_BRANCH_NAME' using errcode = '22023';
  end if;

  -- Codes are validated, never whitespace-collapsed — an internal space
  -- is rejected outright (INVALID_BRANCH_CODE), matching the table's own
  -- CHECK exactly, so this never surfaces as a raw constraint violation
  -- for the common case.
  v_code := nullif(btrim(p_code), '');
  if v_code is not null and (length(v_code) > 20 or v_code ~ '[[:space:]]') then
    raise exception 'INVALID_BRANCH_CODE' using errcode = '22023';
  end if;

  v_address_line1 := nullif(btrim(p_address_line1), '');
  if v_address_line1 is not null and length(v_address_line1) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_address_line2 := nullif(btrim(p_address_line2), '');
  if v_address_line2 is not null and length(v_address_line2) > 200 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_city := nullif(btrim(p_city), '');
  if v_city is not null and length(v_city) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;
  v_state := nullif(btrim(p_state), '');
  if v_state is not null and length(v_state) > 100 then
    raise exception 'INVALID_BRANCH_ADDRESS' using errcode = '22023';
  end if;

  v_country_code := upper(btrim(coalesce(p_country_code, 'NG')));
  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'INVALID_BRANCH_COUNTRY_CODE' using errcode = '22023';
  end if;

  v_phone := nullif(btrim(p_phone), '');
  if v_phone is not null and length(v_phone) > 32 then
    raise exception 'INVALID_BRANCH_PHONE' using errcode = '22023';
  end if;

  v_canonical_payload := jsonb_build_object(
    'name', v_name,
    'code', v_code,
    'address_line1', v_address_line1,
    'address_line2', v_address_line2,
    'city', v_city,
    'state', v_state,
    'country_code', v_country_code,
    'phone', v_phone
  );

  -- CLAIM
  insert into private.business_branch_creation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- REPLAY DECISION — no current-state validation consulted before
    -- this. Explicit column list (never `select *`), matching the
    -- role's own narrowed SELECT grant above.
    select canonical_payload, branch_id into v_stored_payload, v_stored_branch_id
    from private.business_branch_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'BRANCH_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_branch_id;
  end if;

  -- ONLY A NEWLY CLAIMED REQUEST REACHES HERE. New branches are never
  -- created as the default — public.set_default_business_branch is the
  -- only path that ever changes is_default.
  begin
    insert into public.business_branches (
      business_id, name, code, address_line1, address_line2, city, state,
      country_code, phone, created_by
    ) values (
      p_business_id, v_name, v_code, v_address_line1, v_address_line2, v_city, v_state,
      v_country_code, v_phone, v_uid
    )
    returning id into v_branch_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'business_branches_name_unique_idx' then
        raise exception 'BRANCH_NAME_ALREADY_EXISTS' using errcode = '23505';
      elsif v_constraint = 'business_branches_code_unique_idx' then
        raise exception 'BRANCH_CODE_ALREADY_EXISTS' using errcode = '23505';
      end if;
      raise;
  end;

  update private.business_branch_creation_requests set branch_id = v_branch_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: branch.created — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's
  -- own pre-existing REPLAY DECISION line, never reaching here). The
  -- event's own branch_id IS the newly created branch itself.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'branch.created', 'ORGANIZATION',
    v_branch_id, v_actor_email, null,
    'branch', v_branch_id, v_name, 'SUCCESS', '{}'::jsonb
  );

  return v_branch_id;
end;
$$;

create or replace function public.deactivate_business_branch(
  p_business_id uuid,
  p_branch_id   uuid
)
returns uuid  -- branch_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_found_id   uuid;
  v_status     text;
  v_is_default boolean;
  -- Phase 1J instrumentation locals.
  v_name       text;
  v_actor_email text;
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

  select id, status, is_default, name into v_found_id, v_status, v_is_default, v_name
  from public.business_branches
  where id = p_branch_id and business_id = p_business_id
  for update;

  if v_found_id is null then
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;
  if v_is_default then
    raise exception 'DEFAULT_BRANCH_CANNOT_BE_DEACTIVATED' using errcode = '23514';
  end if;
  if v_status = 'INACTIVE' then
    return v_found_id;  -- already inactive: no-op, not an error — no
                         -- audit event either: nothing actually changed.
  end if;

  update public.business_branches set status = 'INACTIVE'
  where id = p_branch_id and business_id = p_business_id;

  -- Phase 1J instrumentation: branch.deactivated. This function has no
  -- idempotency-ledger of its own (see this migration's own header
  -- comment) — its OWN pre-existing "already inactive: no-op" branch
  -- above is what prevents a duplicate event on a repeated call, exactly
  -- like it already prevents a duplicate state transition.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'branch.deactivated', 'ORGANIZATION',
    v_found_id, v_actor_email, null,
    'branch', v_found_id, v_name, 'SUCCESS', '{}'::jsonb
  );

  return v_found_id;
end;
$$;

create or replace function public.create_business_invitation(
  p_business_id        uuid,
  p_creation_key       uuid,
  p_email              text,
  p_role               text,
  p_branch_ids         jsonb default '[]'::jsonb,
  p_primary_branch_id  uuid default null
)
returns uuid  -- invitation_id ONLY
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;
  v_caller_role        text;
  v_email              text;
  v_role_id            uuid;
  v_raw_id             jsonb;
  v_branch_id_text     text;
  v_branch_id          uuid;
  v_branch_ids         uuid[] := array[]::uuid[];
  v_max_branches       constant int := 50;
  v_canonical_payload  jsonb;
  v_stored_payload     jsonb;
  v_stored_invitation_id uuid;
  v_invitation_id      uuid;
  v_status             text;
  v_found_business_id  uuid;
  -- Phase 1J instrumentation local.
  v_actor_email        text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null or p_email is null or p_role is null then
    raise exception 'p_business_id, p_creation_key, p_email, and p_role are required'
      using errcode = '22023';
  end if;

  -- 2) AUTHORIZE — the caller's OWN permission, always safe to re-check
  -- on every call, replay or not.
  if not private.has_permission(p_business_id, 'staff.invite') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE + VALIDATE INPUT SHAPE ONLY — before the idempotency
  -- claim, so the claim's canonical payload is always built from
  -- already-validated, normalized values.
  v_email := lower(btrim(p_email));
  if v_email is null or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'INVALID_INVITATION_EMAIL' using errcode = '22023';
  end if;

  select id into v_role_id from public.roles where name = p_role;
  if v_role_id is null then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  -- Hierarchy: only an OWNER caller may invite as OWNER. This is the
  -- caller's OWN role, never mutable target state, so it is always safe
  -- to re-check on every call.
  select r.name into v_caller_role
  from public.business_members bm
  join public.roles r on r.id = bm.role_id
  where bm.business_id = p_business_id and bm.user_id = v_uid and bm.status = 'active';

  if p_role = 'OWNER' and v_caller_role <> 'OWNER' then
    raise exception 'CANNOT_ASSIGN_OWNER_ROLE' using errcode = '42501';
  end if;

  -- Codex adversarial review, Finding 3 — LOCKED INVARIANT: every
  -- invitation must carry at least one branch and exactly one primary
  -- among them, mirroring replace_member_branches' own identical
  -- invariant exactly (an accepted invitation becomes a member, and a
  -- member is never allowed to end up with zero branches/zero primary —
  -- see business_member_branches' own header comment). An empty branch
  -- list, or a nonempty one with no (or an out-of-set) primary, is
  -- rejected outright, before the idempotency claim.
  if jsonb_typeof(p_branch_ids) is distinct from 'array' then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) = 0 then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_branch_ids) > v_max_branches then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;
  if p_primary_branch_id is null then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  for v_raw_id in select * from jsonb_array_elements(p_branch_ids)
  loop
    if jsonb_typeof(v_raw_id) is distinct from 'string' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id_text := v_raw_id #>> '{}';
    if v_branch_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_id := v_branch_id_text::uuid;
    if v_branch_id = any(v_branch_ids) then
      raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
    end if;
    v_branch_ids := array_append(v_branch_ids, v_branch_id);
  end loop;

  if p_primary_branch_id is not null and not (p_primary_branch_id = any(v_branch_ids)) then
    raise exception 'INVALID_BRANCH_ASSIGNMENT' using errcode = '22023';
  end if;

  -- CONSTRUCT CANONICAL CALLER INTENT — role_id (not the role name text,
  -- so a future role rename can never falsely conflict with an
  -- already-issued request), the sorted branch id set, and the primary
  -- branch. Never includes expires_at (server-derived, not caller
  -- intent) or status/invited_by (internal/computed).
  select jsonb_agg(to_jsonb(x) order by x) into v_canonical_payload
  from unnest(v_branch_ids) as x;

  v_canonical_payload := jsonb_build_object(
    'email', v_email,
    'role_id', v_role_id::text,
    'branch_ids', coalesce(v_canonical_payload, '[]'::jsonb),
    'primary_branch_id', p_primary_branch_id::text
  );

  -- 4) CLAIM
  insert into private.business_invitation_requests (business_id, creation_key, canonical_payload)
  values (p_business_id, p_creation_key, v_canonical_payload)
  on conflict (business_id, creation_key) do nothing;

  if not found then
    -- 5) REPLAY DECISION — nothing about current invitation/branch state
    -- has been consulted before this point. Explicit column list (never
    -- `select *`), matching the role's own narrowed SELECT grant above.
    select canonical_payload, invitation_id into v_stored_payload, v_stored_invitation_id
    from private.business_invitation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_payload is distinct from v_canonical_payload then
      raise exception 'INVITATION_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_invitation_id;  -- exact replay, unconditionally
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.

  -- Lazily materialize EXPIRED for any stale PENDING invitation blocking
  -- this exact (business, email) pair — no cron: this only ever runs as
  -- a side effect of a real create_business_invitation call, which is
  -- exactly the moment a stale pending invitation would otherwise
  -- incorrectly block a fresh one. accept_business_invitation
  -- independently treats a PENDING-but-expired row as expired too,
  -- regardless of whether this lazy transition has run yet.
  update public.business_invitations
  set status = 'EXPIRED'
  where business_id = p_business_id and email = v_email
    and status = 'PENDING' and expires_at <= now();

  for v_branch_id in select unnest(v_branch_ids)
  loop
    select business_id, status into v_found_business_id, v_status
    from public.business_branches
    where id = v_branch_id and business_id = p_business_id;

    if v_found_business_id is null then
      raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
    end if;
    if v_status <> 'ACTIVE' then
      raise exception 'BRANCH_NOT_ACTIVE' using errcode = '23514';
    end if;
  end loop;

  begin
    -- Server-authoritative expiry — the caller never chooses this.
    insert into public.business_invitations
      (business_id, email, role_id, expires_at, invited_by, creation_key)
    values
      (p_business_id, v_email, v_role_id, now() + interval '7 days', v_uid, p_creation_key)
    returning id into v_invitation_id;
  exception
    when unique_violation then
      raise exception 'INVITATION_ALREADY_PENDING' using errcode = '23505';
  end;

  for v_branch_id in select unnest(v_branch_ids)
  loop
    -- p_primary_branch_id is proven NOT NULL above, so this comparison
    -- is never itself NULL (see replace_member_branches' identical
    -- comment on the equivalent line for the full SQL-NULL reasoning).
    insert into public.business_invitation_branches (business_id, invitation_id, branch_id, is_primary)
    values (p_business_id, v_invitation_id, v_branch_id, v_branch_id = p_primary_branch_id);
  end loop;

  update private.business_invitation_requests set invitation_id = v_invitation_id
  where business_id = p_business_id and creation_key = p_creation_key;

  -- Phase 1J instrumentation: staff.invited — recorded only on this
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's
  -- own pre-existing REPLAY DECISION line, never reaching here). Branch
  -- is the invitation's own primary branch (p_primary_branch_id, already
  -- validated same-tenant + ACTIVE above). Email is used as the resource
  -- label — an accepted, established practice for a staff invitation
  -- specifically (the invitee has no name yet at invite time; email is
  -- the ONLY identity that exists), per this phase's own explicit
  -- allowance ("staff invite email if policy allows"). role_id/
  -- branch_count only in metadata — never the raw branch id array.
  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'staff.invited', 'ORGANIZATION',
    p_primary_branch_id, v_actor_email, null,
    'staff_invitation', v_invitation_id, v_email, 'SUCCESS',
    jsonb_build_object(
      'role', p_role,
      'branch_count', array_length(v_branch_ids, 1)
    )
  );

  return v_invitation_id;
end;
$$;

create or replace function public.create_product(
  p_business_id           uuid,
  p_creation_key          uuid,
  p_name                  text,
  p_sku                   text default null,
  p_barcode               text default null,
  p_description           text default null,
  p_category              text default null,
  p_unit                  text default 'unit',
  p_cost_price            numeric default 0,
  p_selling_price         numeric default 0,
  p_currency_code         text default 'NGN',
  p_track_inventory       boolean default true,
  p_low_stock_threshold   numeric default null,
  p_opening_quantity      numeric default null,
  p_opening_location_id   uuid default null
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                  uuid;
  v_name                 text;
  v_sku                  text;
  v_barcode               text;
  v_description           text;
  v_category              text;
  v_unit                  text;
  v_cost_price            numeric(14,2);
  v_selling_price         numeric(14,2);
  v_currency_code         text;
  v_track_inventory       boolean;
  v_low_stock_threshold   numeric(14,3);
  v_opening_quantity      numeric(14,3);
  v_location_id           uuid;
  v_location_branch_id    uuid;
  v_canonical_payload     jsonb;
  v_opening_movement_key  uuid;
  v_stored_request        private.product_creation_requests;
  v_product               public.products;
  v_constraint            text;
  -- Phase 1J instrumentation local.
  v_actor_email           text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = '28000';
  end if;

  if p_business_id is null or p_creation_key is null then
    raise exception 'p_business_id and p_creation_key are required'
      using errcode = '22023';
  end if;

  -- business_id is validated, never trusted: this is what makes a forged
  -- business_id harmless.
  if not private.has_permission(p_business_id, 'products.manage') then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;

  -- Normalize before both persistence and comparison — every field that
  -- participates in the canonical payload is derived from these
  -- normalized locals, never the raw parameters, so the stored request
  -- and any freshly-computed candidate for a retry are byte-identical
  -- when the caller's intent is identical.
  v_name := btrim(p_name);
  if v_name is null or length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'invalid product name'
      using errcode = '22023';
  end if;

  v_sku := nullif(btrim(p_sku), '');
  v_barcode := nullif(btrim(p_barcode), '');
  v_description := nullif(btrim(p_description), '');
  v_category := nullif(btrim(p_category), '');
  v_unit := coalesce(nullif(btrim(p_unit), ''), 'unit');
  v_cost_price := coalesce(p_cost_price, 0);
  v_selling_price := coalesce(p_selling_price, 0);
  v_currency_code := coalesce(upper(nullif(btrim(p_currency_code), '')), 'NGN');
  v_track_inventory := coalesce(p_track_inventory, true);
  v_low_stock_threshold := p_low_stock_threshold;

  if v_track_inventory and v_sku is null then
    raise exception 'sku is required when track_inventory is true'
      using errcode = '22023';
  end if;

  if p_opening_quantity is not null and p_opening_quantity < 0 then
    raise exception 'opening quantity must not be negative'
      using errcode = '22023';
  end if;

  -- Resolve the opening-stock location (if any) up front, once, BEFORE
  -- the canonical payload is built — this is what makes "explicit
  -- location X" and "omitted, defaulted to X" compare as the identical
  -- request. Dual-permission rule: bundling opening stock additionally
  -- requires inventory.adjust.
  v_location_id := null;
  v_opening_quantity := null;
  if p_opening_quantity is not null and p_opening_quantity > 0 then
    if not private.has_permission(p_business_id, 'inventory.adjust') then
      raise exception 'insufficient_privilege'
        using errcode = '42501';
    end if;
    v_opening_quantity := p_opening_quantity;
    if p_opening_location_id is not null then
      -- An EXPLICIT location is always strict — validated exactly as
      -- before (has_branch_access below), never silently replaced.
      v_location_id := p_opening_location_id;
    else
      -- Codex adversarial review Phase 1G round 2, Medium 2B: an OMITTED
      -- opening location resolves via the AUTHENTICATED CALLER'S OWN
      -- active PRIMARY branch's canonical location — never the legacy,
      -- business-wide default (private.get_default_inventory_location_id,
      -- now unused by this path) — for the identical reason create_sale's
      -- own Medium 2A fix applies to omitted sale branches: a Branch-B-
      -- only staff member bundling opening stock via the current,
      -- unmodified Phase 1F application (which never sends
      -- p_opening_location_id when relying on the default) would otherwise
      -- always resolve to Main Branch's own location, which they may have
      -- no access to at all. has_branch_access is still checked below for
      -- this resolved value exactly like an explicit one — a caller whose
      -- primary branch has since become INACTIVE is correctly denied, not
      -- silently let through.
      select loc.id into v_location_id
      from public.business_members bm
      join public.business_member_branches bmb
        on bmb.member_id = bm.id and bmb.business_id = bm.business_id
      join public.inventory_locations loc
        on loc.branch_id = bmb.branch_id and loc.business_id = bm.business_id
        and loc.is_branch_default = true and loc.status = 'active'
      where bm.business_id = p_business_id
        and bm.user_id = v_uid
        and bm.status = 'active'
        and bmb.is_primary = true;

      if v_location_id is null then
        raise exception 'NO_PRIMARY_BRANCH_ASSIGNED'
          using errcode = '22023';
      end if;
    end if;

    -- Phase 1G: the caller must have operational access to whichever
    -- branch this (explicit or defaulted) location belongs to — see this
    -- migration's own header comment for why this closes the same gap
    -- record_inventory_movement's own new check does. A location that
    -- turns out not to exist/be same-tenant resolves v_location_branch_id
    -- to NULL and is left for apply_inventory_movement's own existing
    -- LOCATION_NOT_FOUND check further below to report, unpre-empted.
    select branch_id into v_location_branch_id
    from public.inventory_locations
    where id = v_location_id and business_id = p_business_id;

    if v_location_branch_id is not null and not private.has_branch_access(p_business_id, v_location_branch_id) then
      raise exception 'insufficient_privilege'
        using errcode = '42501';
    end if;
  end if;

  -- Canonical payload: the ORIGINAL normalized, resolved request — never
  -- the product's later-mutable columns. "No opening stock" has exactly
  -- one representation (the 'opening' key is JSON null) regardless of
  -- whether the caller sent NULL, 0, or omitted the parameter — all three
  -- collapse to v_location_id/v_opening_quantity staying null above.
  -- Numeric fields are typed (numeric(14,2)/numeric(14,3) local
  -- variables) before being embedded, so two textually-different but
  -- numerically-equal inputs (1000 vs 1000.00) always produce the exact
  -- same jsonb value.
  v_canonical_payload := jsonb_build_object(
    'name', v_name,
    'description', v_description,
    'sku', v_sku,
    'barcode', v_barcode,
    'category', v_category,
    'unit', v_unit,
    'cost_price', v_cost_price,
    'selling_price', v_selling_price,
    'currency_code', v_currency_code,
    'track_inventory', v_track_inventory,
    'low_stock_threshold', v_low_stock_threshold,
    'opening', case
      when v_location_id is null then null
      else jsonb_build_object('quantity', v_opening_quantity, 'location_id', v_location_id)
    end
  );

  -- Claim (business_id, creation_key) atomically. This INSERT is the
  -- SOLE arbiter of "who creates this product" — not the products
  -- table's own creation_key uniqueness. Two concurrent callers with the
  -- same key: exactly one INSERT here succeeds; Postgres blocks the
  -- other on the winner's row lock until the winner's transaction
  -- resolves, then re-evaluates the conflict against the final state —
  -- there is no check-then-insert race window.
  v_opening_movement_key := case when v_location_id is not null then gen_random_uuid() else null end;

  insert into private.product_creation_requests (business_id, creation_key, canonical_payload, opening_movement_key)
  values (p_business_id, p_creation_key, v_canonical_payload, v_opening_movement_key)
  on conflict (business_id, creation_key) do nothing;

  if found then
    -- We won the claim: create the product now.
    begin
      insert into public.products (
        business_id, creation_key, name, sku, barcode, description, category, unit,
        cost_price, selling_price, currency_code, track_inventory, low_stock_threshold,
        created_by
      ) values (
        p_business_id, p_creation_key, v_name, v_sku, v_barcode, v_description, v_category, v_unit,
        v_cost_price, v_selling_price, v_currency_code, v_track_inventory, v_low_stock_threshold,
        v_uid
      )
      returning * into v_product;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        -- A genuine SKU/barcode conflict (unrelated to creation_key
        -- racing, which is already fully arbitrated above) — re-raise as
        -- a controlled error. The whole transaction, including the claim
        -- row just inserted, rolls back together, so a future retry
        -- (once the underlying conflict is resolved) can claim cleanly.
        if v_constraint = 'products_sku_unique_idx' then
          raise exception 'SKU_UNAVAILABLE' using errcode = '23505';
        elsif v_constraint = 'products_barcode_unique_idx' then
          raise exception 'BARCODE_UNAVAILABLE' using errcode = '23505';
        end if;
        raise;
    end;

    update private.product_creation_requests
    set product_id = v_product.id
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_location_id is not null then
      -- Uses the internally-generated opening_movement_key, NEVER
      -- creation_key — this is what makes product-creation idempotency
      -- and inventory-movement idempotency fully independent namespaces.
      -- An unrelated manual movement that happens to reuse creation_key's
      -- UUID value has zero effect here, in either direction.
      perform private.apply_inventory_movement(
        p_business_id, v_product.id, v_location_id, 'OPENING_STOCK',
        v_opening_quantity, v_cost_price, 'manual', null,
        'Opening stock', null, v_opening_movement_key, v_uid
      );
    end if;

    -- Phase 1J instrumentation: product.created — recorded only on this
    -- WON-CLAIM path (a lost claim/replay falls through to the "we lost
    -- the claim" branch below, returning early, never reaching here).
    -- Products are not branch-scoped in this schema, so branch_id is
    -- NULL. No cost_price anywhere in the metadata.
    v_actor_email := private.current_verified_email();
    perform private.record_audit_event(
      p_business_id, 'USER', v_uid, 'product.created', 'INVENTORY',
      null, v_actor_email, null,
      'product', v_product.id, v_product.name, 'SUCCESS', '{}'::jsonb
    );

    return v_product;
  end if;

  -- We lost the claim (or it already existed from a prior call): load
  -- the WINNING/ORIGINAL request and compare against it — never against
  -- the product row's current, possibly-since-edited values. This is
  -- what makes a retry of the original request still recognized correctly
  -- even after the product has been renamed/repriced in the meantime.
  select * into v_stored_request
  from private.product_creation_requests
  where business_id = p_business_id and creation_key = p_creation_key;

  if v_stored_request.canonical_payload is distinct from v_canonical_payload then
    raise exception 'PRODUCT_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
  end if;

  if v_stored_request.product_id is null then
    -- The winning transaction claimed the slot but has not yet committed
    -- its product_id update — unreachable in practice (the claiming
    -- INSERT's row lock blocks every other claimant until the winner's
    -- whole transaction, including the product_id UPDATE, has committed
    -- or rolled back; a rollback removes the claim row entirely, so a
    -- committed row with no product_id should never be observable here),
    -- but fails loudly rather than returning a nonsensical result if it
    -- somehow were.
    raise exception 'product creation request has no resolved product'
      using errcode = 'XX000';
  end if;

  select * into v_product from public.products where id = v_stored_request.product_id;
  return v_product;
end;
$$;

-- CREATE OR REPLACE preserves every other function's existing owner and
-- ACL automatically, since none of their signatures changed — matching
-- 20260826090200_extend_inventory_movement_for_sale.sql's own established
-- precedent for apply_inventory_movement's own identical extension
-- pattern ("CREATE OR REPLACE preserves the existing owner... no re-grant
-- needed"). No further ownership/grant statement is required for
-- create_sale_return, create_invoice, record_invoice_payment,
-- create_expense, record_inventory_movement, create_business_branch,
-- deactivate_business_branch, create_business_invitation, or
-- create_product.
