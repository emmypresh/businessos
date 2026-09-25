-- Phase 1Q-0C: invoices gain an authoritative currency_code, derived
-- from the owning business's own base currency (public.businesses.
-- currency_code, Phase 1Q-0A) instead of implicitly assuming NGN
-- everywhere a monetary invoice value is read. Not FX — a business still
-- has exactly one base currency; this migration only gives each invoice
-- an explicit, durable currency IDENTITY of its own (mirroring
-- expenses.currency_code's own historical-snapshot treatment, Phase 1E/
-- 20260923090400_expense_currency_from_business.sql) so invoice totals
-- never need to be re-interpreted through the CURRENT state of a business
-- that may (in a later phase) have more than one historical currency.
--
-- Additive + backfill + tighten, in one migration, matching Phase 1Q-0A's
-- own businesses.country_code/currency_code pattern exactly: nullable
-- column first, backfill every existing row from its owning business,
-- then NOT NULL. Every invoice in this database today belongs to a
-- business whose currency_code is 'NGN' (Phase 1Q-0A backfill), so this
-- backfill sets every existing invoice's currency_code to 'NGN' — no
-- numeric total_amount/amount_paid value is ever touched.

alter table public.invoices
  add column currency_code text;

update public.invoices i
set currency_code = b.currency_code
from public.businesses b
where b.id = i.business_id
  and i.currency_code is null;

alter table public.invoices
  alter column currency_code set not null;

-- Durable invariant: invoices.currency_code must always equal the owning
-- business's own currency_code — mirrors expenses' own
-- enforce_expense_currency_matches_business trigger exactly. UPDATE is
-- not covered: invoices_enforce_immutable_fields
-- (20260831080100_create_invoices_and_invoice_items.sql) does not
-- currently list currency_code, so this migration extends that same
-- trigger function to also lock currency_code against any later change,
-- rather than introducing a second immutable-fields trigger.
create or replace function private.enforce_invoice_immutable_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.business_id <> old.business_id then
    raise exception 'invoices.business_id cannot be changed' using errcode = '23514';
  end if;
  if new.customer_id <> old.customer_id then
    raise exception 'invoices.customer_id cannot be changed' using errcode = '23514';
  end if;
  if new.branch_id <> old.branch_id then
    raise exception 'invoices.branch_id cannot be changed' using errcode = '23514';
  end if;
  if new.invoice_number <> old.invoice_number then
    raise exception 'invoices.invoice_number cannot be changed' using errcode = '23514';
  end if;
  if new.currency_code <> old.currency_code then
    raise exception 'invoices.currency_code cannot be changed' using errcode = '23514';
  end if;
  if new.creation_key <> old.creation_key then
    raise exception 'invoices.creation_key cannot be changed' using errcode = '23514';
  end if;
  if new.created_by <> old.created_by then
    raise exception 'invoices.created_by cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- SECURITY DEFINER (mirroring expenses' own enforce_expense_currency_
-- matches_business): this function must read public.businesses.
-- currency_code regardless of which role performs the INSERT, and
-- private_invoice_writer (the only role that ever inserts into
-- public.invoices) is not otherwise granted SELECT on public.businesses
-- at all.
create or replace function private.enforce_invoice_currency_matches_business()
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
    raise exception 'invoices.business_id does not reference a valid business' using errcode = '23503';
  end if;

  if new.currency_code is distinct from v_business_currency then
    raise exception 'invoices.currency_code must equal the owning business''s currency_code'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_invoice_currency_matches_business() from public;

create trigger invoices_enforce_currency_matches_business
  before insert on public.invoices
  for each row
  execute function private.enforce_invoice_currency_matches_business();

grant select (currency_code) on public.invoices to authenticated, service_role;

-- create_invoice (the sole invoice-creation entry point) now derives
-- currency_code server-side from the owning business, exactly matching
-- create_expense's own Phase 1Q-0C treatment — the client has never had a
-- currency parameter here either, so this changes no part of the
-- function's public contract, only how the stored value is produced.
grant select (id, currency_code) on public.businesses to private_invoice_writer;
grant insert (currency_code) on public.invoices to private_invoice_writer;

create or replace function public.create_invoice(
  p_business_id  uuid,
  p_creation_key uuid,
  p_customer_id  uuid,
  p_branch_id    uuid,
  p_items        jsonb,
  p_due_date     date default null,
  p_notes        text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid;

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
  v_position            int := 0;

  -- New: the owning business's OWN base currency — read once, on a
  -- newly-claimed request only, exactly matching create_expense's own
  -- Phase 1Q-0C treatment.
  v_business_currency   text;

  -- Phase 1J instrumentation local.
  v_actor_email         text;
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

  -- 2) AUTHORIZE
  if not private.has_permission(p_business_id, 'invoices.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- 3) NORMALIZE CALLER REQUEST

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
      v_description := null;
      v_unit_price_wide := null;
    else
      v_product_id := null;
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
      if round(v_unit_price_wide, 2) <> v_unit_price_wide then
        raise exception 'MALFORMED_INVOICE_ITEMS' using errcode = '22023';
      end if;
    end if;

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
    -- 5) REPLAY DECISION
    select * into v_stored_request
    from private.invoice_creation_requests
    where business_id = p_business_id and creation_key = p_creation_key;

    if v_stored_request.canonical_payload is distinct from v_canonical_payload then
      raise exception 'INVOICE_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return v_stored_request.invoice_id;
  end if;

  -- 6) ONLY A NEWLY CLAIMED REQUEST REACHES HERE.
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

  if not private.has_branch_access(p_business_id, p_branch_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- The business's own base currency — Phase 1Q-0C. p_business_id has
  -- already been proven valid by the has_permission check above.
  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

  insert into private.business_invoice_sequences (business_id, next_number)
  values (p_business_id, 2)
  on conflict (business_id) do update set next_number = private.business_invoice_sequences.next_number + 1
  returning next_number - 1 into v_seq_number;
  v_invoice_number := 'INV-' || lpad(v_seq_number::text, greatest(6, length(v_seq_number::text)), '0');

  insert into public.invoices (
    business_id, invoice_number, customer_id,
    customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot,
    branch_id, branch_name_snapshot,
    due_date, notes, total_amount, currency_code, creation_key, created_by
  ) values (
    p_business_id, v_invoice_number, p_customer_id,
    v_customer_name, v_customer_phone, v_customer_email,
    p_branch_id, v_branch_name,
    p_due_date, v_notes, 0.01, v_business_currency, p_creation_key, v_uid
  )
  returning id into v_invoice_id;

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
      v_description := v_product_name;
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
