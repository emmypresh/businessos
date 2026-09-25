-- Phase 1Q-0C Slice 3: products.currency_code stops being a client-
-- influenceable, hardcoded-'NGN'-defaulted value and instead durably
-- tracks the OWNING BUSINESS's own base currency (public.businesses.
-- currency_code, Phase 1Q-0A) — mirroring expenses/invoices/sales'
-- own Slice 1/2 treatment (20260923090400/0500/0600) exactly.
--
-- This closes the one real currency-spoofing surface the Slice 3
-- hardcode sweep found: create_product accepted a client-supplied
-- p_currency_code parameter (defaulting to 'NGN') with no check at all
-- against the product's owning business — a caller could create a
-- product in any currency regardless of its business's actual
-- currency_code. No FX and no numeric conversion is introduced here —
-- every existing product row is already 'NGN' (Phase 1Q-0A backfill,
-- itself already correct for every NG business today), so this is a
-- no-op for current data.

-- 1) Drop the NGN-only default. The column's shape (NOT NULL, 3-letter
-- CHECK) is unchanged — only "defaults to 'NGN' when unspecified" goes
-- away, since the RPC below now always supplies an explicit,
-- business-derived value.
alter table public.products
  alter column currency_code drop default;

-- 2) Durable DB-level invariant, independent of RLS/GRANTs and of
-- create_product itself: products.currency_code must always equal the
-- owning business's own currency_code, for both INSERT and UPDATE (the
-- latter because, unlike expenses.currency_code, products.currency_code
-- IS UPDATE-grantable to `authenticated` today — see step 3, which
-- closes that surface too, but this trigger is the belt-and-suspenders
-- backstop that holds even for a direct/service-role write).
create or replace function private.enforce_product_currency_matches_business()
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
    raise exception 'products.business_id does not reference a valid business' using errcode = '23503';
  end if;

  if new.currency_code is distinct from v_business_currency then
    raise exception 'PRODUCT_CURRENCY_MISMATCH: products.currency_code must equal the owning business''s currency_code'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_product_currency_matches_business() from public;

create trigger products_enforce_currency_matches_business
  before insert or update of currency_code, business_id on public.products
  for each row
  execute function private.enforce_product_currency_matches_business();

-- 3) Close the client-facing UPDATE surface too: no product edit flow
-- (lib/validation/products.ts's UpdateProductSchema, lib/products/
-- actions.ts's updateProduct) ever touches currency_code, so
-- `authenticated` never legitimately needs to UPDATE this column
-- directly — removing the grant removes the surface, not just a form
-- field, per the phase brief's "do not rely solely on forms" rule. The
-- trigger above remains as the backstop for any other writer.
revoke update (currency_code) on public.products from authenticated;

-- 4) create_product itself now derives currency_code from the owning
-- business, exactly like create_expense already does — never trusting
-- p_currency_code as the source of truth. The parameter is KEPT (default
-- null, not 'NGN') purely so an explicit, wrong value is rejected with a
-- clear error rather than silently coerced — silent coercion would let a
-- caller believe it set USD when the stored row is actually NGN, which
-- is worse than an explicit failure. Omitting the parameter entirely
-- (every real call site, since no product form field exists) always
-- resolves to the business's own currency, with no possible mismatch.
grant select (id, currency_code) on public.businesses to private_product_creator;

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
  p_currency_code         text default null,
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
  v_business_currency    text;
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

  -- The owning business's OWN base currency — the sole authority for
  -- this product's currency_code. p_business_id has already been proven
  -- valid by the has_permission check above (a nonexistent business can
  -- never hold a permission grant), so a null result here would indicate
  -- a genuine data-integrity fault, not a reachable caller-input error.
  select currency_code into v_business_currency
  from public.businesses
  where id = p_business_id;

  -- p_currency_code is never trusted as the value to STORE — only ever
  -- compared against the business's own currency, and rejected (never
  -- silently corrected) on a mismatch. This is what closes the
  -- currency-spoofing surface: a caller cannot create a USD product
  -- under an NGN business by simply passing p_currency_code := 'USD'.
  if p_currency_code is not null
     and upper(btrim(p_currency_code)) <> v_business_currency then
    raise exception 'PRODUCT_CURRENCY_MISMATCH'
      using errcode = '23514';
  end if;
  v_currency_code := v_business_currency;

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
