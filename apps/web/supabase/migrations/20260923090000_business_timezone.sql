-- Phase 1Q-0B: give every business its own stored IANA timezone, instead
-- of the product's prior implicit Africa/Lagos assumption baked into
-- lib/date/business-timezone.ts (businessTodayDateString's own header
-- comment flags this exact gap: "the moment a second business timezone is
-- ever supported, this becomes the one place that needs to learn to read
-- a real per-business setting instead of a hardcoded constant").
--
-- Independent from country_code/currency_code (20260909080000_business_
-- country_currency.sql): country may SUPPLY a default timezone at
-- creation time, but country != timezone — some countries span multiple
-- timezones (the US chief among this catalog's six), and this column is
-- never re-derived from country_code on read.
--
-- Additive + backfill + tighten, in one migration, matching
-- 20260909080000_business_country_currency.sql's own established
-- three-step pattern exactly: nullable column first, backfill every
-- existing (pre-1Q-0B, Nigeria-only in practice) row to Africa/Lagos, then
-- NOT NULL + CHECK. Africa/Lagos is the only backfill value that reflects
-- every existing tenant's actual, already-in-use timezone (see
-- lib/date/business-timezone.ts) — not a guess.
alter table public.businesses
  add column timezone text;

update public.businesses
set timezone = 'Africa/Lagos'
where timezone is null;

-- Unlike country_code/currency_code's shape-only regex check (any
-- well-formed 2-/3-letter code passes the table CHECK; the application
-- catalog decides which are actually launch-supported), an IANA timezone
-- identifier has no simple universal shape regex that would meaningfully
-- reject invalid values ("Africa/NotAPlace" is shape-valid). This CHECK
-- is therefore a fixed allow-list, mirroring the exact nine-zone catalog
-- in lib/business/timezone-catalog.ts (five single-timezone launch
-- countries + four explicit US zones, per the phase brief's explicit
-- instruction not to silently assume every US business is
-- America/New_York) — kept in lockstep with that file; adding a launch
-- timezone requires updating both.
alter table public.businesses
  alter column timezone set not null,
  add constraint businesses_timezone_check
    check (timezone in (
      'Africa/Lagos',
      'Africa/Accra',
      'Africa/Nairobi',
      'Africa/Johannesburg',
      'Europe/London',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles'
    ));

-- RLS: no new policy needed. businesses_select/businesses_update
-- (20260825202828_business_membership_policies.sql) already govern every
-- column on this table by business.manage / membership — this migration
-- only widens the ALREADY-RLS-gated UPDATE grant's column list so
-- `authenticated` may write this new column at all (grants are
-- column-restricted independently of RLS on this table — see that
-- migration's own "UPDATE is column-restricted" comment). Timezone is the
-- one field of the three (country/currency/timezone) this phase makes
-- editable post-creation — see the phase brief's Timezone Editability
-- section. No SECURITY DEFINER function is introduced for this: the
-- existing businesses_update policy + business.manage permission already
-- correctly authorize the single Settings mutation this phase adds
-- (lib/business/actions.ts updateBusinessTimezone), matching the
-- businesses_country_code_check/currency_code_check precedent of
-- "table CHECK is the backstop, application code re-validates against the
-- live catalog for the friendlier, more specific error."
grant update (timezone) on public.businesses to authenticated;
