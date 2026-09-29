-- Phase 1Q-B remediation (Codex rejection, blocking findings 1 and 2).
--
-- FINDING 1 — PRIMARY IDENTIFIER CONCURRENCY:
-- public.add_product_identifier (20261010080200_create_product_identifiers.sql)
-- inserted the new row with is_primary already set, THEN demoted every
-- other identifier on the product in a separate UPDATE. Two concurrent
-- calls each requesting is_primary=true could both INSERT before either's
-- demoting UPDATE ran, leaving two (or more) primary identifiers on the
-- same product — no invariant in the schema itself prevented it.
--
-- Fixed two ways, per instruction (defense in depth, not either/or):
--   (a) a HARD DATABASE INVARIANT — a partial unique index that makes
--       "more than one primary identifier per product" structurally
--       unrepresentable, independent of any application code path ever
--       reaching this table (belt: even a future RPC/bug cannot violate
--       it).
--   (b) SERIALIZED PRIMARY REPLACEMENT — add_product_identifier now locks
--       the parent product row (SELECT ... FOR UPDATE) before touching
--       product_identifiers at all, so two concurrent calls for the SAME
--       product execute their demote-then-insert sequence one after the
--       other, never interleaved (suspenders: closes the race at its
--       actual source, rather than relying solely on catching the unique
--       violation after an unsafe interleaving).
-- The ORDER inside the function also changes: the previous "insert new
-- row primary, then demote others" sequence would now immediately violate
-- the new partial unique index whenever a primary already existed (a
-- unique index is checked per-statement, not deferred to commit) — the
-- function now demotes the existing primary FIRST, then inserts, matching
-- the instruction's own preferred flow (derive/validate product -> lock
-- product row -> demote existing primary -> insert/update requested
-- identifier as primary -> commit atomically).
--
-- FINDING 2 — SKU EDIT NORMALIZATION BYPASS:
-- lib/products/actions.ts's updateProduct Server Action wrote
-- products.sku via a plain `.from("products").update(...)` — the same
-- RLS-governed path every other editable product column uses — which
-- never routed the value through private.normalize_sku the way
-- create_product's own SKU resolution does. A manually-entered "  sh0e "
-- would persist exactly as typed instead of canonicalizing to "SH0E",
-- and any caller with the (pre-existing, ordinary) `products.manage`
-- permission could write an arbitrary unnormalized value directly.
--
-- Fixed with a dedicated, narrow, SECURITY DEFINER mutation
-- (public.update_product_sku) that is now the ONLY path capable of
-- changing products.sku: it rederives the actor, re-validates business/
-- product ownership and products.manage, normalizes through the exact
-- same private.normalize_sku create_product already uses, enforces the
-- existing business-scoped case-insensitive uniqueness index
-- (products_sku_unique_idx), maps a collision to the stable
-- SKU_ALREADY_EXISTS code and an unnormalizable input to INVALID_SKU
-- (never a raw constraint name or SQLSTATE), and preserves NULL as a
-- legitimate, intentional value. `authenticated`'s direct column UPDATE
-- privilege on products.sku is REVOKED below — least privilege, per
-- instruction §7 option A — so no path remains where a caller holding
-- only `products.manage` can write an unnormalized value straight to the
-- column; every other product column (name, description, barcode,
-- category, unit, cost_price, selling_price, currency_code,
-- low_stock_threshold, status) is UNCHANGED and remains a plain RLS-
-- governed UPDATE exactly as before. The existing
-- products_audit_sku_change trigger (20261010080300_product_sku_change_
-- audit.sql) fires on ANY `UPDATE OF sku` regardless of which role
-- performs it, so update_product_sku's own UPDATE statement is already
-- audited with zero additional code — it is a table-level AFTER trigger,
-- not scoped to a specific caller role.

-- ---------------------------------------------------------------------
-- Part A — primary-identifier concurrency
-- ---------------------------------------------------------------------

-- Hard invariant: at most one primary identifier per product, globally,
-- regardless of which code path ever writes this table. business_id is
-- included alongside product_id purely to match this migration's own
-- established "double-scope by business_id too" convention elsewhere in
-- this table (product_id is already tenant-unambiguous via its composite
-- FK to products(id, business_id) — this is belt-and-suspenders, not a
-- looser scope than intended).
create unique index product_identifiers_one_primary_per_product_idx
  on public.product_identifiers (business_id, product_id)
  where is_primary;

-- SELECT ... FOR UPDATE requires UPDATE privilege on the locked table in
-- Postgres, not merely SELECT — private_product_identifier_writer
-- previously only held `select (id, business_id, name)` (granted by
-- 20261010080200_create_product_identifiers.sql), which is not
-- sufficient to acquire the row lock add_product_identifier now takes
-- below. Additive: granted on the SAME column set already readable by
-- this role, so no new column becomes visible or writable in practice —
-- add_product_identifier's own body never issues an UPDATE against
-- public.products; this grant exists solely to satisfy FOR UPDATE's
-- privilege check for locking, not to enable a write.
grant update (id, business_id, name) on public.products to private_product_identifier_writer;

create or replace function public.add_product_identifier(
  p_business_id      uuid,
  p_product_id       uuid,
  p_identifier_type  text,
  p_identifier_value text,
  p_is_primary       boolean default false
)
returns public.product_identifiers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid              uuid;
  v_product_name     text;
  v_normalized       text;
  v_expected_lengths integer[];
  v_row              public.product_identifiers;
  v_actor_email      text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_product_id is null then
    raise exception 'p_business_id and p_product_id are required' using errcode = '22023';
  end if;

  -- Same authority as editing the product (phase instruction §18) — no
  -- separate identifier-specific permission is introduced.
  if not private.has_permission(p_business_id, 'products.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- IDOR guard: the product must belong to THIS business — never trusted
  -- from the caller's own claim. A foreign or nonexistent product_id is
  -- rejected with the SAME code either way (non-disclosure, matching this
  -- codebase's own established posture for foreign/nonexistent resources
  -- elsewhere).
  --
  -- Remediation: FOR UPDATE locks the product row for the remainder of
  -- this transaction. Two concurrent add_product_identifier calls for the
  -- SAME product now serialize here — the second blocks until the
  -- first's transaction commits or rolls back — so the demote-then-insert
  -- sequence below can never interleave between two callers. A concurrent
  -- call for a DIFFERENT product is never blocked by this one.
  select name into v_product_name
  from public.products
  where id = p_product_id and business_id = p_business_id
  for update;

  if v_product_name is null then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;

  if coalesce(p_identifier_type, '') not in ('GTIN', 'UPC_A', 'EAN_13', 'EAN_8', 'OTHER') then
    raise exception 'INVALID_IDENTIFIER_TYPE' using errcode = '22023';
  end if;

  v_normalized := private.normalize_identifier(p_identifier_type, p_identifier_value);
  if v_normalized is null then
    raise exception 'INVALID_IDENTIFIER' using errcode = '22023';
  end if;

  if p_identifier_type <> 'OTHER' then
    v_expected_lengths := case p_identifier_type
      when 'UPC_A' then array[12]
      when 'EAN_13' then array[13]
      when 'EAN_8' then array[8]
      when 'GTIN' then array[8, 12, 13, 14]
    end;
    if not (length(v_normalized) = any (v_expected_lengths)) then
      raise exception 'INVALID_IDENTIFIER' using errcode = '22023';
    end if;
    -- Check-digit validation where practical (phase instruction §14);
    -- OTHER never reaches here, so a legitimate internal/external code
    -- outside GTIN/UPC/EAN's own numeric standard is never rejected for
    -- failing a check-digit rule that was never meant to apply to it.
    if not private.validate_gtin_check_digit(v_normalized) then
      raise exception 'INVALID_IDENTIFIER_CHECK_DIGIT' using errcode = '22023';
    end if;
  end if;

  -- Remediation: demote the existing primary (if any) BEFORE inserting
  -- the new row — reordered from the original insert-then-demote
  -- sequence, which would otherwise trip the new partial unique index
  -- below the instant the new row's INSERT lands, whenever a primary
  -- already existed (a unique index is enforced per-statement, not
  -- deferred to COMMIT). The product-row lock above guarantees no other
  -- transaction can observe or act on an intermediate state here.
  if coalesce(p_is_primary, false) then
    update public.product_identifiers
    set is_primary = false
    where product_id = p_product_id and business_id = p_business_id and is_primary;
  end if;

  begin
    insert into public.product_identifiers (
      business_id, product_id, identifier_type, identifier_value, normalized_value,
      is_primary, created_by
    ) values (
      p_business_id, p_product_id, p_identifier_type, btrim(p_identifier_value), v_normalized,
      coalesce(p_is_primary, false), v_uid
    )
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'IDENTIFIER_ALREADY_EXISTS' using errcode = '23505';
  end;

  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'product.identifier_added', 'INVENTORY',
    null, v_actor_email, null,
    'product', p_product_id, v_product_name, 'SUCCESS',
    jsonb_build_object('identifier_type', p_identifier_type, 'identifier_id', v_row.id)
  );

  return v_row;
end;
$$;

-- CREATE OR REPLACE preserves add_product_identifier's existing owner
-- (private_product_identifier_writer) and ACL automatically — the
-- signature is unchanged. No further ownership/grant statement is
-- required.

-- ---------------------------------------------------------------------
-- Part B — canonical, authorized SKU-edit mutation
-- ---------------------------------------------------------------------

-- private_product_sku_writer -------------------------------------------
--
-- A DEDICATED, narrow, NOLOGIN role — per create_product_rpc.sql's own
-- explicit "never extend private_product_creator's table grants as a
-- quick fix for some other function's privilege problem; give that
-- function its own dedicated minimal role instead" rule. BYPASSRLS is
-- required for the same reason every other private writer role in this
-- schema needs it: the target table (products) FORCES row level
-- security, and this role's own UPDATE must succeed regardless of the
-- calling session's RLS-visible row set.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_product_sku_writer') then
    create role private_product_sku_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_product_sku_writer to postgres;

grant usage on schema public to private_product_sku_writer;
grant usage on schema private to private_product_sku_writer;

-- Only the columns update_product_sku actually reads or writes — id and
-- business_id to confirm the row exists and is same-tenant, sku and
-- track_inventory to compute/validate the new value, name for nothing
-- (deliberately NOT granted: the audit trigger reads NEW.name itself,
-- under its own private_product_creator-owned SECURITY DEFINER context,
-- which already holds that grant — this role does not need it).
grant select (id, business_id, sku, track_inventory) on public.products to private_product_sku_writer;
grant update (sku) on public.products to private_product_sku_writer;

grant execute on function private.current_uid() to private_product_sku_writer;
grant execute on function private.has_permission(uuid, text) to private_product_sku_writer;
-- Cross-role dependency, identical in kind to add_product_identifier's
-- own normalize_sku grant: owned by private_product_creator, called from
-- a different role's SECURITY DEFINER body.
grant execute on function private.normalize_sku(text) to private_product_sku_writer;

-- update_product_sku ----------------------------------------------------
--
-- The sole authorized path for changing an EXISTING product's sku.
-- Errors are always one of the stable, already-mapped-in-lib/errors.ts
-- codes below — never a raw constraint name or SQLSTATE.
--
-- Returns just the resulting (post-normalization) sku value, NOT the
-- full product row — deliberately, to keep private_product_sku_writer's
-- own SELECT grant on products narrow (id, business_id, sku,
-- track_inventory only; no cost_price, matching the Cost Visibility
-- Architecture, and no other column this role has no reason to read).
-- `select *` / `RETURNING *` both require SELECT privilege on EVERY
-- column of the table for the executing role, not just the ones actually
-- used — returning the full public.products row here would have forced
-- widening this role's grant far beyond what it needs, which is exactly
-- the "extend a role's grants as a quick fix" anti-pattern
-- create_product_rpc.sql's own header comment warns against repeating.
-- No caller in this codebase reads more than the resulting sku value
-- from this RPC today (lib/products/actions.ts only checks `.error`).
create or replace function public.update_product_sku(
  p_business_id uuid,
  p_product_id  uuid,
  p_sku         text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid              uuid;
  v_normalized       text;
  v_current_sku      text;
  v_track_inventory  boolean;
  v_found            boolean;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_product_id is null then
    raise exception 'p_business_id and p_product_id are required' using errcode = '22023';
  end if;

  -- Re-derived and re-checked here, independent of whatever the calling
  -- Server Action already verified — the same "every mutation boundary
  -- re-checks its own permission" rule this schema applies everywhere
  -- else (phase instruction §6 / matching add_product_identifier above).
  if not private.has_permission(p_business_id, 'products.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- IDOR guard, identical in kind to add_product_identifier's own: a
  -- foreign or nonexistent product_id is rejected with the same
  -- non-disclosing code either way. FOR UPDATE locks the product row for
  -- the rest of this transaction, serializing two concurrent SKU edits
  -- (or a concurrent SKU edit and a concurrent archive/other-field edit
  -- that also acquires this lock) on the same product — a defense-in-
  -- depth measure; the actual data-integrity backstop against a lost
  -- update either way remains products_sku_unique_idx.
  select sku, track_inventory, true
  into v_current_sku, v_track_inventory, v_found
  from public.products
  where id = p_product_id and business_id = p_business_id
  for update;

  if not coalesce(v_found, false) then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;

  -- NULL/blank is a legitimate, intentional value — never normalized,
  -- simply cleared. The client never supplies a pre-normalized value
  -- that is trusted as-is: every non-blank input is re-normalized here,
  -- server-side, exactly like create_product's own SKU resolution.
  if p_sku is null or btrim(p_sku) = '' then
    v_normalized := null;
  else
    v_normalized := private.normalize_sku(p_sku);
    if v_normalized is null then
      raise exception 'INVALID_SKU' using errcode = '22023';
    end if;
  end if;

  -- Mirrors products' own CHECK (not track_inventory or sku is not
  -- null) as a stable, mapped application error instead of a raw
  -- constraint violation surfacing from the UPDATE below.
  if v_normalized is null and v_track_inventory then
    raise exception 'SKU_REQUIRED' using errcode = '22023';
  end if;

  if v_normalized is not distinct from v_current_sku then
    -- No-op: nothing changed, so no UPDATE (and therefore no audit
    -- event, and no updated_at bump) for a request that alters nothing.
    return v_current_sku;
  end if;

  begin
    update public.products
    set sku = v_normalized
    where id = p_product_id and business_id = p_business_id;
  exception
    when unique_violation then
      -- products_sku_unique_idx is business-scoped and case/whitespace-
      -- normalized — the exact same index create_product's own
      -- SKU_UNAVAILABLE case protects at creation time. A distinct code
      -- name (SKU_ALREADY_EXISTS) is used for the edit path so the two
      -- contexts can carry different, contextually accurate copy in
      -- lib/errors.ts without ambiguity about which flow produced it.
      raise exception 'SKU_ALREADY_EXISTS' using errcode = '23505';
  end;

  return v_normalized;
end;
$$;

grant create on schema public to private_product_sku_writer;
alter function public.update_product_sku(uuid, uuid, text) owner to private_product_sku_writer;
revoke create on schema public from private_product_sku_writer;

revoke all on function public.update_product_sku(uuid, uuid, text) from public, anon;
grant execute on function public.update_product_sku(uuid, uuid, text) to authenticated;

-- Close the direct-write bypass: `authenticated` retains its existing
-- UPDATE grant on every other product column (name, description,
-- barcode, category, unit, cost_price, selling_price, currency_code,
-- low_stock_threshold, status — see 20260826080000_create_products.sql)
-- unchanged; only the sku column-level privilege is revoked. The
-- products_update RLS policy is untouched and continues to govern every
-- remaining directly-editable column exactly as before.
revoke update (sku) on public.products from authenticated;
