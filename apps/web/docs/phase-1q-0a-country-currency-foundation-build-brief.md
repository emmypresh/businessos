# Phase 1Q-0A — Country & Currency Data Foundation + Formatter

Combined six-document build brief (lean form — foundation-only phase, no new UI
surface). Sections are short because the phase itself is schema + catalog +
formatter, not a feature with screens; each section says why it's short instead of
omitting it.

## 01 — Product Requirements

**Problem.** BusinessOS is architected Nigeria-only: `businesses` has no
country/currency identity, money is displayed via a formatter that hardcodes the
`en-NG` locale and, at ~40 call sites, the literal string `"NGN"`. This blocks
onboarding any business outside Nigeria.

**Users.** Internal — no new end-user-facing screen ships in this phase. The
consumers of this phase's output are future phases (1Q-0B onboarding, 1Q-0C UI
migration) and this repo's own test suite.

**In scope (v1 of this phase).**
1. `businesses.country_code` / `businesses.currency_code` columns, NOT NULL, backfilled.
2. `create_business` RPC accepts optional country/currency (transitional defaults).
3. Country→currency catalog (`lib/business/country-currency.ts`), 6 launch countries.
4. `formatMoney` extended to take a locale-aware currency context, symbol output,
   backward-compatible for existing 2-arg call sites.
5. Server-side validation (zod) for country/currency codes.
6. Tests: DB, catalog, formatter.
7. Static inventory of remaining hardcoded NGN assumptions.

**Explicitly out of scope.** Onboarding UI, dashboard/report/invoice label migration,
multi-currency transactions, FX, Paystack behavior changes. See §16.

**Success criteria.** `businesses` row is never left without a valid ISO country and
currency; existing formatMoney call sites keep compiling and passing; new formatter
produces the symbol table in the phase spec for all 7 supported currencies; full
existing test suite (unit + integration) still green.

## 02 — Technical Design

**Stack.** No new dependency. `Intl.NumberFormat` (built into Node/the browser) for
formatting; Postgres CHECK constraints + a small SQL lookup for country→currency at
the RPC layer (mirrors the TS catalog, not a giant CHECK list).

**Architecture decision — two columns, not one.** `country_code` (ISO 3166-1 alpha-2)
and `currency_code` (ISO 4217) are stored independently on `businesses`, per the
spec's Symbol Collision Rule: symbols aren't unique ($ is USD/CAD/others), one
country can accept multiple currencies, and country is metadata, never an
authorization signal.

**Migration strategy.** Additive, three-step, single phase:
1. `alter table businesses add column country_code text` (nullable) + `currency_code text` (nullable).
2. Backfill every existing row to `'NG'` / `'NGN'` (Phase 1 assumption: all current
   tenants are Nigerian).
3. `alter column ... set not null` + CHECK constraints
   (`country_code ~ '^[A-Z]{2}$'`, `currency_code ~ '^[A-Z]{3}$'`) — same pattern
   already used by `business_branches.country_code` and `products.currency_code`.

**Write-boundary preservation (see memory: rpc-write-boundaries-must-be-exclusive).**
`businesses` has no INSERT/UPDATE grant or RLS policy for `authenticated` — the two
new columns must not create one. `create_business` remains the sole write path; it is
extended with two new *trailing, optional* parameters so every existing 2-arg caller
(`lib/business/actions.ts`, `tests/integration/create-business.test.ts`, and the
dozens of test-fixture callers) keeps compiling unchanged. Implemented as
`DROP FUNCTION` + `CREATE FUNCTION` (not bare `CREATE OR REPLACE`) so there is exactly
one 4-parameter overload rather than two overloads with diverging privilege grants.

**No new SECURITY DEFINER surface.** The existing `private_business_creator` role and
`create_business` SECURITY DEFINER function are reused; no second definer function is
introduced for this phase (per the spec's explicit RLS instruction to stop and report
if one appears necessary — it doesn't).

**Formatter design.** `formatMoney(amount, currencyCode, options?)` — the 2-arg shape
is preserved byte-for-byte (existing 40+ call sites, all pinned to `"NGN"` today, keep
working) and now also accepts an optional third argument
`{ locale?: string; display?: "symbol" | "code" }`. Default `display` stays `"code"`
(today's `"NGN 1,234.56"` shape) so the 2-arg call sites are unaffected; a new
`formatMoneyForBusiness(amount, business)` convenience wraps it with
`display: "symbol"` and the business's locale, for future (1Q-0C) call-site migration.
A fixed symbol table overrides `Intl.NumberFormat`'s locale-dependent currencyDisplay
output for the 7 launch currencies (USD → "$", not "US$"; GHS → "GH₵"; etc.) per the
spec's Symbol Collision / determinism rule — `Intl` alone doesn't guarantee this.

**Trade-off documented.** A DB default vs. a required RPC parameter for new
businesses. Chosen: RPC parameters default to `'NG'` / (catalog-derived) `'NGN'`,
*not* a bare column DEFAULT — this keeps the fallback visible and centrally located
in one function (not silently reapplied by every future direct writer), and is
explicitly flagged as transitional debt: 1Q-0B's onboarding redesign must pass real
values and 1Q-0B or 1Q-0C should consider removing the RPC defaults once it does.

## 03 — App Flow & State Map

No new screen, route, or user-visible state in this phase — thin, and that's the
correct size for a data-foundation phase. The only "flow" touched is the existing
signup → `createBusiness` server action → `create_business` RPC → redirect to
`/{businessId}` path, which is unchanged from the user's point of view (still just
name + slug in the form); it now also silently carries the transitional NG/NGN
defaults through the RPC. 1Q-0B owns the actual country-picker flow and state map.

## 04 — UI/UX Design Brief

No new UI ships. Deferred in full to 1Q-0B (onboarding country/currency picker) and
1Q-0C (money-display migration to symbols across dashboard/reports/invoices). This
phase's only "UI-adjacent" output is the formatter's display contract (documented in
§02) that 1Q-0C's UI work will consume.

## 05 — Backend & Data Design

**Data model delta.**

```
businesses
  country_code   text not null   -- ISO 3166-1 alpha-2, uppercase, ^[A-Z]{2}$
  currency_code  text not null   -- ISO 4217, uppercase, ^[A-Z]{3}$
```

**Access rules.** Unchanged. `businesses` SELECT/UPDATE/DELETE continue to depend on
`private.is_business_member` / `private.has_permission` (membership-derived, per
memory: rls-access-must-derive-from-current-state) — the two new columns carry no new
policy of their own; they're just additional columns on an already-governed row.
`authenticated` still has no direct table-level write path onto `businesses` (write
boundary preserved — see §02).

**RPC surface delta.** `create_business(p_name, p_slug, p_country_code default 'NG',
p_currency_code default null)`. When `p_currency_code` is omitted, the function
derives it from `p_country_code` via a small SQL lookup
(`private.default_currency_for_country`) mirroring the six-country TS catalog — not a
giant CHECK list, per the spec's DB-constraints guidance. Malformed codes (wrong
length, lowercase, symbols, full country names) are rejected with `22023`.

**Events/storage.** None new — no new table, no new storage bucket, no new webhook.

**Generated types.** `lib/supabase/database.types.ts` regenerated from the local
Postgres instance after migration (`supabase gen types typescript --local`), not
hand-edited (repo's established workflow).

## 06 — Engineering Implementation Plan

1. Migration: add nullable `country_code`/`currency_code` to `businesses`, backfill
   `NG`/`NGN`, set NOT NULL + CHECK. — *tests: backfill, NOT NULL, malformed rejection.*
2. Migration: replace `create_business` with the 4-parameter version +
   `private.default_currency_for_country` helper. — *tests: 2-arg legacy call still
   works and gets NG/NGN; explicit country with no currency derives correctly;
   explicit both persist as given; malformed country/currency rejected; RLS/ACL
   unchanged (existing `create-business.test.ts` + `phase1f-security.test.ts` still
   pass).*
3. `lib/business/country-currency.ts` — catalog (6 countries → currency/locale/name)
   + lookup helpers. — *tests: mapping table, unknown-code behavior.*
4. `lib/currency.ts` — extend `formatMoney`, add `formatMoneyForBusiness`, add the
   7-currency symbol table. — *tests: NGN/GBP/USD/GHS/KES/ZAR/EUR ×
   {0, negative, large, decimal}; legacy 2-arg call sites unchanged.*
5. `lib/validation/business.ts` — add `CountryCodeSchema`/`CurrencyCodeSchema`
   (mirrors `lib/validation/branches.ts`'s `BranchCountryCodeSchema`).
6. Regenerate `database.types.ts`; run full quality-gate suite (§Step below).
7. Static inventory doc of remaining hardcoded-NGN call sites (this file, §16).

Every task above traces to PRD §"in scope" items 1–7 — no task exists that the PRD
didn't ask for (traceability gate).
