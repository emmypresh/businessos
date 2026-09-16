# Phase 1N-B1 — Executive Dashboard KPI + Comparison Cards

## 1. PRD
Owners and members with `reports.view` need a compact, trustworthy 30-day comparison on the business overview. B1 renders only aggregate-backed values: completed-sales revenue, completed sales, AOV, cash collected, net cash flow, new customer records, returning customers, repeat customers, current inventory counts, and (when authorized) the WhatsApp follow-up queue count. It does not add charts, rankings, profitability, forecast, LTV, inventory valuation, or health scoring. Given `reports.view`, the user sees the last 30 UTC days beside the immediately prior equal-length range; without it, the pre-existing welcome view remains. Zero, missing prior, and unavailable values never show Infinity or NaN.

## 2. Technical design
The Server Component resolves `resolveComparableRange(resolvePresetRange(LAST_30_DAYS))`, then concurrently calls the frozen `getFinancialSummary` and `getManagementReportingAggregate` once for each period. No RPC, migration, raw-table query, client fetch, or cache persistence is added. The display-only helper uses `(current - previous) / abs(previous) * 100` only where the prior value is nonzero; zero prior is textually `No prior data`, and two zero values are `No activity in either period`.

## 3. App flow and state map
`/[businessId]` → membership and permissions → `reports.view` → four server DAL calls → KPI comparison view → real Financial overview link. No `reports.view` → unchanged welcome view and zero report calls. Aggregate failure reaches the existing route error handling. On small screens cards stack; semantic heading and link remain keyboard reachable. Optional WhatsApp count is omitted when the authorized aggregate returns `null`.

## 4. UI/UX brief
The existing cool neutral surface and single blue action remain. KPI cards use semantic section headings, tabular numerals, visible focus on the Financial overview link, text labels for every trend (not colour alone), and `sm`/`xl` grids that collapse to one column. Customer comparisons are a single divided card. Inventory is explicitly a current-state panel because the frozen aggregate defines it as current stock, not a historical time series.

## 5. Backend and data design
No backend change. All reads remain aggregate-only and authorized by the frozen RPC contracts: `reports.view` governs the page/RPC, and WhatsApp is non-null only when the RPC's own `whatsapp.view` gate passes. Completed-sales revenue/order count/AOV come from `sales_trend` (completed sales only); AOV is aggregate revenue divided by aggregate order count and zero for zero orders. Financial values retain `get_financial_summary` meanings. Customer and inventory labels retain the frozen definitions. No new stored data, keys, index, event, retention, or mutation exists.

## 6. Engineering plan
1. Add a pure, zero-safe comparison formatter and tests. 2. Load frozen current/previous ranges server-side. 3. Replace the overview's mixed snapshot with B1 comparison cards and current-only inventory/optional WhatsApp. 4. Test permission path, content, optionality, responsive classes, and calculation states. 5. Run scoped lint/type/test/build/diff/frozen-scope gates. Rollback is removal of these UI-only files/props; no data recovery is needed.

## Security 70-control build-gate matrix
1-3 PASS no secrets or environment access added; 4-9 PASS existing page/RPC `reports.view`, membership, tenant and least-privilege controls retained; 10-13 UNKNOWN deployed debug, CI and Git-history posture; 14-18 PASS server-only DAL, no new input or query; 19 PASS React escaping, 20 N/A no state change, 21-23 N/A no upload/path/fetch; 24-26 PASS no auth/session change, 27-30 UNKNOWN deployed CORS/rate/staging/vendor posture; 31-32 N/A no webhook/payment; 33-35 PASS aggregate-only authorized access, UNKNOWN deployed log retention; 36-38 UNKNOWN deployed artifacts/dependency provenance; 39-40 N/A no AI; 41 PASS frozen reader role, 42 N/A no sensitive change; 43-48 UNKNOWN deployed monitoring/backups/headers/cookies/TLS; 49 PASS unchanged RPC tenant isolation; 50 PASS focused review/tests; 51-54 N/A no update/shell/deserialization/OAuth; 55 UNKNOWN MFA posture; 56 PASS no auth response; 57-59 N/A no state transition; 60-62 UNKNOWN CI/CD; 63 PASS absent permission produces no report calls; 64 PASS bounded frozen ranges; 65-67 N/A no AI; 68-70 N/A no browser-secret/redirect/realtime change.

**Release decision:** PASS WITH FIXES pending local verification. Deployed-state UNKNOWN controls require deployment preflight; MR-001 remains unchanged follow-up work.
