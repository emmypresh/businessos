-- Phase 1H: atomic, idempotent invoice creation. Mirrors create_sale's
-- own proven shape (20260826090500_create_sale_creation_requests_and_rpc.sql)
-- closely — same idempotency-ledger pattern, same server-authoritative
-- pricing philosophy, same input-normalization-before-any-lookup
-- ordering — adapted for invoices' own simpler creation contract: branch
-- and customer are both REQUIRED, explicit parameters (never omitted,
-- never re-resolved against mutable "current primary branch" state the
-- way create_sale's own omitted-branch compatibility path must), so none
-- of that compatibility-fallback complexity exists here at all.
--
-- Idempotency: the canonical payload preserves the caller's OWN item
-- ORDER (never re-sorted) — unlike create_sale's product-id sort, an
-- invoice's items can include multiple custom (no product_id) lines with
-- no natural sort key, so order-preserving comparison is the simpler,
-- correct choice here; a byte-identical resubmission (including item
-- order) replays, any other difference is a conflicting reuse of the
-- same creation_key.

create table private.invoice_creation_requests (
  business_id       uuid not null references public.businesses (id) on delete cascade,
  creation_key      uuid not null,
  invoice_id        uuid references public.invoices (id) on delete cascade,
  canonical_payload jsonb not null,
  created_at        timestamptz not null default now(),

  primary key (business_id, creation_key)
);

alter table private.invoice_creation_requests enable row level security;
alter table private.invoice_creation_requests force row level security;

revoke all on private.invoice_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_invoice_writer's table grants as a quick fix    │
-- │ for some other function's privilege problem; give that function its  │
-- │ own dedicated minimal role instead.                                  │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_invoice_writer') then
    create role private_invoice_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_invoice_writer to postgres;

grant usage on schema public to private_invoice_writer;
grant usage on schema private to private_invoice_writer;

-- Least-privilege product-lock grant — identical trick to
-- private_sale_writer's own (FOR SHARE requires UPDATE privilege on the
-- table; this role never actually issues an UPDATE against products).
grant select (id, business_id, name, sku, status, selling_price) on public.products to private_invoice_writer;
grant update (creation_key) on public.products to private_invoice_writer;

grant select (id, business_id, status, name, phone, email) on public.customers to private_invoice_writer;
grant select (id, business_id, name, status) on public.business_branches to private_invoice_writer;
-- Codex security audit, SEC-03 ("Branch Deactivation Race"): FOR SHARE
-- (used below to close the customer-archive/branch-deactivation TOCTOU
-- window) requires UPDATE privilege on at least one column of the
-- locked table — identical requirement to the products lock's own
-- `update (creation_key)` grant just above this file's product grants.
-- Neither customers nor business_branches has an analogous unused
-- traceability column, so `updated_at` (trigger-managed, never written
-- by any statement this function issues — it never runs an UPDATE
-- against either table at all) is the least-sensitive column available
-- on each. This grant exists SOLELY to satisfy that ACL check; it is
-- never exercised.
grant update (updated_at) on public.customers to private_invoice_writer;
grant update (updated_at) on public.business_branches to private_invoice_writer;

grant insert on public.invoices to private_invoice_writer;
grant select (id) on public.invoices to private_invoice_writer;
-- The INSERT above writes a temporary total_amount placeholder (see this
-- function's own comment on why); this narrow UPDATE grant is what lets
-- it be overwritten with the real, server-computed total once every line
-- has been priced — never a whole-table UPDATE grant, and never touching
-- customer/branch snapshots, status, or any other column.
grant update (total_amount) on public.invoices to private_invoice_writer;

grant insert on public.invoice_items to private_invoice_writer;

grant select, insert on private.invoice_creation_requests to private_invoice_writer;
grant update (invoice_id) on private.invoice_creation_requests to private_invoice_writer;

grant select (business_id, next_number) on private.business_invoice_sequences to private_invoice_writer;
grant insert on private.business_invoice_sequences to private_invoice_writer;
grant update (next_number) on private.business_invoice_sequences to private_invoice_writer;

grant execute on function private.current_uid() to private_invoice_writer;
grant execute on function private.has_permission(uuid, text) to private_invoice_writer;
grant execute on function private.has_branch_access(uuid, uuid) to private_invoice_writer;

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
