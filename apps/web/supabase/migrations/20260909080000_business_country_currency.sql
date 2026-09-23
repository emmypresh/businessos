-- Phase 1Q-0A: give every business a stable ISO country and currency
-- identity, instead of the product's prior implicit Nigeria-only
-- assumption. Two independent columns, not one — see the phase brief
-- (docs/phase-1q-0a-country-currency-foundation-build-brief.md) for why a
-- currency symbol/country name is never the stored identity: symbols
-- collide (USD/CAD/others all use "$"), one country can support multiple
-- currencies, and country here is display/default metadata, never an
-- authorization signal.
--
-- Additive + backfill + tighten, in one migration, so there is never a
-- window where a row can be left without a valid value: nullable columns
-- first, backfill every existing (Nigeria-only, Phase 1) row to NG/NGN,
-- then NOT NULL + CHECK. All existing BusinessOS tenants predate this
-- column and were built under the Nigeria-first assumption, so NG/NGN is
-- the only backfill value that reflects their actual, already-in-use
-- currency — not a guess.
alter table public.businesses
  add column country_code  text,
  add column currency_code text;

update public.businesses
set country_code = 'NG', currency_code = 'NGN'
where country_code is null or currency_code is null;

-- Same shape as the existing business_branches.country_code
-- (20260828080000_create_business_branches.sql) and products.currency_code
-- (20260826080000_create_products.sql) constraints: a length+charset CHECK,
-- not a hardcoded enum of every launch country/currency. The application
-- catalog (lib/business/country-currency.ts) is the extensible source of
-- truth for which of the well-formed codes are actually supported product
-- launch targets; the database only guarantees the *shape* is a plausible
-- ISO code (uppercase, correct length), so adding a new launch country
-- never requires a schema migration.
alter table public.businesses
  alter column country_code  set not null,
  alter column currency_code set not null,
  add constraint businesses_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  add constraint businesses_currency_code_check
    check (currency_code ~ '^[A-Z]{3}$');

-- No RLS/grant change: these are additional columns on an already-governed
-- row. businesses has no INSERT/UPDATE policy or grant for `authenticated`
-- (see 20260825202823_create_businesses.sql) and this migration does not
-- introduce one — create_business (updated separately) remains the sole
-- write path, and SELECT continues to be governed by the existing
-- membership-derived policy.
