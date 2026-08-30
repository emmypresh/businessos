-- Phase 1G: branch-aware inventory movements.
--
-- Deliberately NO new branch_id column on public.inventory_ledger — the
-- previous migration made every inventory_locations row belong to exactly
-- one branch (NOT NULL, tenant-consistent FK), so a ledger row's branch is
-- always safely and authoritatively derivable via a join through its own
-- inventory_location_id: `inventory_ledger il join inventory_locations loc
-- on loc.id = il.inventory_location_id -> loc.branch_id`. Duplicating that
-- onto the ledger itself would be redundant data with no independent
-- authority — the location IS the authority — and would introduce a
-- second place the two could silently drift apart. Branch-filtered
-- inventory reads (a later application-layer concern) join through this
-- exact path.
--
-- Both public.record_inventory_movement and public.create_product's
-- bundled-opening-stock path keep their EXACT existing names, parameters,
-- and parameter order — CREATE OR REPLACE changes only their bodies, never
-- their signatures, so no backward-compatibility concern exists for either
-- (the current Phase 1F application's calls to both are entirely
-- unaffected in shape). private.apply_inventory_movement itself is NOT
-- touched — it has never checked permissions or branch access on its own
-- (by design: "different callers need different permission keys; that
-- stays with each public entry point" — inventory_rpc.sql's own header
-- comment), and that division of labor is exactly why this migration only
-- has to touch the two PUBLIC entry points that accept a caller-influenced
-- location, not the shared primitive underneath them.

-- record_inventory_movement -------------------------------------------------
--
-- New requirement: inventory.adjust AND access to the branch that OWNS the
-- target inventory location (never the caller's own claimed branch — the
-- location's real, current branch_id is the only source of truth, read
-- fresh on every call), WITH one narrow, explicitly-scoped transitional
-- exception for the current Phase 1F application's own legacy calling
-- contract — see Medium 2C's own comment inside the function body below.
--
-- Codex adversarial review Phase 1G round 2, Low 1: Phase 1C's own
-- original grant (inventory_rpc.sql's "grant select, update on public.
-- inventory_locations to private_inventory_writer") was a WHOLE-TABLE
-- grant for BOTH privileges — safe under Phase 1C's own schema (this
-- table had no sensitive/writable metadata at all), but automatically and
-- silently covers the branch_id/is_branch_default columns the previous
-- migration just added too. No reachable authenticated bypass exists
-- through this role (it is NOLOGIN/BYPASSRLS, reachable only via this
-- schema's own SECURITY DEFINER functions, none of which ever issues a
-- real UPDATE against this table), but it violates least privilege on
-- principle. Revoked and re-granted narrowly here: EXACTLY the six
-- columns private.apply_inventory_movement's own FOR SHARE query and this
-- function's own new logic actually read (id/business_id as WHERE-clause
-- predicates throughout; status for apply_inventory_movement's own check;
-- branch_id/is_default/is_branch_default for the branch-access and
-- Medium 2C legacy-compatibility checks below), and UPDATE on exactly ONE
-- immutable identifier column (id) — narrowed purely to satisfy
-- Postgres's own documented requirement that FOR SHARE/FOR UPDATE needs
-- UPDATE privilege on at least one column of the locked table, never
-- because this role's approved function bodies ever actually issue a real
-- UPDATE against inventory_locations (they don't, and never have).
-- branch_id and is_branch_default are deliberately EXCLUDED from the
-- UPDATE grant — this role must never be able to move a location between
-- branches or change which one is canonical, even though it can now READ
-- both.
revoke select, update on public.inventory_locations from private_inventory_writer;
grant select (id, business_id, status, branch_id, is_default, is_branch_default)
  on public.inventory_locations to private_inventory_writer;
grant update (id) on public.inventory_locations to private_inventory_writer;

grant execute on function private.has_branch_access(uuid, uuid) to private_inventory_writer;

-- Codex adversarial review Phase 1G round 2, Medium 2C: the legacy
-- compatibility alias (below) needs to resolve the caller's own active
-- primary branch and that branch's canonical location — narrow reads on
-- business_members/business_member_branches are required for that lookup,
-- exactly mirroring create_sale's own identical Medium 2A grant.
grant select (id, business_id, user_id, status) on public.business_members to private_inventory_writer;
grant select (member_id, business_id, branch_id, is_primary) on public.business_member_branches to private_inventory_writer;

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

  return private.apply_inventory_movement(
    p_business_id, p_product_id, v_effective_location_id, p_movement_type,
    p_quantity, p_unit_cost, p_reference_type, p_reference_id,
    p_reason, p_note, p_idempotency_key, v_uid
  );
end;
$$;

-- create_product's bundled opening-stock path --------------------------
--
-- Closes the identical gap for the OTHER caller-facing path that can
-- bundle an OPENING_STOCK movement into an explicit, caller-chosen
-- location (p_opening_location_id) — without this, a caller holding
-- products.manage + inventory.adjust but no access to Branch B's location
-- could inject opening stock there merely by naming that location's id
-- directly to create_product, entirely bypassing record_inventory_movement's
-- own new guard above. When opening stock is instead defaulted (no
-- p_opening_location_id given), it resolves via the UNCHANGED
-- private.get_default_inventory_location_id (the business-wide default
-- location, Phase 1C's own long-standing behavior — deliberately not
-- reinterpreted per branch, see the previous migration's own header
-- comment for why) — that business-wide default location's branch is
-- still checked here exactly the same way, so a caller lacking access to
-- whichever branch currently owns the business default is correctly
-- denied too, not silently exempted merely because they didn't name a
-- location explicitly.
grant execute on function private.has_branch_access(uuid, uuid) to private_product_creator;

-- Codex adversarial review Phase 1G round 2, Medium 2B: an OMITTED
-- opening location resolves via the caller's own active primary branch's
-- canonical location — narrow reads on business_members/
-- business_member_branches are required for that lookup, exactly
-- mirroring create_sale's own identical Medium 2A grant.
grant select (id, business_id, user_id, status) on public.business_members to private_product_creator;
grant select (member_id, business_id, branch_id, is_primary) on public.business_member_branches to private_product_creator;

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

-- CREATE OR REPLACE preserves both functions' existing owners
-- (private_inventory_writer, private_product_creator respectively) — same
-- signatures throughout, no DROP needed, unlike create_sale's/
-- create_expense's/get_financial_summary's own appended-parameter cases.
--
-- Codex adversarial review Phase 1G round 2 (ACL environment
-- micro-review): CREATE OR REPLACE preserves whatever EXECUTE ACL a
-- function already has, and these two functions' own original Phase 1C
-- grant statements (inventory_rpc.sql / create_product_rpc.sql) only ever
-- named `public, anon` in their REVOKE — never `service_role` explicitly,
-- unlike every later Phase 1D+ function. Whether service_role therefore
-- ends up with EXECUTE on a freshly-bootstrapped local database is
-- entirely a function of that environment's own Supabase CLI/Postgres
-- bootstrap defaults (confirmed to differ between CLI 2.115.0 and 2.116.0
-- in this project's own local testing) — a fact this repository's
-- migrations must never depend on for a security-sensitive grant. The
-- statements below make the EXECUTE ACL for both functions fully
-- self-determining: an explicit REVOKE of all three non-intended
-- grantees, unconditionally, followed by an explicit GRANT to the one
-- intended caller — idempotent regardless of whatever ACL state existed
-- immediately beforehand (already-denied or already-granted both converge
-- on the identical result), and with zero dependency on
-- auto_expose_new_tables, pg_default_acl, or any other bootstrap-time
-- default. This does not change the intended contract (authenticated-only,
-- exactly as both functions' own original Phase 1C comments already
-- documented as the goal) — it only makes that contract explicit and
-- self-enforcing rather than incidentally inherited.
revoke execute on function public.record_inventory_movement(
  uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
) from public, anon, service_role;
grant execute on function public.record_inventory_movement(
  uuid, uuid, uuid, text, numeric, uuid, numeric, text, text, text, uuid
) to authenticated;

revoke execute on function public.create_product(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
) from public, anon, service_role;
grant execute on function public.create_product(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, text, boolean, numeric, numeric, uuid
) to authenticated;

-- No other re-grant/ownership-transfer statement is needed beyond the
-- narrow grant additions already made above (has_branch_access EXECUTE
-- for both roles; the narrowed inventory_locations SELECT/UPDATE and the
-- new business_members/business_member_branches SELECT for
-- private_inventory_writer; the extended inventory_locations SELECT and
-- new business_members/business_member_branches SELECT for
-- private_product_creator) plus the EXECUTE normalization immediately
-- above.
