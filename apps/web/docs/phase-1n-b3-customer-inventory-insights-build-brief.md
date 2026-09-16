# Phase 1N-B3 Customer + Inventory Insight Panels — build brief

## 1. PRD
**User/problem.** Owners/managers with `reports.view` need a trustworthy read of customer and inventory signals alongside the existing KPI/sales-trend dashboard, without any new or fabricated business logic.

**Scope.** Two presentational panels — `CustomerInsights` and `InventoryInsights` — rendered from the already-frozen `get_management_reporting_aggregate` payload. **Non-goals:** new migrations/RPCs, retention/churn/LTV/loyalty/health-score metrics, inventory value, reorder recommendations, product-name drilldown lists.

**Acceptance criteria.** Both panels render only the frozen `customerSummary`/`inventoryRisk` fields; zero states use the exact truthful copy specified; risk counts (out-of-stock/low-stock/unsold-with-stock) carry no success/increase styling; drilldown links to `/customers` and `/inventory` render only when the caller's already-loaded permission set includes `customers.view`/`inventory.view`.

**Risks/dependencies.** None beyond the frozen B1/B2/Phase-1N foundation; no new dependency.

## 2. Technical design
Server Component data flow only: `app/[businessId]/page.tsx` already loads `reporting`/`previousReporting` via the frozen DAL and `permissions` via `getPermissions`. Two new booleans (`canViewCustomers`, `canViewInventory`) are derived from that already-loaded `Set` — no new query, no widened authorization surface. `ManagementOverview` passes the relevant aggregate slices into `CustomerInsights`/`InventoryInsights`, which are pure, prop-only Server Components importing no Supabase/DAL/admin code.

## 3. App flow and state map
No new route. Within `/[businessId]`, the existing reports.view-gated management overview renders the two panels below the sales-trend chart. Each metric row independently shows its zero-state sentence when its count is 0, otherwise the frozen `formatComparison` label (customers) or a factual count sentence (inventory, no comparison — see risk semantics below). Drilldown links are simple `<Link>`s; no client interaction/state.

## 4. UI/UX brief
Matches the existing Card system (hairline `ring-1` cards, `tabular-nums` counts, 44px-minimum tap targets on links). Customer panel: calm, relationship-oriented, comparison-aware (reuses B1's `formatComparison`). Inventory panel: attention-oriented via icon (`AlertTriangle`/`PackageSearch`, `aria-hidden`) plus always-visible text — never color alone. No new chart added (B3 does not need one). Each metric always shows a one-line factual definition beneath its value so meaning never depends on a tooltip.

## 5. Backend/data design
No schema change, no new RPC, no raw-table query. Both components consume only the two typed slices (`customerSummary`, `inventoryRisk`) already returned by the frozen, `reports.view`-authorized `get_management_reporting_aggregate` RPC (`20260916090000_management_reporting_aggregates.sql`). No service-role/admin client is imported into any new file.

## 6. Engineering plan
1. Add `CustomerInsights`/`InventoryInsights` components. 2. Wire them into `ManagementOverview` in place of the prior inline Customer/inventory cards, threading two new boolean props. 3. Derive those booleans in `app/[businessId]/page.tsx` from the already-fetched `permissions` set. 4. Add/extend behavioral tests. 5. Run focused, B1/B2/Phase-1N regression, full unit, lint, typecheck, and production build. Rollback is removal of the two new component/test files and reverting the two edited files; no data/migration change to roll back.

## Build checklist evidence
Define/plan/build safely/experience: **PASS** by the sections above and the unchanged frozen data/authorization boundary. Local verification: **PASS** — lint (scoped + full), TypeScript, full unit suite (887 tests), and production build were run and are green (see main report). Production configuration, monitoring, and deployment smoke test: **UNKNOWN** (not accessible locally).

## Security 70-control matrix (build-gate)
See main report's SECURITY (70) section for the full per-control breakdown; summary: **PASS** for permission-derived drilldown gating, no-new-authorization, no-new-endpoint, output-encoding/no-fabrication controls that this presentational change touches; **N/A** for the large majority of controls (auth, payments, uploads, infra, AI/agent, CI/CD, etc.) that this UI-only change does not touch; **UNKNOWN** only for deployment/infrastructure controls this local session cannot observe.

Release decision: **PASS WITH FIXES (local build gate)** — application-code checks are green; deployment/infrastructure controls remain UNKNOWN pending deployment-owner evidence, unchanged from every prior Phase 1N brief.
