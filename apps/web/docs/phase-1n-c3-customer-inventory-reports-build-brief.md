# Phase 1N-C3 — Customer & Inventory Detailed Reports — Build Brief

Incremental phase on frozen reporting architecture. Combined into one lean
document per the six-document system's "small work may combine sections"
rule — none of the six is omitted; each is stated below, some deliberately
short because they inherit the frozen architecture unchanged.

## 01 — Product Requirements

**Problem**: the Reports workspace (1N-C1/C2) has Sales & Revenue detail
but no customer- or inventory-level detail beyond dashboard summary cards.

**Users**: business owners/managers holding `reports.view`.

**Scope (in)**: two new detail report pages — Customer, Inventory — each
with a KPI summary, one chart, a sortable/searchable/paginated detail
table, empty states, and branch/date-range filtering reusing the existing
Reports workspace controls.

**Scope (out, explicit)**: CSV export (1N-C5), Branch detailed report
(1N-C4), inventory valuation (cost × quantity — deferred per prior 1N-A
decision), predictive/LTV customer scoring, any schema/permission-model
change, any change to international currency/timezone/activation
architecture (1Q-0A–D, frozen).

**Success criteria**: a `reports.view`-only caller (no `customers.view`,
`sales.view`, `inventory.view`, or `products.view`) can load both reports
and see real, correctly-scoped, correctly-classified data; cross-tenant
and cross-branch isolation hold; no regression in the existing
`/reports`/`/reports/sales` routes.

## 02 — Technical Design

Two new `SECURITY DEFINER` Postgres functions
(`get_customer_detail_report`, `get_inventory_detail_report`), mirroring
`get_financial_summary`'s established precedent exactly: a shared
`private_reports_reader` `BYPASSRLS` role with narrow, explicit
column-level grants; `[from, to)` UTC half-open range validation;
`reports.view`-only authorization (re-checked inside the function,
independent of the page-level check); business currency derived from
`businesses.currency_code`; an optional `p_branch_id` that only narrows
results (customers themselves are not branch-scoped, so the filter
applies to the sales/inventory-location join, never to the customer/
product row set itself). Sort key and direction are resolved through a
hardcoded `plpgsql` `CASE` allowlist before being passed to
`format('%I %s ... limit %L offset %L', ...)` — never the raw client
string. Pagination is server-clamped to `[1, 100]` rows/page.

Two DAL wrappers (`lib/reports/customer-report.ts`,
`lib/reports/inventory-report.ts`) parse/validate query params with Zod
and call the RPC via the existing `createClient()`/`requireUser()`/
`mapDatabaseError` convention — no new client-side data fetching, no
client-side aggregation of raw rows.

No schema migration beyond the two new functions' own grants — reuses
`customers`, `sales`, `sale_items`, `products`, `inventory_balances`,
`inventory_ledger`, `inventory_locations`, `business_branches`,
`businesses` exactly as they exist today.

## 03 — App Flow & State Map

`/[businessId]/reports` → "More reports" → `Customers` /
`Inventory` links (range-query-string-preserving, same convention as
the existing `Sales & Revenue` link) → `/[businessId]/reports/customers`
/ `/[businessId]/reports/inventory`.

Each report page states: **pending** (no date range chosen yet — reuses
C1's own state), **error** (invalid custom range — reuses C1's own inline
error), **loaded-with-data**, **loaded-empty** (zero customers/products in
range, or a search with zero matches — each has its own distinct copy).
"Back to Reports" always preserves the active range query string.
Sort-column links and pagination Previous/Next links are plain
query-param-preserving `<Link>`s (no client-side state) — a fresh
server render on every interaction, consistent with C1/C2's own
architecture.

## 04 — UI/UX Design Brief

Reuses the ArchitectUI-style reporting system verbatim: `PageHeader` with
a "Back to Reports" breadcrumb, `DateRangePicker` (branch + preset/custom
range), KPI cards using the existing `--kpi-*-bg/-fg` token pairs (blue,
emerald, purple, orange, cyan for positive/neutral states;
`bg-destructive/10 text-destructive` for the one true alert state,
Out of Stock), one horizontal-bar-list chart per page (Top Customers by
Revenue / Top Products by Units Sold — capped at 5 rows, every value also
printed as text so the chart is its own accessible fallback), a
`<table>` with real `<caption>`/`scope="col"` headers and
`aria-label`-described sort links, and a GET search form. The one
CardHeader layout gap found in QA (search form overflowing at 390px) was
fixed: `CardHeader` now stacks `flex-col` on mobile and goes `flex-row`
at `sm:`, with the search `Input` full-width on mobile.

## 05 — Backend & Data Design

See §02 for the RPC design. Data model: no new tables/columns. Access
rule: `reports.view` is the ONLY permission checked, both at the page
layer (`requirePermissionOrNotFound`) and inside each RPC
(`private.has_permission`) — never `customers.view`/`sales.view`/
`inventory.view`/`products.view`. Customer privacy: only `name`, `phone`,
`email` are exposed (no auth identifiers, no internal metadata). No
event/webhook surface is touched.

## 06 — Engineering Implementation Plan

1. Inspect frozen reporting architecture (DAL, RPC precedent, branch
   authorization model, schema) — done.
2. Write + apply the two RPC migrations against a real local DB; fix
   real bugs surfaced by `supabase db reset` (`stable`/temp-table
   conflict; a missing `sales.id` grant) — done.
3. Write 11 integration tests covering permission gating, aggregate
   correctness, cross-tenant isolation, range validation, pagination
   bound, and stock-status classification — done, all passing; also
   updated one pre-existing least-privilege regression test
   (`branch-aware-acl.test.ts`) to reflect the new, narrowly-justified
   grant additions — done.
4. DAL wrappers + Zod validation — done.
5. Page routes, KPI cards, table, empty states, nav wiring — done.
6. One chart per page — done.
7. E2E (permissions, KPIs, nav-link preservation, empty/search states,
   sorting) + regression run of `reports.spec.ts`/`reports-sales.spec.ts`
   — done, all passing (fixed 7 real locator ambiguities from the chart
   introducing duplicate visible text, and one real responsive bug at
   390px).
8. Visual QA — fresh screenshots at 390/768/1280/1440 for NG/GH/US, dark
   mode at 390/1440 — done, 28 screenshots in `qa-screenshots/`.
9. Full quality gates (`typecheck`, `lint`, unit, integration, `build`,
   `audit --prod`, `git diff --check`) — done, all green (see the
   REPORT BACK for exact evidence).
10. 70-control security assessment — done (see separate report).
