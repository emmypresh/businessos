-- Phase 1Q-B, part 3 — external product identifiers (GTIN/UPC/EAN/OTHER),
-- separate from products.sku (BusinessOS's own internal identifier) and
-- from products.barcode (the existing single free-text legacy column,
-- LEFT UNCHANGED by this phase — see below).
--
-- WHY A NEW TABLE, NOT MORE COLUMNS ON products (phase instruction §12):
-- products.barcode is a single, untyped, at-most-one-per-product text
-- field, already relied on by existing code (its own unique index, its
-- own grant surface, the product-form UI). Extending it to support
-- MULTIPLE typed codes per product (a manufacturer GTIN AND a store's own
-- legacy barcode label, say) is structurally impossible without either a
-- separate table or a family of new nullable columns — the table is the
-- cleaner, more extensible shape, and matches this schema's own existing
-- precedent (business_member_branches, invoice_items) for "a product may
-- have zero or many of these." products.barcode itself is NOT migrated,
-- deprecated, or backfilled into this table by this phase — it remains
-- exactly as it already behaves; this table is purely additive, forward-
-- looking foundation. A future phase MAY choose to consolidate them; that
-- decision is explicitly out of scope here (no destructive backfill,
-- phase instruction §10/§53).
create table public.product_identifiers (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  product_id       uuid not null,
  identifier_type  text not null
                     check (identifier_type in ('GTIN', 'UPC_A', 'EAN_13', 'EAN_8', 'OTHER')),
  -- As the caller typed it (display value) — kept separately from
  -- normalized_value (the canonical, comparison/uniqueness form), mirroring
  -- this schema's existing sku/normalized-comparison split precedent
  -- (products_sku_unique_idx's own upper(btrim(sku)) expression index).
  identifier_value text not null
                     check (length(btrim(identifier_value)) between 1 and 64),
  normalized_value text not null
                     check (length(normalized_value) between 1 and 64),
  is_primary       boolean not null default false,
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Tenant-consistent composite FK — a cross-business
  -- (product_id, business_id) pairing is structurally unrepresentable,
  -- not just RPC-checked, mirroring inventory_ledger's own identical
  -- technique against products' own unique (id, business_id).
  foreign key (product_id, business_id) references public.products (id, business_id) on delete cascade,
  unique (id, business_id)
);

-- Business-scoped uniqueness on the NORMALIZED value, spanning every
-- identifier_type together (phase instruction §13: "same normalized
-- barcode cannot point to multiple active products" — enforced here as
-- "cannot point to multiple products, period," the stricter and simpler
-- reading, since this phase introduces no per-product-status distinction
-- for identifiers). The identical normalized code in a DIFFERENT business
-- is unaffected — no global uniqueness constraint exists.
create unique index product_identifiers_business_normalized_idx
  on public.product_identifiers (business_id, normalized_value);

create index product_identifiers_business_product_idx
  on public.product_identifiers (business_id, product_id);

create trigger product_identifiers_set_updated_at
  before update on public.product_identifiers
  for each row
  execute function private.set_updated_at();

-- Row Level Security -----------------------------------------------------

alter table public.product_identifiers enable row level security;
alter table public.product_identifiers force row level security;

create policy product_identifiers_select on public.product_identifiers
  for select
  to authenticated
  using (private.has_permission(business_id, 'products.view'));

-- No INSERT/UPDATE/DELETE policy for `authenticated` — mutation is
-- RPC-only (add_product_identifier / remove_product_identifier, below),
-- matching products' own "creation is RPC-only" boundary: check-digit
-- validation, type-specific length rules, normalization, the is_primary
-- single-winner invariant, and audit instrumentation cannot be guaranteed
-- if a client could `.from("product_identifiers").insert(...)` directly.

revoke all on public.product_identifiers from public, anon, authenticated, service_role;
grant select (
  id, business_id, product_id, identifier_type, identifier_value,
  is_primary, created_at, updated_at
) on public.product_identifiers to authenticated, service_role;
revoke references, trigger, truncate on public.product_identifiers from anon, authenticated;

-- private.normalize_identifier ---------------------------------------------
--
-- GTIN/UPC_A/EAN_13/EAN_8: digits only (every other character, including
-- spaces and dashes some scanners/labels include, stripped). OTHER reuses
-- private.normalize_sku's own canonical form (uppercase, [A-Z0-9_-] only,
-- 64-char cap) — a deliberate, single normalization strategy shared
-- across every identifier-like value this schema stores (phase
-- instruction §8's "centralized" requirement, applied here too).
create or replace function private.normalize_identifier(p_type text, p_value text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_type in ('GTIN', 'UPC_A', 'EAN_13', 'EAN_8') then
    return nullif(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), '');
  end if;
  return private.normalize_sku(p_value);
end;
$$;

revoke all on function private.normalize_identifier(text, text) from public;

-- private.validate_gtin_check_digit -----------------------------------------
--
-- The standard GS1 mod-10 check-digit algorithm, applied uniformly to
-- 8/12/13/14-digit codes (EAN-8, UPC-A, EAN-13, GTIN-14) — the weighting
-- (3 for the digit immediately left of the check digit, alternating with
-- 1, moving left) is identical across all four lengths; only the total
-- length differs. Returns false (never raises) for anything that isn't a
-- plain digit string of a recognized length, so callers can use it as a
-- simple boolean gate.
create or replace function private.validate_gtin_check_digit(p_digits text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_len   integer;
  v_sum   integer := 0;
  v_digit integer;
  i       integer;
begin
  if p_digits is null or p_digits !~ '^[0-9]+$' then
    return false;
  end if;
  v_len := length(p_digits);
  if v_len not in (8, 12, 13, 14) then
    return false;
  end if;

  for i in 1..(v_len - 1) loop
    v_digit := substring(p_digits from (v_len - i) for 1)::integer;
    v_sum := v_sum + v_digit * (case when i % 2 = 1 then 3 else 1 end);
  end loop;

  return ((10 - (v_sum % 10)) % 10) = substring(p_digits from v_len for 1)::integer;
end;
$$;

revoke all on function private.validate_gtin_check_digit(text) from public;

-- private_product_identifier_writer ----------------------------------------
--
-- A dedicated, narrow, NOLOGIN role — mirrors every other Phase 1C-1Q
-- private writer role exactly. BYPASSRLS required because
-- product_identifiers FORCES row level security with no INSERT/UPDATE/
-- DELETE policy for any client role.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'private_product_identifier_writer') then
    create role private_product_identifier_writer noinherit nologin bypassrls;
  end if;
end;
$$;

grant private_product_identifier_writer to postgres;

grant usage on schema public to private_product_identifier_writer;
grant usage on schema private to private_product_identifier_writer;

grant select, insert, update, delete on public.product_identifiers to private_product_identifier_writer;
-- Read-only: to verify the target product exists, is same-tenant, and to
-- label audit events with its name — no broader column set than that.
grant select (id, business_id, name) on public.products to private_product_identifier_writer;

grant execute on function private.current_uid() to private_product_identifier_writer;
grant execute on function private.has_permission(uuid, text) to private_product_identifier_writer;
grant execute on function private.normalize_identifier(text, text) to private_product_identifier_writer;
grant execute on function private.validate_gtin_check_digit(text) to private_product_identifier_writer;
-- Cross-role dependency: normalize_identifier's OTHER branch calls
-- private.normalize_sku, owned by private_product_creator — a different
-- role than the one executing here, so this grant is required even though
-- normalize_identifier itself will be owned by private_product_identifier_writer.
grant execute on function private.normalize_sku(text) to private_product_identifier_writer;
grant execute on function private.record_audit_event(
  uuid, text, uuid, text, text, uuid, text, text, text, uuid, text, text, jsonb
) to private_product_identifier_writer;
grant execute on function private.current_verified_email() to private_product_identifier_writer;

-- add_product_identifier ----------------------------------------------------

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
  select name into v_product_name
  from public.products
  where id = p_product_id and business_id = p_business_id;

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

  -- is_primary is a single-winner-per-product flag: setting a new one
  -- demotes every other identifier on the SAME product, scoped by
  -- business_id too (belt and suspenders — product_id alone is already
  -- tenant-unambiguous via its own composite FK, but every other query in
  -- this function double-scopes by business_id and this one matches that
  -- convention).
  if coalesce(p_is_primary, false) then
    update public.product_identifiers
    set is_primary = false
    where product_id = p_product_id and business_id = p_business_id and id <> v_row.id;
  end if;

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

grant create on schema public to private_product_identifier_writer;
alter function public.add_product_identifier(uuid, uuid, text, text, boolean)
  owner to private_product_identifier_writer;
revoke create on schema public from private_product_identifier_writer;

revoke all on function public.add_product_identifier(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.add_product_identifier(uuid, uuid, text, text, boolean) to authenticated;

-- remove_product_identifier --------------------------------------------------

create or replace function public.remove_product_identifier(
  p_business_id   uuid,
  p_identifier_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid           uuid;
  v_identifier    public.product_identifiers;
  v_product_name  text;
  v_actor_email   text;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not private.has_permission(p_business_id, 'products.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- IDOR guard: only an identifier that belongs to THIS business can ever
  -- be deleted — a foreign/nonexistent id is rejected with the same
  -- non-disclosing code either way.
  select * into v_identifier
  from public.product_identifiers
  where id = p_identifier_id and business_id = p_business_id;

  if v_identifier.id is null then
    raise exception 'IDENTIFIER_NOT_FOUND' using errcode = '22023';
  end if;

  select name into v_product_name from public.products where id = v_identifier.product_id;

  delete from public.product_identifiers
  where id = p_identifier_id and business_id = p_business_id;

  v_actor_email := private.current_verified_email();
  perform private.record_audit_event(
    p_business_id, 'USER', v_uid, 'product.identifier_removed', 'INVENTORY',
    null, v_actor_email, null,
    'product', v_identifier.product_id, v_product_name, 'SUCCESS',
    jsonb_build_object('identifier_type', v_identifier.identifier_type, 'identifier_id', v_identifier.id)
  );
end;
$$;

grant create on schema public to private_product_identifier_writer;
alter function public.remove_product_identifier(uuid, uuid) owner to private_product_identifier_writer;
revoke create on schema public from private_product_identifier_writer;

revoke all on function public.remove_product_identifier(uuid, uuid) from public, anon;
grant execute on function public.remove_product_identifier(uuid, uuid) to authenticated;
