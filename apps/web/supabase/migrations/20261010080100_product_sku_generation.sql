-- Phase 1Q-B, part 2 — SKU normalization, generation helpers, and the
-- extension of the frozen public.create_product to auto-generate a SKU
-- server-side when the caller omits one, per the business's own
-- sku_mode (business_sku_settings, previous migration).
--
-- Reproduces public.create_product's CURRENT body — as last redefined by
-- 20260924080000_product_currency_from_business.sql (the currency-
-- derivation round, NOT the earlier 20260902100000 audit-instrumentation
-- version — verified by grepping every migration that redefines this
-- function before writing this one) — via CREATE OR REPLACE with the
-- EXACT existing signature, matching this codebase's own "never edit a
-- frozen migration file" convention. Every line that is not new/changed
-- is a byte-for-byte copy of that frozen version.
--
-- WHAT CHANGED, PRECISELY:
--   1. The old blanket "track_inventory requires a caller-supplied sku"
--      check is replaced with mode-aware resolution: a caller-supplied
--      sku is normalized (private.normalize_sku) and used as-is. An
--      OMITTED sku on a TRACKED product is either generated
--      (SMART_AUTO/SIMPLE_SEQUENTIAL) or, for a MANUAL-mode business,
--      still required (SKU_REQUIRED). An omitted sku on a NON-TRACKED
--      (service) product is left null regardless of mode — a service
--      item has no inventory identity to generate one FOR, matching this
--      table's own existing CHECK (not track_inventory or sku is not
--      null) and this codebase's pre-existing, already-tested behavior
--      for that specific case (tests/integration/products.test.ts).
--   2. product.created's audit metadata gains one boolean key
--      (sku_generated) — metadata is NEVER part of idempotency comparison
--      (only canonical_payload is), so this is safe to add without
--      invalidating any in-flight or historical replay.
-- v_canonical_payload's OWN shape is UNCHANGED (same keys as before) —
-- only the 'sku' value it embeds may now hold a generated string instead
-- of null. This is what keeps a retry of a request submitted before this
-- migration (still pending, still comparable) resolving identically.
--
-- GENERATION TIMING: the sku is resolved (generated, if applicable)
-- BEFORE the canonical payload is built, matching the existing "resolve
-- once, up front" rule this function already applies to opening-stock
-- location resolution — a retried call with the same creation_key must
-- compare against, and return, the SAME originally-generated sku, never a
-- freshly regenerated one. Consequence, and accepted tradeoff (documented
-- again at private.next_sku_sequence, below): every create_product
-- invocation that reaches sku generation consumes one counter value, even
-- a losing/duplicate claim attempt — sequence numbers are monotonic and
-- unique, never required to be gapless (phase instruction §22 only
-- requires "monotonic enough for practical inventory use").
--
-- COLLISION HANDLING: a generated candidate can, in principle, still
-- collide with a PRE-EXISTING, manually-entered sku that happens to match
-- the same pattern (the counter only guarantees no collision BETWEEN two
-- auto-generated skus sharing a prefix). This is deliberately NOT
-- retried in-function — regenerating after the claim row's payload has
-- already been persisted would desync the stored canonical_payload's sku
-- from the one actually inserted, corrupting future idempotent replays of
-- this creation_key. Instead: products_sku_unique_idx (the existing,
-- final-defense uniqueness constraint) rejects the insert, the whole
-- transaction (including the claim row) rolls back exactly as it already
-- does for a manual SKU_UNAVAILABLE today, and a FRESH client retry (a
-- new creation_key, or the same one now that the claim rolled back) reads
-- the counter's next value, which the failed attempt already advanced
-- past the collision — so a bare retry succeeds. lib/errors.ts's mapping
-- for SKU_UNAVAILABLE is unchanged; this is the exact same user-facing
-- error and recovery path a manual duplicate already produces.
--
-- COLUMN-LEVEL GRANTS: every column a query references — including one
-- used only in a WHERE/JOIN predicate, never selected — requires its own
-- explicit SELECT grant under Postgres's column-privilege model; granting
-- only the column ultimately READ into a variable is NOT sufficient. This
-- migration's own first draft under-granted exactly this way (business_id
-- omitted from business_sku_settings's grant, id omitted from businesses'
-- and business_categories' grants) and was caught by running the full
-- integration suite against a real local database before this phase was
-- reported done — see the build brief's own validation section.

-- private.normalize_sku ---------------------------------------------------
--
-- Centralized, server-side authoritative normalization (phase instruction
-- §8): uppercase, whitespace collapsed to a single '-', any character
-- outside [A-Z0-9_-] stripped, duplicate separators collapsed, leading/
-- trailing separators trimmed, capped at 64 characters (trimming a
-- trailing separator introduced by truncation). Applied to EVERY sku this
-- phase ever stores — both caller-supplied (manual) and generated — so
-- the stored value itself, not just products_sku_unique_idx's own
-- case-insensitive comparison, is label-safe and consistently shaped.
create or replace function private.normalize_sku(p_input text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v text;
begin
  if p_input is null then
    return null;
  end if;
  v := upper(btrim(p_input));
  v := regexp_replace(v, '\s+', '-', 'g');
  v := regexp_replace(v, '[^A-Z0-9_-]', '', 'g');
  v := regexp_replace(v, '-{2,}', '-', 'g');
  v := regexp_replace(v, '^-+|-+$', '', 'g');
  if length(v) > 64 then
    v := regexp_replace(left(v, 64), '-+$', '');
  end if;
  return nullif(v, '');
end;
$$;

revoke all on function private.normalize_sku(text) from public;

-- private.sku_category_prefix ---------------------------------------------
--
-- A bounded, deliberately small hint map — the exact 14-entry table this
-- phase's own instructions specify (§9), keyed by business_categories.code
-- (the same stable, platform-seeded codes 20261005080000_create_business_
-- categories.sql inserts) — NEVER an authorization or entitlement lookup;
-- an unrecognized/missing code (including a business with no
-- primary_category_id set at all) simply falls back to 'PRD', same as
-- OTHER.
create or replace function private.sku_category_prefix(p_category_code text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_category_code
    when 'RETAIL'          then 'RET'
    when 'WHOLESALE'       then 'WHO'
    when 'RESTAURANT'      then 'RES'
    when 'FASHION'         then 'FAS'
    when 'PHARMACY'        then 'PHA'
    when 'ELECTRONICS'     then 'ELE'
    when 'GROCERY'         then 'GRO'
    when 'BEAUTY'          then 'BEA'
    when 'SERVICES'        then 'SER'
    when 'LOGISTICS'       then 'LOG'
    when 'AUTO_PARTS'      then 'AUT'
    when 'GENERAL_TRADING' then 'GEN'
    when 'MANUFACTURING'   then 'MAN'
    else 'PRD'
  end;
$$;

revoke all on function private.sku_category_prefix(text) from public;

-- private.sku_name_segments ------------------------------------------------
--
-- Deterministic, deliberately simple tokenizer (phase instruction §33,
-- "readable > magical"): splits on any non-alphanumeric run, drops empty
-- tokens and a small stopword list, uppercases, takes up to
-- p_max_segments tokens, truncates each to 4 characters. Degrades
-- gracefully to an empty array for a name with no usable tokens (e.g.
-- "the" or punctuation-only) — the caller (generate_product_sku) then
-- falls back to the category prefix alone.
create or replace function private.sku_name_segments(p_name text, p_max_segments integer default 2)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_tokens text[];
  v_out text[] := '{}';
  v_token text;
  v_stopwords text[] := array['A', 'AN', 'THE', 'OF', 'FOR', 'AND', 'WITH'];
begin
  if p_name is null then
    return v_out;
  end if;
  v_tokens := regexp_split_to_array(upper(p_name), '[^A-Z0-9]+');
  foreach v_token in array v_tokens loop
    exit when array_length(v_out, 1) >= p_max_segments;
    if v_token = '' or v_token = any (v_stopwords) then
      continue;
    end if;
    v_out := array_append(v_out, left(v_token, 4));
  end loop;
  return v_out;
end;
$$;

revoke all on function private.sku_name_segments(text, integer) from public;

-- private.next_sku_sequence ------------------------------------------------
--
-- Concurrency-safe counter allocation (phase instruction §22): NEVER
-- `select max(...) + 1`. An upsert-if-missing INSERT followed by a
-- row-locked UPDATE ... RETURNING — two concurrent callers requesting the
-- SAME (business_id, counter_key) serialize on Postgres's own row lock
-- (the second blocks until the first's transaction commits or rolls
-- back), and each receives a distinct, strictly increasing value. No
-- advisory lock needed: the row lock IS the serialization point, scoped
-- automatically to exactly the one counter being allocated from — a
-- concurrent allocation for a DIFFERENT counter_key (a different SKU
-- prefix, or a different business entirely) is never blocked by this one.
create or replace function private.next_sku_sequence(p_business_id uuid, p_counter_key text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value bigint;
begin
  insert into private.business_sku_counters (business_id, counter_key, next_value)
  values (p_business_id, p_counter_key, 1)
  on conflict (business_id, counter_key) do nothing;

  update private.business_sku_counters
  set next_value = next_value + 1, updated_at = now()
  where business_id = p_business_id and counter_key = p_counter_key
  returning next_value - 1 into v_value;

  return v_value;
end;
$$;

revoke all on function private.next_sku_sequence(uuid, text) from public;

-- private.generate_product_sku ---------------------------------------------
--
-- SIMPLE_SEQUENTIAL: a single, business-wide counter ('SIMPLE'), rendered
-- as PRD-000001, PRD-000002, ... (phase instruction §3's own example
-- shape, 6 digits).
--
-- SMART_AUTO: category hint (business's own primary_category_id, resolved
-- fresh here — never trusted from a parameter) + up to 2 readable name
-- segments + a per-PREFIX counter (so "ELE-SAM-A15" and "GRO-COC-50CL"
-- allocate independently, per phase instruction §34), zero-padded to at
-- least 3 digits, widening automatically past 999 rather than silently
-- truncating.
create or replace function private.generate_product_sku(
  p_business_id uuid,
  p_name        text,
  p_sku_mode    text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category_code text;
  v_prefix        text;
  v_segments      text[];
  v_seq           bigint;
  v_width         integer;
begin
  if p_sku_mode = 'SIMPLE_SEQUENTIAL' then
    v_seq := private.next_sku_sequence(p_business_id, 'SIMPLE');
    return 'PRD-' || lpad(v_seq::text, 6, '0');
  end if;

  -- SMART_AUTO — the only other mode that ever reaches this function
  -- (MANUAL mode never calls generate_product_sku at all; see
  -- create_product below).
  select bc.code into v_category_code
  from public.businesses b
  join public.business_categories bc on bc.id = b.primary_category_id
  where b.id = p_business_id;

  v_prefix := private.sku_category_prefix(v_category_code);
  v_segments := private.sku_name_segments(p_name, 2);
  if array_length(v_segments, 1) > 0 then
    v_prefix := v_prefix || '-' || array_to_string(v_segments, '-');
  end if;

  v_seq := private.next_sku_sequence(p_business_id, v_prefix);
  v_width := greatest(3, length(v_seq::text));
  return v_prefix || '-' || lpad(v_seq::text, v_width, '0');
end;
$$;

revoke all on function private.generate_product_sku(uuid, text, text) from public;

-- Ownership + grants --------------------------------------------------------
--
-- All five new functions are owned by private_product_creator — the ONLY
-- role that ever calls them (from inside create_product's own SECURITY
-- DEFINER body, which already runs AS private_product_creator). No
-- separate EXECUTE grant is needed for that self-owned relationship
-- (ownership already implies every privilege); the CREATE/ALTER OWNER
-- dance below exists only because these functions are first CREATEd by
-- whatever role runs this migration (the migration runner), matching
-- create_product_rpc.sql's own established establishment pattern.
grant create on schema private to private_product_creator;
alter function private.normalize_sku(text) owner to private_product_creator;
alter function private.sku_category_prefix(text) owner to private_product_creator;
alter function private.sku_name_segments(text, integer) owner to private_product_creator;
alter function private.next_sku_sequence(uuid, text) owner to private_product_creator;
alter function private.generate_product_sku(uuid, text, text) owner to private_product_creator;
revoke create on schema private from private_product_creator;

-- Minimum new table privileges private_product_creator needs to run the
-- functions above. EVERY column each query references is granted,
-- including WHERE/JOIN-only columns (id on businesses/business_categories,
-- business_id on business_sku_settings) — see this migration's own header
-- comment on why that's required, not merely the columns read into a
-- variable. businesses(id, currency_code) is already granted by
-- 20260924080000_product_currency_from_business.sql — primary_category_id
-- is an ADDITIVE grant here, not a replacement.
grant select (business_id, sku_mode) on public.business_sku_settings to private_product_creator;
grant select (id, primary_category_id) on public.businesses to private_product_creator;
grant select (id, code) on public.business_categories to private_product_creator;
grant select, insert, update on private.business_sku_counters to private_product_creator;

-- public.create_product (extended) ------------------------------------------

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
  v_actor_email           text;
  -- Phase 1Q-B locals.
  v_sku_mode              text;
  v_sku_auto_generated    boolean;
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

  -- Phase 1Q-B: mode-aware SKU resolution, replacing the old blanket
  -- "track_inventory requires a caller-supplied sku" check. See this
  -- migration's own header comment for the exact behavior change.
  v_sku_auto_generated := false;
  if v_sku is not null then
    v_sku := private.normalize_sku(v_sku);
    if v_sku is null then
      raise exception 'INVALID_SKU' using errcode = '22023';
    end if;
  elsif v_track_inventory then
    -- Only a TRACKED product with an omitted sku ever reaches generation
    -- — a non-tracked (service) item has no inventory identity to
    -- generate one for, and simply stays null (falls through, matching
    -- products' own existing CHECK).
    select sku_mode into v_sku_mode
    from public.business_sku_settings
    where business_id = p_business_id;
    v_sku_mode := coalesce(v_sku_mode, 'SMART_AUTO');

    if v_sku_mode = 'MANUAL' then
      raise exception 'SKU_REQUIRED' using errcode = '22023';
    else
      v_sku := private.generate_product_sku(p_business_id, v_name, v_sku_mode);
      v_sku_auto_generated := true;
    end if;
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
  -- same jsonb value. Shape UNCHANGED from the frozen version — see this
  -- migration's own header comment.
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
        -- (once the underlying conflict is resolved) can claim cleanly —
        -- including a generated-sku collision; see this migration's own
        -- header comment ("COLLISION HANDLING").
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

    -- Phase 1J instrumentation (unchanged event name/category): recorded
    -- only on this WON-CLAIM path. Phase 1Q-B adds ONE metadata key
    -- (sku_generated) — metadata is never part of idempotency comparison,
    -- so this is a safe, additive change.
    v_actor_email := private.current_verified_email();
    perform private.record_audit_event(
      p_business_id, 'USER', v_uid, 'product.created', 'INVENTORY',
      null, v_actor_email, null,
      'product', v_product.id, v_product.name, 'SUCCESS',
      jsonb_build_object('sku_generated', v_sku_auto_generated)
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

-- CREATE OR REPLACE preserves create_product's existing owner
-- (private_product_creator) and ACL automatically — the signature is
-- unchanged. No further ownership/grant statement is required.
