-- Phase 1I: atomic, idempotent, concurrency-safe sale return + refund
-- creation. This is the ONLY path that ever writes to public.sale_returns
-- or public.sale_return_items — no other function, and no direct table
-- grant, does either. Mirrors create_invoice's/create_sale's own proven
-- shape closely: same idempotency-ledger pattern, same
-- input-normalization-before-any-lookup ordering, same
-- server-authoritative snapshot philosophy.
--
-- REPLAY ORDERING (Codex adversarial review lesson from Phase 1H,
-- SEC-01/void_invoice's own precedent applied here deliberately): unlike
-- create_sale's own branch-authorization step (checked BEFORE the
-- idempotency claim, unconditionally, replay or not), this function
-- follows create_invoice's own MORE RECENT, security-audited precedent —
-- the sale's existence, branch, and status are all "referenced resource"
-- state, validated ONLY in the "new claim" section, after the idempotency
-- claim/replay check. An EXACT replay of an already-completed return
-- therefore NEVER re-validates the sale's current branch/status — it
-- simply returns the original sale_return_id, unconditionally, exactly
-- like create_invoice's own identical replay path. The caller's OWN
-- returns.manage permission remains the one thing checked unconditionally
-- on every call, replay or not — that is CALLER STANDING, never
-- "referenced resource" state.
--
-- BRANCH AUTHORITY (Codex security audit, SEC-01, applied proactively —
-- "Phase 1H's security audit already proved branch-level mutation
-- authority matters"): the return's branch is ALWAYS the ORIGINAL sale's
-- own stored branch_id — there is no p_branch_id parameter at all, so
-- there is nothing for a caller to forge. A same-business sale in a
-- branch the caller cannot operationally access is treated IDENTICALLY
-- to a nonexistent one (RETURN_SALE_NOT_FOUND, never a distinguishable
-- error) — mirrors void_invoice's own non-disclosure fix exactly, so a
-- caller enumerating sale ids can never learn "this id exists, just in a
-- branch I can't reach" versus "this id doesn't exist at all".
--
-- RETURN QUANTITY INVARIANT (CRITICAL, per this phase's own product
-- brief): for each sale_item, cumulative returned quantity across every
-- sale_return_items row referencing it must never exceed the sale_item's
-- own sold quantity. Made concurrency-safe by locking the AUTHORITATIVE
-- sale_item row itself (SELECT ... FOR UPDATE) before summing already-
-- returned quantity against it — never a bare SELECT SUM() then INSERT
-- with no lock. A second concurrent return against the SAME sale_item
-- blocks on that lock until the first attempt's transaction commits (or
-- rolls back), then re-reads the ALREADY-COMMITTED sum, so two concurrent
-- returns can never both observe stale "remaining" quantity — the same
-- structural technique record_invoice_payment's own FOR UPDATE invoice
-- lock uses for the identical class of problem (overpayment).
--
-- CUMULATIVE REFUND INVARIANT: protected by the SAME sale-row FOR UPDATE
-- lock taken for branch/status validation — every sale_returns INSERT for
-- a given sale only ever happens after that lock is held, so summing
-- existing refund_amount across sale_returns for this sale, under that
-- lock, is race-safe for the identical reason.
--
-- LOCK ORDER (deadlock safety, per this phase's own product brief): sale
-- row (FOR UPDATE) -> business_branches row (FOR SHARE) -> sale_item rows,
-- in ASCENDING id order (FOR UPDATE) -> products/locations/balances, in
-- apply_inventory_movement's own fixed internal order (FOR SHARE then FOR
-- UPDATE), once per restocked line. Every lock this function ever takes on
-- sale_items is FOR UPDATE, always acquired in the SAME ascending-id order
-- regardless of the caller's own submitted item order — two concurrent
-- returns against overlapping sale_items therefore always request their
-- locks in the same global order, which is what makes a deadlock between
-- them structurally impossible (never merely unlikely). The caller's OWN
-- submitted item order is preserved separately, for `position` assignment
-- only — see the "position" logic below.
--
-- BRANCH LIFECYCLE SERIALIZATION (Codex DB review, SEC-01I — "Branch
-- deactivation lifecycle race", MEDIUM, applied as a targeted remediation
-- to an already-reviewed function): private.has_branch_access is a plain
-- `stable language sql` helper — it performs an ORDINARY, UNLOCKED read of
-- business_branches. Calling it alone, with no lock of our own, let a
-- concurrent deactivate_business_branch — which itself takes a genuine FOR
-- UPDATE lock on that SAME row before flipping status to INACTIVE — leave
-- an open window: this function could observe the still-committed ACTIVE
-- status, race ahead to completion, and commit a brand-new return/refund/
-- restock, all before the deactivation's own transaction ever commits. The
-- fix locks the SALE's own authoritative business_branches row FOR SHARE
-- — immediately after the sale lock, before its status is consulted for
-- anything — which genuinely conflicts with deactivate_business_branch's
-- FOR UPDATE (so a return started while a deactivation is mid-transaction
-- correctly waits for it to resolve, and vice versa) while still allowing
-- unlimited concurrent LEGITIMATE returns against the same branch (FOR
-- SHARE locks never conflict with each other). Deadlock-safe against
-- deactivate_business_branch specifically because that function only ever
-- locks this ONE row, in isolation, in its own transaction — it never also
-- locks a sale or sale_item row, so it can never participate in a lock
-- cycle with this function regardless of where in create_sale_return's own
-- sequence the branch lock sits.

create table private.sale_return_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  sale_return_id    uuid references public.sale_returns (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.sale_return_creation_requests enable row level security;
alter table private.sale_return_creation_requests force row level security;

revoke all on private.sale_return_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_sale_return_writer's table grants as a quick    │
-- │ fix for some other function's privilege problem; give that function  │
-- │ its own dedicated minimal role instead.                              │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_sale_return_writer') then
    create role private_sale_return_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_sale_return_writer to postgres;

grant usage on schema public to private_sale_return_writer;
grant usage on schema private to private_sale_return_writer;

-- sales: SELECT narrowed to exactly what this function reads back from
-- the locked row. UPDATE (updated_at) — Codex security-audit-round
-- precedent (SEC-03, "Branch Deactivation Race" remediation): FOR UPDATE
-- requires UPDATE privilege on at least one column of the locked table;
-- this role NEVER actually issues an UPDATE against public.sales at all
-- (the original sale is never mutated, by design — see this file's own
-- header comment) — the grant exists SOLELY to make the lock acquisition
-- legal, exactly like that same precedent's own customers/business_branches
-- treatment.
grant select (id, business_id, status, branch_id, branch_name_snapshot, amount_paid) on public.sales to private_sale_return_writer;
grant update (updated_at) on public.sales to private_sale_return_writer;

-- sale_items: SELECT narrowed to exactly what this function reads back
-- (including unit_cost_snapshot, deliberately NEVER granted to
-- `authenticated` — see create_sales_and_sale_items.sql's own comment —
-- but safe for this role to read internally, purely to pass through to
-- the restock ledger movement's own unit_cost, never re-exposed via any
-- SELECT this role's own callers can reach). UPDATE (created_at) — the
-- identical FOR UPDATE ACL trick as above; sale_items has no updated_at
-- column at all, so created_at (equally never actually written) is the
-- least-sensitive column available, matching that same precedent's own
-- reasoning for choosing a column with no other role.
grant select (
  id, business_id, sale_id, product_id, product_name_snapshot, sku_snapshot,
  unit_price, quantity, unit_cost_snapshot
) on public.sale_items to private_sale_return_writer;
grant update (created_at) on public.sale_items to private_sale_return_writer;

-- sale_return_items: SELECT narrowed to exactly the two columns the
-- return-quantity-invariant SUM query reads.
grant select (business_id, sale_item_id, quantity) on public.sale_return_items to private_sale_return_writer;

-- sale_returns: SELECT narrowed to exactly the columns the
-- cumulative-refund-invariant SUM query reads, plus `id` — required for
-- this function's own `INSERT ... RETURNING id` (Postgres's RETURNING
-- clause requires SELECT privilege on every column it returns, in
-- addition to INSERT).
grant select (id, business_id, sale_id, refund_amount) on public.sale_returns to private_sale_return_writer;

grant insert on public.sale_returns to private_sale_return_writer;
grant insert on public.sale_return_items to private_sale_return_writer;

-- business_branches: SELECT narrowed to exactly what the SEC-01I branch-
-- lifecycle-serialization check reads (id kept for parity/debuggability,
-- business_id required because it's referenced in the lock query's own
-- WHERE clause). UPDATE (updated_at) — the identical FOR UPDATE/FOR SHARE
-- ACL trick used everywhere else in this file: this role never actually
-- issues an UPDATE against public.business_branches (branch lifecycle
-- mutation belongs solely to deactivate_business_branch/
-- reactivate_business_branch) — the grant exists SOLELY to make FOR SHARE
-- lock acquisition legal, exactly like the Codex security-audit-round
-- SEC-03 precedent's own customers/business_branches treatment.
grant select (id, business_id, status) on public.business_branches to private_sale_return_writer;
grant update (updated_at) on public.business_branches to private_sale_return_writer;

-- inventory_locations: read-only resolution of the sale's own branch
-- canonical/default location — never a caller-selectable destination
-- (per this phase's own product brief: "For MVP simplicity, prefer:
-- branch canonical/default location").
grant select (id, business_id, branch_id, is_branch_default, status) on public.inventory_locations to private_sale_return_writer;

grant select, insert on private.sale_return_creation_requests to private_sale_return_writer;
grant update (sale_return_id) on private.sale_return_creation_requests to private_sale_return_writer;

grant select (business_id, next_number) on private.business_return_sequences to private_sale_return_writer;
grant insert on private.business_return_sequences to private_sale_return_writer;
grant update (next_number) on private.business_return_sequences to private_sale_return_writer;

grant execute on function private.current_uid() to private_sale_return_writer;
grant execute on function private.has_permission(uuid, text) to private_sale_return_writer;
grant execute on function private.has_branch_access(uuid, uuid) to private_sale_return_writer;
-- Cross-role EXECUTE dependency, mirrors private_sale_writer's own
-- identical grant for the 'SALE' movement type exactly — SECURITY
-- DEFINER does not transitively grant EXECUTE on functions a function
-- calls.
grant execute on function private.apply_inventory_movement(
  uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, uuid, uuid
) to private_sale_return_writer;

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
    end if;
  end loop;

  update private.sale_return_creation_requests set sale_return_id = v_sale_return_id
  where business_id = p_business_id and creation_key = p_creation_key;

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
