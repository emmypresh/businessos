-- Phase 1C: atomic, idempotent product creation with optional opening stock.
--
-- This is the ONLY authorized path into public.products for
-- `authenticated` — no INSERT policy/grant exists on that table at all
-- (see create_products.sql).
--
-- ── IDEMPOTENCY REDESIGN ──────────────────────────────────────────────
-- The original design compared a replay against the PRODUCT ROW's current
-- (mutable) values, and — critically — its unique_violation race-recovery
-- path compared only product metadata, never the opening-stock intent.
-- Under real concurrency (two requests, same creation_key, different
-- opening_quantity) the losing request would match on name/sku/price,
-- return "success" with the winner's product, and never have its own
-- opening quantity verified or applied — a silent intent-loss bug.
--
-- Fixed by persisting the ORIGINAL, fully-normalized, fully-resolved
-- request as its own row in `private.product_creation_requests`, and
-- using an INSERT ... ON CONFLICT DO NOTHING against THAT table (not the
-- products table) as the sole concurrency arbiter. Two concurrent callers
-- racing on the same creation_key: exactly one has its INSERT succeed and
-- proceeds to create the product; the other's INSERT is a no-op (Postgres
-- blocks it on the winner's row lock until the winner's transaction
-- commits or rolls back, then resolves the conflict against the
-- now-final state — this is what makes it safe, not a check-then-insert
-- race). The loser then compares against the WINNER's persisted original
-- canonical request — never against the product table's current
-- (possibly since-edited) values — and either returns the same result or
-- is rejected with PRODUCT_IDEMPOTENCY_KEY_REUSED, with no ambiguity.

create table private.product_creation_requests (
  business_id           uuid not null references public.businesses (id) on delete cascade,
  creation_key          uuid not null,
  -- Filled in once the winning claimant actually creates the product, in
  -- the same transaction as the claim — never visible to another
  -- transaction in a half-populated state.
  product_id            uuid references public.products (id) on delete cascade,
  canonical_payload      jsonb not null,
  -- A SEPARATE, internally-generated key for the bundled opening-stock
  -- movement — never the same value as creation_key. This is what closes
  -- the cross-namespace collision: an unrelated manual movement using the
  -- same UUID as some product's creation_key can never coincide with
  -- that product's own opening movement, because the movement never uses
  -- creation_key at all.
  opening_movement_key  uuid,
  created_at            timestamptz not null default now(),

  primary key (business_id, creation_key)
);

-- Never exposed through the Data API: `private` is not in config.toml's
-- api.schemas, so this table is unreachable via PostgREST regardless of
-- GRANTs. RLS is enabled and forced anyway, with zero policies for any
-- client role — mirroring private.password_recovery_grants' own
-- treatment ("a table this sensitive is not something any client role
-- should be able to query or write directly, even filtered by RLS").
-- Access is exclusively through private_product_creator's SECURITY
-- DEFINER/BYPASSRLS context.
alter table private.product_creation_requests enable row level security;
alter table private.product_creation_requests force row level security;

revoke all on private.product_creation_requests from public, anon, authenticated, service_role;

-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ SECURITY REVIEW REQUIRED FOR ANY FUTURE GRANT TO THIS ROLE.          │
-- │ Never extend private_product_creator's table grants as a quick fix   │
-- │ for some other function's privilege problem; give that function its  │
-- │ own dedicated minimal role instead.                                  │
-- └─────────────────────────────────────────────────────────────────────┘
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_product_creator') then
    create role private_product_creator noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_product_creator to postgres;

grant usage on schema public to private_product_creator;
grant usage on schema private to private_product_creator;
grant select, insert on public.products to private_product_creator;
-- Read-only, needed to verify a create_product replay's opening-stock
-- portion against the WINNING request's own persisted intent. Never
-- INSERTed directly by this role for a manual movement — apply_inventory_movement
-- (owned by private_inventory_writer) does that, under its own SECURITY
-- DEFINER context.
grant select on public.inventory_ledger to private_product_creator;
-- The arbiter table itself: INSERT to claim, SELECT to load a
-- conflicting claim's original request, UPDATE to attach product_id once
-- created.
grant select, insert, update on private.product_creation_requests to private_product_creator;

-- Explicit cross-role EXECUTE dependencies.
grant execute on function private.current_uid() to private_product_creator;
grant execute on function private.has_permission(uuid, text) to private_product_creator;

-- Narrowly-scoped default-location resolver, used only when opening stock
-- is requested without an explicit location. Deliberately a single-
-- purpose function rather than a direct SELECT grant on
-- inventory_locations: the latter would let private_product_creator read
-- every column of every location row for any purpose; this can only ever
-- answer "the id of business X's one default active location."
create or replace function private.get_default_inventory_location_id(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.inventory_locations
  where business_id = p_business_id and is_default = true and status = 'active';
$$;

revoke all on function private.get_default_inventory_location_id(uuid) from public;
grant execute on function private.get_default_inventory_location_id(uuid) to private_product_creator;

-- private.apply_inventory_movement is owned by private_inventory_writer
-- (inventory_rpc.sql) — a DIFFERENT role. SECURITY DEFINER on
-- create_product does not transitively grant it EXECUTE there; this is
-- an explicit, required cross-role grant.
grant execute on function private.apply_inventory_movement(
  uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, uuid, uuid
) to private_product_creator;

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
  v_canonical_payload     jsonb;
  v_opening_movement_key  uuid;
  v_stored_request        private.product_creation_requests;
  v_product               public.products;
  v_constraint            text;
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
      v_location_id := p_opening_location_id;
    else
      v_location_id := private.get_default_inventory_location_id(p_business_id);
      if v_location_id is null then
        raise exception 'NO_DEFAULT_LOCATION'
          using errcode = '22023';
      end if;
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

grant create on schema public to private_product_creator;
alter function public.create_product(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
) owner to private_product_creator;
revoke create on schema public from private_product_creator;

-- Explicit, narrow surface: EXECUTE to `authenticated` only (matching
-- public.create_business's own precedent — server-side admin code can
-- already write to products directly if it ever needs to; no
-- service_role grant here).
revoke all on function public.create_product(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
) from public, anon;
grant execute on function public.create_product(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
) to authenticated;
