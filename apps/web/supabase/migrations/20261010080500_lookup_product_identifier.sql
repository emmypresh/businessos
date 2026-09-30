-- Phase 1Q-C — free product lookup, local-first RPC.
--
-- WHY A NEW RPC, NOT A PLAIN CLIENT QUERY: normalization and check-digit
-- validation live in `private` (private.normalize_identifier,
-- private.validate_gtin_check_digit — see 20261010080200_create_product_
-- identifiers.sql) and are deliberately never granted to `authenticated`.
-- Reusing them here (rather than writing a second, divergent normalizer in
-- application code, phase instruction §9/§30) requires a SECURITY DEFINER
-- function owned by a role that already holds those grants.
-- private_product_identifier_writer is that role — reused as-is rather
-- than introducing a new one, since this RPC is conceptually one more
-- "identifier operation" alongside add_product_identifier/
-- remove_product_identifier it already owns.
--
-- The caller supplies ONE raw string with no declared type (the phase's
-- own "Barcode / GTIN [____] [Look up]" UI never asks the user to pick a
-- type first) — this function detects the type itself from the
-- normalized digit count, exactly mirroring add_product_identifier's own
-- expected-length table, so the two paths can never silently diverge on
-- what counts as a valid GTIN/UPC-A/EAN-13/EAN-8.

grant select (id, business_id, name, sku, status, selling_price)
  on public.products to private_product_identifier_writer;

create or replace function public.lookup_product_identifier(
  p_business_id uuid,
  p_raw_value   text
)
returns table (
  status               text,
  identifier_type      text,
  normalized_value     text,
  product_id           uuid,
  product_name         text,
  product_sku          text,
  product_status       text,
  product_selling_price numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_digits     text;
  v_other      text;
  v_type       text;
  v_candidates text[];
  v_match      record;
begin
  v_uid := private.current_uid();
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_business_id is null then
    raise exception 'p_business_id is required' using errcode = '22023';
  end if;

  -- Local-match viewing needs only catalog read access (phase instruction
  -- §12) — a read-only staff member can still see "this barcode belongs
  -- to X" without holding products.manage.
  if not private.has_permission(p_business_id, 'products.view') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if coalesce(btrim(p_raw_value), '') = '' then
    raise exception 'INVALID_IDENTIFIER' using errcode = '22023';
  end if;

  -- Digit-only candidate (the GTIN/UPC-A/EAN-13/EAN-8 family all share one
  -- normalization: strip everything but digits — same rule
  -- add_product_identifier applies per-type, applied here without a type
  -- since one isn't known yet).
  v_digits := private.normalize_identifier('GTIN', p_raw_value);
  -- OTHER-style candidate (uppercase, [A-Z0-9_-] only) — covers a locally
  -- stored non-numeric/OTHER-typed identifier (e.g. a supplier's own
  -- alphanumeric code) that a plain digit strip would never match.
  v_other := private.normalize_sku(p_raw_value);

  v_type := case
    when v_digits is null then null
    when length(v_digits) = 8 then 'EAN_8'
    when length(v_digits) = 12 then 'UPC_A'
    when length(v_digits) = 13 then 'EAN_13'
    when length(v_digits) = 14 then 'GTIN'
    else null
  end;

  -- A recognized GS1 length with a failing check digit is rejected before
  -- any lookup at all (phase instruction §10/§27) — never silently
  -- treated as "not found" or as an OTHER-type local search, since that
  -- would let a mistyped code masquerade as a legitimate miss.
  if v_type is not null and not private.validate_gtin_check_digit(v_digits) then
    return query select
      'INVALID'::text, v_type, v_digits,
      null::uuid, null::text, null::text, null::text, null::numeric;
    return;
  end if;

  v_candidates := array_remove(array[v_digits, v_other], null);
  if array_length(v_candidates, 1) is null then
    raise exception 'INVALID_IDENTIFIER' using errcode = '22023';
  end if;

  -- Business-scoped only — the identical normalized code in a DIFFERENT
  -- business is structurally invisible here (phase instruction §11): the
  -- WHERE clause always carries p_business_id, never business-agnostic.
  select pi.product_id, p.name, p.sku, p.status, p.selling_price
  into v_match
  from public.product_identifiers pi
  join public.products p on p.id = pi.product_id and p.business_id = pi.business_id
  where pi.business_id = p_business_id
    and pi.normalized_value = any (v_candidates)
  limit 1;

  if v_match.product_id is not null then
    return query select
      'LOCAL_MATCH'::text,
      coalesce(v_type, 'OTHER'),
      coalesce(v_digits, v_other),
      v_match.product_id, v_match.name, v_match.sku, v_match.status, v_match.selling_price;
    return;
  end if;

  return query select
    'NOT_FOUND'::text, coalesce(v_type, 'OTHER'), coalesce(v_digits, v_other),
    null::uuid, null::text, null::text, null::text, null::numeric;
end;
$$;

grant create on schema public to private_product_identifier_writer;
alter function public.lookup_product_identifier(uuid, text)
  owner to private_product_identifier_writer;
revoke create on schema public from private_product_identifier_writer;

revoke all on function public.lookup_product_identifier(uuid, text) from public, anon;
grant execute on function public.lookup_product_identifier(uuid, text) to authenticated;
