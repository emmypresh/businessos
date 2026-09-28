# Phase 1N-C5 — CSV Export Foundation — Build Brief

Incremental phase on frozen reporting architecture (1N-C1–C4). Combined into
one lean document per the six-document system's "small work may combine
sections" rule — none of the six is omitted; each is stated below, some
deliberately short because they inherit the frozen architecture unchanged.

## 01 — Product Requirements

**Problem**: the four detailed reports (Sales & Revenue, Customers,
Inventory, Branches — 1N-C2/C3/C4) can only be viewed on-screen. Users
need to get report data out of the app for spreadsheets/accounting tools.

**Users**: business owners/managers holding `reports.view`.

**Scope (in)**: an "Export CSV" action on each of the four detailed
reports, generating the export server-side from the exact same
filter/date/branch/search/sort state currently on screen, bounded to a
10,000-row ceiling, with spreadsheet-formula-injection neutralization and
safe response headers, reusing existing `reports.view` authorization and
the existing report DAL/RPCs exactly — no parallel report logic.

**Scope (out, explicit)**: XLSX/PDF export, scheduled/email exports,
background-job export infrastructure, dedicated per-export rate limiting
(deferred — see Residual Risk), further export UX/accessibility polish
(1N-C6), platform-admin work (1O), any change to the underlying report
definitions, permissions, or international/currency/timezone architecture.

**Success criteria**: a `reports.view`-only caller can export each report
as a correctly-scoped, correctly-filtered CSV; a caller lacking
`reports.view`, an unauthenticated caller, and a cross-tenant/cross-branch
attempt can never obtain export data; no regression in the four existing
`/reports/*` screens.

## 02 — Technical Design

```
report screen state (preset/dateFrom/dateTo/branch/q/sort/dir)
  -> buildReportExportHref (lib/reports/report-table-links.ts)
  -> GET /[businessId]/reports/<report>/export
  -> requirePermissionOrNotFound(businessId, PERMISSION.REPORTS_VIEW)
  -> same DAL/RPC the on-screen report already uses
  -> collectAllReportRows (bounded pager, lib/reports/csv.ts)
  -> serializeCsv (RFC 4180 + formula neutralization)
  -> csvResponse (safe headers)
```

`REPORT_EXPORT_ROW_LIMIT = 10_000`, centralized in `lib/reports/csv.ts`.
No database migration and no new RPC — `supabase db reset` applies
cleanly with zero new migrations for this phase. Three of the four
exports (Customers, Inventory, Branches) page through their existing
frozen C3/C4 paginated detail RPCs via `collectAllReportRows`, which
fetches page 1, throws `ReportExportTooLargeError` immediately if
`totalCount` exceeds the ceiling (never fetching further pages, never
returning a partial CSV), and otherwise fetches the remaining pages
deterministically (ordered by each RPC's own allowlisted sort column plus
a stable id tiebreaker).

**Sales deviation (deliberate)**: the frozen C2 Sales & Revenue report has
no row-level, paginated, sortable, or branch-filterable data source — it
renders exclusively from `get_management_reporting_aggregate`'s UTC-day-
bucketed `sales_trend`. There is no per-sale-transaction RPC anywhere in
this codebase to reuse, and this phase's own architectural rule is to
reuse existing report primitives rather than add a new migration for an
export-only concern. The Sales export therefore reuses the exact same
daily rows the screen already shows — one row per UTC calendar day,
zero-activity days included, at most 366 rows (`MAX_REPORT_RANGE_DAYS`) —
always far under the 10,000-row ceiling, so no pagination is needed there
at all. This is documented in the route's own header comment
(`app/[businessId]/reports/sales/export/route.ts`).

## 03 — App Flow & State Map

Each report screen renders an "Export CSV" link whose `href` is built by
`buildReportExportHref`, mirroring the exact preset/dateFrom/dateTo/
branch/search/sort/direction state currently on screen and **deliberately
omitting `page`** — export is never limited to the currently displayed
page. Clicking it is a normal browser navigation/download (`<a href>`,
no client-side JS required to trigger it), so there is no new client
state machine: **success** (CSV downloads), **too-many-rows** (413, plain
JSON error body), **invalid filter/branch** (400), **unauthorized**
(404, or a redirect to `/login` if unauthenticated — see §05).

## 04 — UI/UX Design Brief

An explicit-text "Export CSV" link (never icon-only) with a `lucide-react`
`Download` icon marked `aria-hidden`, using the existing `buttonVariants({
variant: "outline", size: "sm" })` styling, placed in each report's
`PageHeader` `actions` slot next to the "Back to Reports" breadcrumb —
same header row as the rest of each report's own controls. It is a plain
anchor element: keyboard-focusable and activatable with no custom
JavaScript handler, so it works identically with JS disabled. Error
responses (413/400) are returned as plain JSON with a human-readable
`error` message and no stack trace or internal detail — there is
currently no dedicated inline error UI for a failed download beyond the
browser's own handling of a non-download response; this is accepted for
C5's foundation scope and may be revisited in C6.

## 05 — Backend & Data Design

Every export route independently re-checks `reports.view` via
`requirePermissionOrNotFound` before any other work, exactly like each
report's own page — direct URL access is exactly as safe as arriving from
the screen. `requirePermissionOrNotFound`'s own `requireUser()` step
redirects an unauthenticated caller to `/login` (never serving export
data); an authenticated caller who lacks `reports.view` gets a fail-closed
404 via `notFound()`. Branch IDs are validated as UUIDs and then checked
for existence within the *requesting* business via
`listReportBranchOptions` — a foreign or unknown branch ID is rejected
with 400, never silently ignored or broadened to "all branches." Sort/
direction inputs go through the same strict Zod enum allowlists each
report's on-screen query parser already uses — no arbitrary column name
ever reaches SQL. No parallel report SQL exists anywhere in this feature.

Money is exported as a plain numeric value plus a separate ISO currency
code column (never a formatted symbol string), consistent across all four
exports. Dates are ISO date-only (`YYYY-MM-DD`), always UTC-derived. CSV
cells are RFC 4180-escaped (`lib/reports/csv.ts:escapeCsvCell`); any
free-text/user-controlled field (names, phone/email, SKU, branch code)
additionally goes through `sanitizeSpreadsheetCell`, which prefixes a
single quote onto any value starting with `=`, `+`, `-`, `@`, a tab, or a
carriage return, so it opens as inert text rather than an executable
spreadsheet formula — genuinely numeric fields (money, counts) are never
passed through this function, so a real negative number stays numeric.
Filenames are built from fixed literal parts plus ISO date-only strings
only (`safeCsvFilename`), never raw business/user text, with every part
re-sanitized to `[A-Za-z0-9-]` regardless — a crafted part can never
inject extra response headers via `Content-Disposition`. Responses set
`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment`,
`Cache-Control: private, no-store` (the payload may hold customer/business
data and must never be shared/public-cached), and
`X-Content-Type-Options: nosniff`. Customer exports include phone/email
(already operationally exposed by the C3 screen) but never auth user IDs,
tokens, or internal metadata. Inventory exports never compute a valuation
(no cost × quantity column exists in the underlying report to attach one
to). An over-limit match throws `ReportExportTooLargeError`, mapped to a
413 in every route's own catch block — never a partial CSV, never a
generic 500.

## 06 — Engineering Implementation Plan

1. Inspect frozen reporting architecture (DAL, RPC/pagination precedent,
   branch/search/sort allowlists, error-mapping convention) — done.
2. Shared CSV serializer (`lib/reports/csv.ts`): escaping, formula
   neutralization, filename builder, response builder, bounded pager —
   done, 32 unit tests (`lib/reports/csv.test.ts`), covering comma/quote/
   newline escaping, formula-injection neutralization for `=`/`+`/`-`/`@`/
   tab/CR-prefixed values with genuine negative numbers left untouched,
   Unicode preservation, filename injection stripping, response headers,
   and the row-limit boundary (below/at/above `REPORT_EXPORT_ROW_LIMIT`).
3. Four export routes + `buildReportExportHref` query-state helper +
   "Export CSV" UI action wired into all four report pages — done.
4. `supabase db reset` — confirmed clean, zero new migrations.
5. Full quality gates — `pnpm test` (1145/1145), `pnpm test:integration`
   (1680/1680), `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm audit
   --prod` (no known vulnerabilities), `git diff --check` — all green.
6. E2E (`tests/e2e/reports-export.spec.ts`): action visibility/
   accessible-name/real-download for all four reports; `reports.view`-
   denied caller (404); unauthenticated caller (redirected to `/login`,
   never CSV — verified with `maxRedirects: 0` and by inspecting the
   followed response is genuinely the login page); cross-tenant export
   attempt (404, no leaked business ID); foreign-business branch ID (400);
   invalid non-UUID branch ID (400); response headers; a
   below-the-ceiling error-mapping regression guard (200) — done, plus
   regression run of `reports-sales.spec.ts` / `reports-customers-
   inventory.spec.ts` / `reports-branches.spec.ts` (48/48 passing, no
   regression).
7. Real-filtered-export coverage (Codex follow-up, C5 review LOW #1):
   extended the filtered-export E2E to drive a real Branch A/Branch B
   selection through the actual rendered `<Select>` (never
   `page.goto`/`evaluate`/a hand-built `?branch=` URL), seeded with real
   branch-scoped sale/customer fixtures via the sanctioned
   `createBranchAssignedMember` invite-then-reassign pattern (the OWNER
   can never operate at a second branch — CANNOT_MANAGE_SELF), combined
   with a real custom date range, search, and sort — asserting the export
   `href`'s full query state, the downloaded CSV's header row, UTF-8
   content, Branch-A-plus-search-match inclusion, and both the
   Branch-A-but-search-excluded and Branch-B-only exclusions — done; the
   full `reports-export.spec.ts` suite (this test plus the rest of step
   6's coverage) is 12/12 passing.
8. Feature-scoped security review (`vibe-code-security-auditor`,
   read-only) and 70-control assessment (`app-launch-security-70`) — done,
   no findings against tenant isolation, IDOR, formula/header/filename
   injection, PII leakage, or sort/filter allowlisting.
9. Codex review — APPROVE CODE, 0 CRITICAL/HIGH/MEDIUM, 2 LOW (this build
   brief's own absence, and the real-branch-selection E2E gap) — both
   addressed in this follow-up.

## Residual Risk (explicit, carried from the original review)

No dedicated per-export rate limiter exists yet — an export is more
expensive per request than a paginated screen RPC. The spec for this
phase explicitly defers rate-limiting infrastructure to Phase 1P/C6; the
interim mitigation is the 10,000-row ceiling plus independent
`reports.view` enforcement on every route. No global CSP/security-headers
config exists in `next.config.ts` either — pre-existing and app-wide, not
introduced by or specific to this feature, out of this phase's scope.
