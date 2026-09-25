-- Phase 1Q-0C Slice 2: sales.currency_code stops being a hardcoded 'NGN'
-- default and instead durably tracks the OWNING BUSINESS's own base
-- currency (public.businesses.currency_code, Phase 1Q-0A) — mirroring
-- expenses'/invoices' own identical Phase 1Q-0C treatment
-- (20260923090400_expense_currency_from_business.sql,
-- 20260923090500_invoice_currency_from_business.sql) exactly. Not FX — a
-- business still has exactly one base currency; this only removes the
-- Phase 1D-era Nigeria-only default so a non-Nigerian business's sales can
-- validly carry that business's own currency instead of being
-- structurally forced into NGN.
--
-- Existing rows are untouched: every business in this database today has
-- currency_code = 'NGN' (Phase 1Q-0A backfill), and every existing sale
-- already has currency_code = 'NGN' (the dropped default), so this is a
-- no-op for current data — no numeric value or currency identity on any
-- existing row changes.
--
-- create_sale's CURRENT live signature is the Phase 1G ten-parameter one
-- (…, p_branch_id uuid default null), from
-- 20260829080100_branch_aware_sales.sql — NOT the original Phase 1D
-- nine-parameter one. CREATE OR REPLACE FUNCTION only replaces a function
-- whose argument-TYPE list is unchanged; recreating the old nine-parameter
-- signature here would coexist as a SECOND overload and break PostgREST's
-- function resolution (confirmed empirically), so this migration
-- reproduces that exact ten-parameter body — including the Phase 1J
-- sale.created audit-instrumentation call added by
-- 20260902100000_instrument_core_audit_events.sql, which this migration is
-- layered on top of — unchanged apart from the currency derivation itself.

-- 1) Drop the old NGN-only literal default. The column itself, its NOT
-- NULL constraint, and its `currency_code ~ '^[A-Z]{3}$'` shape check stay
-- exactly as they were — only the "defaults to the literal 'NGN'" behavior
-- is removed, replaced below by a stronger, business-derived rule.
alter table public.sales
  alter column currency_code drop default;

-- 2) Durable invariant: sales.currency_code must always equal the owning
-- business's own currency_code. Enforced as a BEFORE INSERT trigger
-- (independent of RLS/GRANTs, so it holds for every writer, not just
-- create_sale) — there is no UPDATE grant on sales.currency_code for ANY
-- role (private_sale_writer's own UPDATE grant, narrowed to
-- subtotal/discount/total/payment_status/payment_method/amount_paid/
-- notes/status/completed_at, has never included currency_code), so a
-- currency mismatch could only ever be introduced at INSERT time.
--
-- SECURITY DEFINER (mirroring enforce_expense_currency_matches_business/
-- enforce_invoice_currency_matches_business exactly): this function must
-- read public.businesses.currency_code regardless of which role performs
-- the INSERT, and private_sale_writer (the only role that ever inserts
-- into public.sales) is not otherwise granted SELECT on public.businesses
-- at all.
create or replace function private.enforce_sale_currency_matches_business()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_business_currency text;
begin
  select currency_code into v_business_currency
  from public.businesses
  where id = new.business_id;

  if v_business_currency is null then
    raise exception 'sales.business_id does not reference a valid business' using errcode = '23503';
  end if;

  if new.currency_code is distinct from v_business_currency then
    raise exception 'sales.currency_code must equal the owning business''s currency_code'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_sale_currency_matches_business() from public;

create trigger sales_enforce_currency_matches_business
  before insert on public.sales
  for each row
  execute function private.enforce_sale_currency_matches_business();

-- 3) create_sale (the sole sale-creation entry point) now derives
-- currency_code server-side from the owning business, instead of relying
-- on a column default — the client has never had a currency parameter
-- here either, so this changes no part of the function's public contract,
-- only how the stored value is produced.
grant select (id, currency_code) on public.businesses to private_sale_writer;
grant insert (currency_code) on public.sales to private_sale_writer;

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
  p_branch_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                  uuid;

  v_raw_item              jsonb;
  v_product_id_text       text;
  v_product_id            uuid;
  v_quantity_wide         numeric;
  v_quantity              numeric(14,3);
  v_seen_products         uuid[] := array[]::uuid[];
  v_norm_items            jsonb := '[]'::jsonb;
  v_norm_items_sorted     jsonb;
  v_max_items             constant int := 100;
  v_max_money             constant numeric := 999999999999.99;

  v_discount              numeric;
  v_payment_status        text;
  v_payment_method        text;
  v_canonical_amount_paid numeric;
  v_notes                 text;

  v_branch_id             uuid;
  v_branch_name           text;
  v_canonical_branch_id   uuid;

  v_canonical_payload     jsonb;
  v_stored_request        private.sale_creation_requests;
  v_sale_id                uuid;

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
  v_unit_price                             numeric(14,2);
  v_line_total_wide                         numeric;
  v_subtotal                                 numeric := 0;
  v_total                                     numeric;
  v_final_amount_paid                          numeric;

  -- New: the owning business's OWN base currency — read once, on a
  -- newly-claimed request only, exactly matching create_expense's/
  -- create_invoice's own Phase 1Q-0C treatment.
  v_business_currency                          text;

  -- Phase 1J instrumentation local (20260902100000_instrument_core_audit_events.sql).
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

  -- 2) AUTHORIZE
  if not private.has_permission(p_business_id, 'sales.create') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 2b) RESOLVE + AUTHORIZE THE BRANCH
  if p_branch_id is not null then
    v_branch_id := p_branch_id;
  else
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
    raise exception 'BRANCH_NOT_FOUND' using errcode = '22023';
  end if;

  if not private.has_branch_access(p_business_id, v_branch_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 2c) CANONICAL BRANCH IDENTITY for the idempotency payload
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

  -- 3) NORMALIZE CALLER REQUEST
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

    if jsonb_typeof(v_raw_item->'product_id') is distinct from 'string' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_product_id_text := v_raw_item->>'product_id';
    if v_product_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_product_id := v_product_id_text::uuid;

    if jsonb_typeof(v_raw_item->'quantity') is distinct from 'number' then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_quantity_wide := (v_raw_item->'quantity')::text::numeric;
    if v_quantity_wide <= 0 or v_quantity_wide > 1000000 then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;
    v_quantity := v_quantity_wide::numeric(14,3);
    if v_quantity <> v_quantity_wide then
      raise exception 'MALFORMED_SALE_ITEMS' using errcode = '22023';
    end if;

    if v_product_id = any(v_seen_products) then
      raise exception 'DUPLICATE_PRODUCT_LINE' using errcode = '22023';
    end if;
    v_seen_products := array_append(v_seen_products, v_product_id);

    v_norm_items := v_norm_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id::text,
      'quantity', v_quantity::text
    ));
  end loop;

  select jsonb_agg(elem order by (elem->>'product_id')::uuid)
  into v_norm_items_sorted
  from jsonb_array_elements(v_norm_items) elem;

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

  if v_payment_status = 'UNPAID' then
    if v_payment_method is not null then
      raise exception 'INVALID_PAYMENT_AMOUNT' using errcode = '22023';
    end if;
    v_canonical_amount_paid := 0;
  elsif v_payment_status = 'PAID' then
    v_canonical_amount_paid := null;
  else -- PARTIALLY_PAID
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
    -- 6) REPLAY DECISION
    select * into v_stored_request
    from private.sale_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'SALE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.sale_id;
  end if;

  -- 7) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.

  if p_customer_id is not null then
    select status, name, phone, email, address
    into v_customer_status, v_customer_name, v_customer_phone, v_customer_email, v_customer_address
    from public.customers
    where id = p_customer_id and business_id = p_business_id;

    if not found then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';
    end if;
    if v_customer_status = 'archived' then
      raise exception 'CUSTOMER_ARCHIVED' using errcode = '23514';
    end if;
  end if;

  select id, name into v_location_id, v_location_name
  from public.inventory_locations
  where business_id = p_business_id and branch_id = v_canonical_branch_id
    and is_branch_default = true and status = 'active';

  if v_location_id is null then
    raise exception 'NO_DEFAULT_LOCATION' using errcode = '22023';
  end if;

  -- The business's own base currency — Phase 1Q-0C. p_business_id has
  -- already been proven valid by the has_permission check above.
  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

  insert into private.business_sale_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_sale_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_sale_number := 'SALE-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.sales (
    business_id, customer_id,
    customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot,
    inventory_location_id, inventory_location_name_snapshot,
    branch_id, branch_name_snapshot,
    sale_number, currency_code, creation_key, created_by
  ) values (
    p_business_id, p_customer_id,
    v_customer_name, v_customer_phone, v_customer_email, v_customer_address,
    v_location_id, v_location_name,
    v_canonical_branch_id, v_branch_name,
    v_sale_number, v_business_currency, p_creation_key, v_uid
  )
  returning id into v_sale_id;

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

    v_quantity := (v_item.value->>'quantity')::numeric(14,3);

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
      perform private.apply_inventory_movement(
        p_business_id, (v_item.value->>'product_id')::uuid, v_location_id, 'SALE',
        v_quantity, v_product_cost, 'sale', v_sale_id,
        'Sale ' || v_sale_number, null, gen_random_uuid(), v_uid
      );
    end if;
  end loop;

  if v_subtotal > v_max_money then
    raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  if v_discount > v_subtotal then
    raise exception 'INVALID_DISCOUNT' using errcode = '22023';
  end if;
  v_total := v_subtotal - v_discount;
  if v_total > v_max_money or v_total < 0 then
    raise exception 'SALE_AMOUNT_OUT_OF_RANGE' using errcode = '22023';
  end if;

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
  -- NEW-CLAIM path (an exact replay returns earlier, at this function's own
  -- REPLAY DECISION line, never reaching here). No product cost anywhere
  -- in the metadata — item_count and money totals only.
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

-- No ownership/grant changes needed here: CREATE OR REPLACE FUNCTION on an
-- existing function (same ten-parameter signature as the live
-- branch-aware version) preserves its current owner (already
-- private_sale_writer, set by 20260829080100_branch_aware_sales.sql) and
-- its existing EXECUTE grants unchanged.
