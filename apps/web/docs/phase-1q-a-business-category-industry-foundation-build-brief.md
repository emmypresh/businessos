# Phase 1Q-A — Business Category / Industry Foundation

Frozen baseline: `22c736d6dafb203c66b01fce676d2f9191616964` · Branch: `feature/expenses-financials`

This brief is intentionally lean where an area is small or fully inherits an existing
pattern (country/currency's "stable code, not label, is the identity" convention). No
section is omitted.

## 01 — Product Requirements Document

**Problem.** BusinessOS has no notion of what kind of business a tenant runs. Future
work (barcode/product-identifier defaults, POS, industry packs) needs a stable,
international, extensible signal to key defaults off of — without hardcoding one
business type into core architecture or letting category leak into authorization.

**Users.** Every business owner/admin, at onboarding and later in Settings. Platform
staff, read-only, for support context (deferred — see 06).

**In scope.** A platform-defined `business_categories` registry (14 categories total, including OTHER),
one primary category per business (`businesses.primary_category_id`), OTHER +
custom label capture, onboarding selection (required for new businesses), Settings
edit (OWNER/ADMIN), a typed capability-hint resolver for future phases, RLS/grants,
audit-event coverage, tests.

**Out of scope (explicitly, per phase instructions).** Barcode/product-identifier
fields, POS/checkout, industry packs, multi-category/many-to-many, tenant-authored
categories, subscription/plan gating by category, legal-entity-type collection.

**Success criteria.**
- New businesses cannot complete onboarding without a valid category.
- Existing businesses remain valid with `primary_category_id = null` (no backfill
  forces a wrong guess).
- Category can never bypass permissions (`business.manage` gates every write) or
  alter subscription entitlements.
- OTHER requires a bounded, server-validated, plain-text custom label; never
  interpreted as HTML.
- Capability flags are hints only, centrally defined, typed, and documented as
  non-authoritative.

## 02 — Technical Design Document

**Pattern reused:** the country/currency precedent (`lib/business/country-currency.ts`,
`supabase/migrations/20260909080000_business_country_currency.sql`) — "the stable
code, not the label, is the stored identity." Unlike country/currency (a hardcoded TS
catalog, no table), category needs a **registry table** because platform staff must be
able to add categories later without a code deploy, and `expense_categories`
(`20260827080000_create_expense_categories.sql`) is the closest existing table shape,
adapted from business-scoped to **platform-global** (no `business_id` column; one
shared catalog, not one per tenant).

**Write-path boundary.** `businesses` INSERT has exactly one path: the
`create_business` SECURITY DEFINER RPC (owned by `private_business_creator`, no
INSERT grant/policy exists for `authenticated` at all — see prior phase's boundary
hardening migration). `primary_category_id`/`custom_category_label` are added to that
RPC's parameter list (DROP + CREATE, every existing side effect — trial issuance,
audit event, notification, owner-membership trigger — carried forward verbatim, per
this repo's own explicit convention for SECURITY DEFINER signature changes).
Post-creation UPDATEs use a new narrow SECURITY DEFINER RPC,
`update_business_category` — unlike timezone's plain direct-table-update pattern,
category validity requires a join against the registry table's `is_active` column,
which this repo does not express as a table CHECK; see 05 for the full rationale.

**Registry access.** `business_categories` is read via plain RLS-gated PostgREST
select (`authenticated`, all rows — active and inactive, since an inactive category
must still render its label on a business that already holds it; the app layer filters
to `is_active` for picker options). No INSERT/UPDATE/DELETE for `authenticated` —
platform-defined only, seeded via migration, `service_role` only for future write
tooling.

**Capability foundation.** A single typed module, `lib/business/category-capabilities.ts`
— `CATEGORY_CAPABILITIES: Record<CategoryCode, CategoryCapabilities>`, pure, no DB
round trip. Explicitly documented as **hints/defaults only, never authorization** —
mirrors the phase instructions' repeated warning. No resolver engine, no per-category
if/else scattered through the app; every future phase reads this one table.

## 03 — App Flow & State Map

**Onboarding** (`app/onboarding/page.tsx` → `CreateBusinessForm`): existing
name/slug/country/timezone steps, +1 field — Category (searchable `Select`, ~14
options + Other). Selecting Other reveals a required "Describe your business" text
input (2–100 chars). Submit is blocked (schema `safeParse` failure, same
`ActionState.fieldErrors` shape as every other field) without a valid category, and
without a custom label when Other is chosen. Error/loading/pending states reuse the
existing form's `useActionState` pending/error rendering — no new state machine.

**Settings** (`app/[businessId]/settings/business/page.tsx`): new "Category" card,
same Card/Form/Server-Action shape as the existing Timezone card. Loading = page-level
Suspense already in place; error = inline `role="alert"` text; empty is not reachable
post-1Q-A because onboarding now requires a category (existing pre-1Q-A businesses show
"Not set" and a picker to set one for the first time — the same picker, no separate
"first set" vs. "change" UI).

**Category load failure** (registry fetch errors): settings/onboarding both render a
plain "Couldn't load categories, try again" message — no raw Postgres/RPC error text
surfaced (checklist item 60).

## 04 — UI/UX Design Brief

Reuses the existing shadcn `Select`/`Label`/`Card`/`Button` primitives and the
Apple-liquid-glass tokens already in place on onboarding/settings — no new visual
system. ~14 options is small enough for a plain `Select` (not a combobox/command
palette) to stay keyboard- and mobile-usable without scrolling fatigue; each option
shows name + one-line description via a `SelectItem` two-line layout, consistent with
existing Select usage elsewhere in the app (e.g. country select already shows name +
code). The OTHER conditional input has its own `<Label htmlFor>` (not a placeholder
standing in for a label), gets `aria-invalid`/associated error text exactly like every
other field on the form, and its value is always rendered as plain text (React's
default escaping — never `dangerouslySetInnerHTML`) everywhere it is displayed
(Settings, onboarding confirmation, any future internal-admin display).

## 05 — Backend & Data Design

```sql
public.business_categories (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code = upper(code) and code ~ '^[A-Z_]{2,40}$'),
  name        text not null check (length(name) between 2 and 100),
  description text     check (description is null or length(description) <= 200),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
)
```
RLS: `select` for `authenticated` (`using (true)` — non-sensitive reference data); no
insert/update/delete grants for `authenticated` at all. `service_role` full access.

```sql
alter table public.businesses
  add column primary_category_id uuid references public.business_categories (id),
  add column custom_category_label text
    check (custom_category_label is null or
           (length(btrim(custom_category_label)) between 2 and 100));
```
Nullable — existing businesses are never force-backfilled or defaulted to a guessed
category (phase instruction §9/§61). `custom_category_label` is meaningful only when
the selected category's `code = 'OTHER'`; enforced at the RPC/Server-Action validation
layer (not a table CHECK, since a CHECK can't join to read the referenced category's
code without a function call — kept as an application-layer invariant, consistent with
this repo's stated preference to keep CHECKs to single-row predicates where
practical).

**Grants:** `grant update (primary_category_id, custom_category_label) on public.businesses
to authenticated` (existing `businesses_update` RLS policy — `business.manage` — is
the enforcement boundary; the column grant alone does not widen who can write, only
what an already-authorized writer may touch).

**Seed (14 categories total, including OTHER):** RETAIL, WHOLESALE, RESTAURANT, FASHION, PHARMACY,
ELECTRONICS, GROCERY, BEAUTY, SERVICES, LOGISTICS, AUTO_PARTS, GENERAL_TRADING,
MANUFACTURING, OTHER — directly mirrors the phase instructions' own example list,
within the recommended 10–20 range, deterministic `sort_order`.

**Inactive-category semantics.** Deactivating a category (`is_active = false`) never
deletes or renumbers it: the row, and any business's existing assignment to it, remain
readable indefinitely for historical display. An inactive category is excluded from
every SELECTABLE picker (onboarding, Settings) going forward — `listActiveBusinessCategories`
filters to `is_active` for that purpose — but a business already assigned to it keeps
that value, shown as its current category, until an authorized user replaces it with an
active one. `update_business_category` (the RPC) rejects any new assignment to an
inactive category regardless of what the client sends, so the picker's exclusion is a
UX convenience on top of a backend-enforced rule, not the enforcement boundary itself.

**Audit & update path — revised from the timezone precedent.** Unlike timezone
(a pure per-row predicate, safe as a table CHECK), category validity requires a join
against `business_categories.is_active` — not expressible as a reliable row-level
CHECK — and this repo's own established convention (`private.record_audit_event`'s
header comment, `20260902090100_audit_permissions_and_writer.sql`) is that audit
events are written by the trusted mutation RPC's own function body in the same
transaction, never by a generic trigger layered on top of a plain client `.update()`.
So the category update path is a small new SECURITY DEFINER RPC,
`public.update_business_category(p_business_id, p_category_code,
p_custom_category_label default null)`, owned by a new narrowly-scoped role
`private_business_category_writer` (NOLOGIN NOINHERIT BYPASSRLS, mirroring
`private_business_creator`) — it re-derives the caller via `private.current_uid()`,
re-checks `private.has_permission(business_id, 'business.manage')` itself (RLS is
bypassed by this role, so this check IS the enforcement boundary for this RPC, not
defense-in-depth on top of a policy), validates the category exists and `is_active`,
enforces the OTHER/custom-label pairing, performs the update, and records
`business.category_updated` via `private.record_audit_event` — atomically, in the
same transaction. No new `grant update (primary_category_id, custom_category_label)
on public.businesses to authenticated` is needed as a result (the RPC is the sole
write path for this column, matching `create_business`'s own INSERT boundary — no
direct-table-update grant exists for it either).

## 06 — Engineering Implementation Plan

1. Migration `20261005080000_create_business_categories.sql` — table, RLS, grants, 14-row seed.
2. Migration `20261005080100_business_category_columns.sql` — `businesses` columns (nullable FK + custom label, no write grants to `authenticated`).
3. Migration `20261005080200_create_business_rpc_category_support.sql` — DROP+CREATE `create_business` (5→7 args: `p_category_code`, `p_custom_category_label`), carrying forward every existing side effect; plus new `update_business_category` RPC + its writer role.
4. `lib/validation/business.ts` — `BusinessCategoryCodeSchema`, extend `CreateBusinessSchema`, new `UpdateBusinessCategorySchema`.
5. `lib/business/category-capabilities.ts` — typed capability-hint map (new file).
6. `lib/business/categories-dal.ts` — `listBusinessCategories()` (returns the full category registry, active and inactive, so historical assignments remain resolvable/displayable), `listActiveBusinessCategories()` (filters to active-only, for pickers presenting newly selectable categories), `getBusinessCategoryLabel()` (resolves a stored category id to its display label, incl. inactive/unknown fallback).
7. `lib/business/actions.ts` — extend `createBusiness`; add `updateBusinessCategory`.
8. `lib/business/dal.ts` — extend `getBusinessDetails` select + type.
9. `components/onboarding/create-business-form.tsx` — category Select + OTHER conditional field.
10. `components/settings/business-category-form.tsx` (new) + wire into `app/[businessId]/settings/business/page.tsx`.
11. `supabase gen types typescript --local` after `supabase db reset`.
12. Tests: `tests/integration/business-categories.test.ts` (registry read/write-restriction), extend `create-business.test.ts`/timezone-precedent tests for category creation + update ACL.
13. Internal-admin display: **deferred**, see Release Criteria note below — read-only, low-cost, correctly scoped as optional by the phase instructions; not implemented in this pass due to time budget, tracked as a NEXT ACTION, not silently dropped.

Every task traces to PRD requirements above (Traceability gate). Loading/empty/error/
permission-denied states are covered in 03. Enforcement (05) is server/RLS-side, never
UI-only.

## Pre-Codex completion pass — final decisions (supersedes the RPC-optional design above)

This section documents the outcome of the pre-Codex-review completion pass over the
draft above. It is authoritative where it conflicts with 02/05/06.

**Category is now REQUIRED at the `create_business` RPC boundary, not merely at the
onboarding form.** The earlier draft (`20261005080200_create_business_rpc_category_support.sql`,
first cut) left `p_category_code` optional at the RPC — enforcing "required" only via
the UI/Zod schema — on the reasoning that dozens of unrelated test fixtures call
`create_business` directly. That is a UI-only gate on a boundary
(`create_business`) that is otherwise the SOLE write path into `businesses`
(`private_business_creator` holds the only insert grant); a UI-only rule there is
trivially bypassed by any direct RPC caller, so it was tightened in this pass:
`p_category_code` is now validated as required and non-empty inside the RPC body
itself, exactly like country/currency. No signature change was needed (still 7
args, same order/defaults) — only the validation logic changed, avoiding any
PostgREST overload-resolution risk.

- **create_business signature — before this pass:** `(p_name text, p_slug text,
  p_country_code text default 'NG', p_currency_code text default null, p_timezone
  text default null, p_category_code text default null, p_custom_category_label
  text default null)` — `p_category_code` optional, null left `primary_category_id`
  null.
- **create_business signature — after this pass:** identical parameter list and
  defaults (no overload created), but the function body now raises
  `BUSINESS_CATEGORY_REQUIRED` when `p_category_code` is omitted or blank, and
  `INVALID_BUSINESS_CATEGORY` when it does not resolve to an active registry row.
  A default of `null` is kept (not removed) purely so omitting the argument still
  reaches the same explicit, fail-closed error rather than a raw missing-argument
  error from PostgREST.

**Legacy compatibility is unaffected.** This is a validation-only change on new
inserts; it does not touch existing rows, add a NOT NULL constraint, or backfill.
`tests/integration/business-categories.test.ts` — `legacy null-category business
compatibility` — proves a business with `primary_category_id = NULL` (simulated by
writing directly to the row, since `create_business` itself can no longer produce
one) remains fully readable and that normal tenant authorization
(`update_business_category`) still works against it.

**All direct-RPC callers were updated.** A repo-wide scan found 39 direct
`client.rpc("create_business", …)` call sites across integration tests, e2e specs,
`lib/business/actions.ts`, and `scripts/verify-phase1g-upgrade.mjs`. All but the
production caller (which already supplied the user's real selection) were fixture/
test setup code with no reason to know about category; each was updated to pass
`p_category_code: "GENERAL_TRADING"` (a seeded, always-active, non-OTHER category),
except `business-categories.test.ts`'s own category-focused tests, which use the
category actually being tested, and two new negative tests that deliberately omit
or blank the field.

**Dependency audit investigation — resolved, no hotfix phase needed.**
`git status --short package.json pnpm-lock.yaml` is clean (last touched by commit
`a6071fd`, the 1S-SEC1 Next.js security patch) — there is no uncommitted dependency
WIP contaminating the audit. `pnpm.cmd list next sharp js-yaml uuid --depth 10`
confirms `next@16.3.6` and `sharp@0.35.4` are installed, matching the 1S-SEC1 frozen
state exactly. `pnpm audit --prod` reports **0 vulnerabilities** — the production
dependency tree (`next`, `sharp`, `react`, `@supabase/*`, `drizzle-orm`, `postgres`,
`zod`) is clean. The full `pnpm audit` (including devDependencies) reports 12
advisories (9 moderate, 3 high), but every one of them traces through the `shadcn`
CLI devDependency's own transitive tree (`@modelcontextprotocol/sdk` → `hono`,
`undici`; `express-rate-limit`/`socks` → `ip-address`; `@dotenvx/dotenvx` →
`undici`) — none of these packages ship in the production build or handle any
request path in this app; `shadcn` is a local code-generation CLI invoked by
developers, never imported by application code. Root cause relative to 1S-SEC1:
newly published advisories in `shadcn`'s own dev-only dependency chain, unrelated
to Next.js/Sharp and unrelated to 1Q-A. **No new security-hotfix phase is
required.**

**Internal-admin category display:** still deferred, per the original phase scope
(optional). No change from the draft above.

**Browser/QA evidence — captured in the final QA + security pass.** All of the
following now have direct evidence, closing the UNKNOWNs the section above left
open:

- **Onboarding E2E** (`tests/e2e/business-category-industry.spec.ts`): a real
  signup → email-confirm (Mailpit) → onboarding flow proves the category control
  is visible, submit stays disabled without one, a keyboard-only user can select
  RETAIL, and OTHER requires a bounded 2–100 char label before submit enables.
  Both flows complete, land on the dashboard, and the persisted category is
  re-verified via the Settings page (the normal application surface, not a SQL
  read) both immediately and after a hard reload.
- **Settings E2E**: an authorized user changes an existing business's category
  and it persists across reload; switching OTHER → a normal category is proven to
  clear `custom_category_label` (the UI/server-contract agreement this phase's
  own instructions called out as the important regression); a VIEWER (no
  `business.manage`) gets the not-found boundary with no category control
  rendered (UI-surface signal only — `tests/integration/business-categories.test.ts`
  remains the actual authorization proof); a legacy `primary_category_id = NULL`
  business (simulated via direct SQL, since `create_business` itself can no
  longer produce one) renders without crashing and can be categorized for the
  first time.
- **Existing onboarding E2E regression**: `business-country-onboarding.spec.ts`,
  `business-country-visual-qa.spec.ts`, and `signup-to-dashboard.spec.ts` all
  drive the real onboarding form and needed a category selection added now that
  it's required — done, and all pass (`signup-to-dashboard.spec.ts` has one
  pre-existing, unrelated failure — it looks for a "Sign up" button that the
  signup page has since renamed to "Create account"; it fails before ever
  reaching the category step and was not introduced by this phase).
- **Responsive QA**: 390/768/1280/1440 screenshots for both onboarding and
  settings (`qa-screenshots/qa-1qa-{onboarding,settings}-{width}-{light,dark}.png`,
  16 files), plus an explicit `scrollWidth <= clientWidth` assertion at every
  size (no page-level horizontal overflow) and a dedicated mobile-viewport check
  that the category popover's bounding box stays within the 390px viewport.
- **Dark/light QA**: captured at 390 and 1440 for both surfaces (same screenshot
  set above), via `page.emulateMedia({ colorScheme })` — the app's actual
  dark-mode mechanism (no manual toggle).
- **Accessibility evidence (automated, Playwright-only — no new dependency
  added, per this pass's own instruction)**: the category control and the OTHER
  field both resolve via `getByLabel` (a real `<label for>` association, not
  visual placement only); Tab reaches the trigger, Enter opens it, Escape closes
  it; the OTHER field has its own `id`. **Manual-only remainder, honestly
  flagged, not fabricated as verified**: color-contrast ratios, full
  screen-reader semantics (NVDA/VoiceOver), and WCAG-level conformance were not
  machine-checked — no `@axe-core/playwright` or similar was installed, by
  instruction.

**Two real defects found and fixed during this pass (frontend only — the
already-verified backend contract in the section above was not reopened):**

1. **Category Select showed the raw stored code, not the display name, on a
   fresh page load.** Base UI's `<Select.Value>` only learns an item's label
   once that item has actually mounted inside its (portal-rendered,
   closed-by-default) popup — so a business's existing category rendered as
   `"OTHER"` or `"GENERAL_TRADING"` instead of `"Other"` / `"General Trading"`
   until the user opened the dropdown once. Fixed in both
   `components/onboarding/create-business-form.tsx` and
   `components/settings/business-category-form.tsx` with an explicit
   `SelectValue` render-prop that looks the label up from the same `categories`
   list already in scope. This is a Base UI usage pattern, not a category-
   specific bug — it plausibly also affects this app's Country/Timezone Selects
   elsewhere, which is unchanged and untouched by this pass; flagged here as a
   residual, low-severity UI finding for a future cleanup pass, not fixed
   beyond the two components this phase owns.
2. **`AuthCard`'s title (`components/ui/card.tsx`'s `CardTitle`) renders a plain
   `<div>`, not a heading element** — so onboarding/login/signup pages have no
   semantic heading landmark for screen-reader navigation. Repo-wide (every
   `AuthCard`-based page), not category-specific, and out of scope to change in
   this pass; left as a residual accessibility UNKNOWN/finding, not silently
   fixed.

**Full 70-control security assessment**: run this pass, scoped to the
cumulative 1Q-A diff (registry, RPC pair, capability hints, category UI). See
the completion-pass chat report for the full PASS/FAIL/UNKNOWN/N/A table with
evidence; summary: no FAIL, all category-specific controls that apply have
cited evidence, remaining UNKNOWNs are account/production-setting items (MFA on
third-party accounts, deployed security headers, CI token scoping) that are
whole-app facts outside this feature's diff, not new gaps this phase
introduced.

**Internal-admin category display:** still deferred, per the original phase
scope (optional). No change from the draft above.
