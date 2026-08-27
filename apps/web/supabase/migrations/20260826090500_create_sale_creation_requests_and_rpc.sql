-- Phase 1D: atomic, idempotent, single-shot completed-sale creation.
--
-- public.create_sale is the ONLY Phase 1D sale-mutation entry point. It
-- creates a COMPLETED sale in exactly one transaction — validating the
-- caller, the customer (if any), every product line, deducting stock
-- through the existing private.apply_inventory_movement primitive, and
-- computing totals — or nothing commits at all. There is no
-- complete_sale, no cancel_sale, and no code path that ever leaves a
-- committed DRAFT row; the status/payment_status CHECK domains stay
-- structurally open for a future phase, but Phase 1D never exercises the
-- other values.
--
-- Idempotency follows private.product_creation_requests' proven design
-- exactly: the arbiter is a dedicated request-ledger row's
-- INSERT ... ON CONFLICT DO NOTHING, and a replay of an already-committed
-- request returns the STORED result immediately, with NO revalidation of
-- customer/product/location current state whatsoever — only a NEWLY
-- claimed request proceeds to that validation. This is deliberate: a
-- customer archived, a product renamed/repriced/archived, or the
-- business's default location changed, all AFTER the original sale
-- committed, must never cause an exact replay of that sale to fail or
-- diverge.

create table private.sale_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  sale_id           uuid references public.sales (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.sale_creation_requests enable row level security;
alter table private.sale_creation_requests force row level security;

revoke all on private.sale_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_sale_writer's table grants as a quick fix for   │
-- │ some other function's privilege problem; give that function its own  │
-- │ dedicated minimal role instead.                                      │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_sale_writer') then
    create role private_sale_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_sale_writer to postgres;

grant usage on schema public to private_sale_writer;
grant usage on schema private to private_sale_writer;

-- Least-privilege product-lock grant: SELECT for the read, and UPDATE on
-- exactly ONE column — creation_key — never a whole-table UPDATE grant.
-- Postgres's FOR SHARE row-locking clause requires UPDATE privilege on
-- the table, which a column-level grant satisfies; this role never
-- actually issues an UPDATE statement against products at all.
-- creation_key (not id) is used specifically because it is already
-- proven database-immutable by Phase 1C's own
-- private.enforce_product_immutable_fields trigger (create_products.sql)
-- — a stronger, pre-existing guarantee than merely "this happens to be
-- the primary key."
-- Least-privilege pass (defense-in-depth for a BYPASSRLS role): SELECT
-- narrowed to exactly the columns the function body actually reads
-- (name, sku, status, track_inventory, selling_price, cost_price — plus
-- id/business_id, which the WHERE clause itself references and which
-- therefore also require SELECT privilege, not just the columns named in
-- the SELECT list). No exploit was found via this broader grant, but a
-- BYPASSRLS role's privileges should equal what its fixed function body
-- needs, not more, on principle.
grant select (
  id, business_id, name, sku, status, track_inventory, selling_price, cost_price
) on public.products to private_sale_writer;
grant update (creation_key) on public.products to private_sale_writer;

-- Columns actually read: the WHERE clause needs id/business_id; the
-- SELECT list needs status, name, phone, email, address (the customer
-- snapshot fields) — nothing else (notes, created_by, timestamps are
-- never read by this function).
grant select (
  id, business_id, status, name, phone, email, address
) on public.customers to private_sale_writer;
-- inventory_locations carries no sensitive data — `authenticated` itself
-- already has an unrestricted whole-table SELECT grant on it (see
-- create_inventory_locations.sql); granting the identical access here
-- introduces no new disclosure. Left as a whole-table grant: not named
-- among the tables this hardening pass narrows, and every column this
-- function reads from it (id, name, business_id, is_default, status) is
-- already part of that same public, unrestricted grant.
grant select on public.inventory_locations to private_sale_writer;

-- The sales INSERT's RETURNING id, and the later finalize-UPDATE's own
-- WHERE id = ... clause, are the ONLY places this function ever reads
-- from sales — narrowed to exactly that one column, not the whole table.
grant insert on public.sales to private_sale_writer;
grant select (id) on public.sales to private_sale_writer;
-- create_sale inserts a sale row, then finalizes it in place once totals
-- and stock deduction succeed — UPDATE is narrowed to exactly the nine
-- columns that finalization step writes, never a whole-table UPDATE
-- grant (correction 2). Every other column (id, business_id, customer_id
-- and its snapshots, inventory_location_id and its snapshot, sale_number,
-- creation_key, created_by, created_at, cancelled_at) is set once at
-- INSERT and never touched again by this function.
grant update (
  subtotal, discount, total, payment_status, payment_method,
  amount_paid, notes, status, completed_at
) on public.sales to private_sale_writer;
-- create_sale only ever INSERTs sale_items and never reads them back (no
-- RETURNING clause on that INSERT, no subsequent SELECT anywhere in the
-- function) — SELECT is not granted on this table AT ALL, not even
-- narrowed to a single column.
grant insert on public.sale_items to private_sale_writer;

-- The arbiter table: SELECT to load a conflicting/matching claim's
-- original request, INSERT to claim, UPDATE narrowed to the one column
-- ever written after the initial claim.
grant select, insert on private.sale_creation_requests to private_sale_writer;
grant update (sale_id) on private.sale_creation_requests to private_sale_writer;

-- The counter table: INSERT for the first-ever claim on a business,
-- UPDATE narrowed to next_number for every subsequent claim. SELECT is
-- narrowed to exactly (business_id, next_number) — required by
-- ON CONFLICT (business_id) DO UPDATE itself (Postgres must be able to
-- read the conflict-target column to detect the conflict) and by the
-- DO UPDATE SET next_number = next_number + 1 expression, which reads
-- the pre-update value — not a general "browse this table" grant; there
-- is no plain, unconditional SELECT statement against this table
-- anywhere in create_sale.
grant select (business_id, next_number) on private.business_sale_sequences to private_sale_writer;
grant insert on private.business_sale_sequences to private_sale_writer;
grant update (next_number) on private.business_sale_sequences to private_sale_writer;

-- Explicit cross-role EXECUTE dependencies.
grant execute on function private.current_uid() to private_sale_writer;
grant execute on function private.has_permission(uuid, text) to private_sale_writer;
-- private.apply_inventory_movement is owned by private_inventory_writer
-- (inventory_rpc.sql) — a DIFFERENT role. SECURITY DEFINER does not
-- transitively grant EXECUTE there; this is an explicit, required
-- cross-role grant, identical in kind to private_product_creator's own.
grant execute on function private.apply_inventory_movement(
  uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, uuid, uuid
) to private_sale_writer;

create or replace function public.create_sale(
  p_business_id    uuid,
  p_creation_key   uuid,
  p_items          jsonb,
  p_customer_id    uuid default null,
  p_discount       numeric default 0,
  p_payment_status text default 'UNPAID',
  p_payment_method text default null,
  p_amount_paid    numeric default 0,
  p_notes          text default null
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
    -- original unconstrained value (confirmed live for every required
    -- example: 1, 1.0, 1.2, 1.23, 1.234, 0.001, 999.999 all compare
    -- equal; 1.2345, 0.0001, 1.2349, 999.9999 all compare unequal) is
    -- what makes this a genuine round-trip proof rather than textual
    -- decimal-place counting, which would need to separately handle
    -- trailing zeros, exponent notation, and locale quirks.
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
  -- comparison).
  v_canonical_payload := jsonb_build_object(
    'customer_id', p_customer_id,
    'items', v_norm_items_sorted,
    'discount', v_discount::text,
    'payment_status', v_payment_status,
    'payment_method', v_payment_method,
    'amount_paid', v_canonical_amount_paid::text,
    'notes', v_notes
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

  select id, name into v_location_id, v_location_name
  from public.inventory_locations
  where business_id = p_business_id and is_default = true and status = 'active';

  if v_location_id is null then
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
    sale_number, creation_key, created_by
  ) values (
    p_business_id, p_customer_id,
    v_customer_name, v_customer_phone, v_customer_email, v_customer_address,
    v_location_id, v_location_name,
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

grant create on schema public to private_sale_writer;
alter function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text)
  owner to private_sale_writer;
revoke create on schema public from private_sale_writer;

-- Explicit, narrow surface: EXECUTE to `authenticated` only. No
-- `service_role` grant — matching create_product/record_inventory_movement's
-- own precedent.
revoke all on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text)
  from public, anon, service_role;
grant execute on function public.create_sale(uuid, uuid, jsonb, uuid, numeric, text, text, numeric, text)
  to authenticated;
