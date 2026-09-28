# Phase 1N-C6 — Export Security / Accessibility / Final Polish — Build Brief

Frozen base: `c3fef2cc1bf1df0089987a27f9b9d59b523d9fd0` (Phase 1N-C5).
Scope: hardening + polish only, no new report semantics, no new export formats,
no new DB migration. This is a lean, combined six-section brief (small,
diff-scoped change) — sections that are one line say why.

**C6-owned paths (authoritative, path-scoped diff surface):**
`apps/web/lib/reports/csv.ts`, `apps/web/lib/reports/csv.test.ts`, and this
file (`apps/web/docs/phase-1n-c6-export-security-accessibility-polish-build-brief.md`,
untracked/new). Exactly these three. This is **not** a claim that the working
tree contains only C6 files — the repository has substantial unrelated
tracked and untracked WIP already present on this branch (auth, legal,
branding, favicon, root layout/page, dashboard-shell, proxy, several
integration test files, screenshots, `debug.log`, WhatsApp docs, etc.). That
WIP is explicitly out of scope for C6, was verified untouched via
`git status --short` before and after this remediation, and is not
represented anywhere in this brief as C6's own work.

## 1. Product Requirements Document

Close the two residual export-security gaps C5 deliberately deferred
(leading-whitespace/control-character formula-injection bypass, and a
defensive max-page ceiling in `collectAllReportRows`), and re-verify every
other C5 control still holds after the change. Every other C5 requirement
(row ceiling, safe filenames, private/no-store, nosniff, branch validation,
authorization, accessible/consistent export buttons) is unchanged and stays
in force — this phase adds nothing new to the product surface.

## 2. Technical Design Document

Two changes, both in `lib/reports/csv.ts` (shared by all four export routes,
so the fix applies uniformly with no route-level changes needed):

- `sanitizeSpreadsheetCell`: previously only checked the literal first
  character against `=+-@\t\r`. A value like `" =SUM(A1:A2)"` (leading
  space) passed through unsanitized, and some spreadsheet CSV importers skip
  leading whitespace before deciding a cell is a formula. The function now
  strips a leading run of space/tab/vertical-tab/form-feed/NBSP before
  testing for `=+-@`, and still independently treats a literal leading tab
  or carriage return as dangerous on its own (unchanged behavior for that
  case). The quote prefix is always applied to the *original* raw string, so
  legitimate leading-space text is never otherwise altered.
- `collectAllReportRows`: added a **fail-closed** `maxPages` ceiling
  (`ceil(REPORT_EXPORT_ROW_LIMIT / REPORT_EXPORT_FETCH_PAGE_SIZE)` = 100),
  fixed and independent of any single RPC response. A first Codex review
  found that the initial version of this guard *clamped* the loop to
  `Math.min(totalPages, maxPages)` — which meant an inconsistent upstream
  response (e.g. `totalCount: 10,000`, reported `pageSize: 1`, implying
  10,000 required pages) would silently stop after 100 fetches and return
  only 100 rows as if that were the complete export. That has been
  corrected: the function now computes `requiredPages =
  ceil(totalCount / pageSize)` up front and, if `requiredPages > maxPages`,
  **throws `ReportExportTooLargeError` before fetching any further pages**
  — it never clamps and never returns a partial result silently. An honest
  totalCount/pageSize pair within `REPORT_EXPORT_ROW_LIMIT` can never
  trigger this (`requiredPages` tops out at exactly 100 for 10,000 rows at
  the standard 100-row page size, which is `not > 100` and so still
  succeeds). A second, independent check after paging completes —
  `rows.length < first.totalCount` — also throws rather than returning a
  short row set, covering the case where a page comes back short/empty
  before the declared total was reached even though the page-count math
  looked safe. `pageSize` itself is also now guarded with
  `Number.isFinite(...) && > 0` before any division/ceil, so a runtime 0,
  negative, NaN, or Infinity value can never produce unsafe paging math —
  it simply falls back to the standard page size.
  `ReportExportTooLargeError`'s message was generalized from "too many
  rows" to "cannot be completed safely" so it reads correctly for both the
  original over-the-row-limit case and this new can't-prove-completeness
  case, without ever exposing internal RPC/paging detail to the client.

No new types, no new response shapes, no new routes.

## 3. App Flow / State Map

Unchanged from C5. No new states, no new screens, no new branches in the
export flow — same GET-request-to-CSV-download flow for all four reports.

## 4. UI/UX Design Brief

No UI changes shipped. An aria-label addition per export button was drafted
and then reverted after checking it would silently change each button's
accessible name away from the exact string (`"Export CSV"`) the frozen C5
E2E suite (`tests/e2e/reports-export.spec.ts`) already asserts with
`toHaveAccessibleName`. The visible text already satisfies WCAG 4.1.2 (name
from content, non-empty, non-generic) and the surrounding page heading/
description already gives report-specific context, so no accessibility gap
was found that justified the regression risk of overriding it. Export button
visual/DOM consistency across all four reports was re-confirmed byte-for-byte
identical (see Engineering Plan §Accessibility below).

## 5. Backend & Data Design

No schema, table, RLS, or RPC changes. No migration.

## 6. Engineering Implementation Plan / Test Plan

**Changed files:** `lib/reports/csv.ts`, `lib/reports/csv.test.ts` (both new
tests only — no existing test was altered).

**Unit tests added:**
- 9 leading-whitespace/control-char formula-bypass cases (space, double
  space, tab, vertical tab, form feed, NBSP, all combined with `=`/`+`/`-`/`@`)
  — each asserted neutralized.
- A negative case confirming ordinary leading-space text is left untouched.
- A bare leading-CR-with-no-formula-marker case, confirming the existing
  literal-CR/tab rule still holds independent of the new whitespace-strip
  logic.
- An exact-multiple-of-page-size termination case for `collectAllReportRows`
  (4 rows / page size 2 → exactly 2 fetches, no extra empty-page call).
- **(A)** Exactly 10,000 rows at the standard 100-row page size (100
  required pages) still succeeds — proves the fail-closed guard doesn't
  reject the largest legitimate export.
- **(B)** `totalCount` at the row limit with an inconsistent `pageSize: 1`
  (10,000 required pages) **throws**, rejected on page-1 metadata alone —
  proves no silent truncation and no wasted extra fetches.
- **(C)** `totalCount: 5,000` (well under the row limit) with
  `pageSize: 1` (5,000 required pages) also **throws** — proves the guard
  is about required page count, not just totalCount vs. the row ceiling.
- **(D)** A valid full 10,000-row export never fetches page 101 or beyond.
- **(E)** A normal, well-under-ceiling multi-page export still succeeds
  exactly as before.
- **(F)** A backend that returns fewer rows than its own declared
  `totalCount` (an empty final page instead of the expected rows) throws
  rather than returning the short row set as if it were complete.
- A `pageSize` of `0`, `-1`, `NaN`, and `-Infinity` each safely fall back to
  the standard page size rather than producing unsafe division/ceil math.

**Full unit suite:** 85 files / 1164 tests, all passing (includes the 51
`csv.test.ts` cases above).

**Typecheck:** `tsc --noEmit` — clean.

**Lint:** `eslint` — clean.

**Production build:** `next build` — succeeds; all four
`/[businessId]/reports/*/export` routes report as `ƒ` (dynamic,
server-rendered on demand), confirming no export route can be statically
cached.

**Dependency audit:** `pnpm audit --prod` — no known vulnerabilities.

**E2E:** `tests/e2e/reports-export.spec.ts` (12 tests: visible/keyboard-
focusable/real-download for all four reports, denied-permission 404,
unauthenticated redirect, cross-tenant 404, foreign-branch 400,
invalid-branch 400, response-header consistency, real filtered
branch+search+sort download content, below-ceiling 200 regression guard) —
all 12 passing against a fresh build containing this diff, run against the
real local Supabase stack (not mocked).

**Integration suite:** a broader `pnpm test:integration` run (see the audit
report for detail) surfaced one pre-existing failure in
`subscription-billing-foundation.test.ts` (`activates a trialing
subscription with a real price...`), a file this diff never touches and
which sits under the repo's own "unrelated WIP" (billing fixture work)
carve-out. Not attributable to this change; not fixed here per the C6 change
policy (hardening/polish only, no unrelated remediation).

**Accessibility:** re-verified all four `Export CSV` anchors are
byte-for-byte identical in structure (icon `aria-hidden`, visible text,
`buttonVariants({ variant: "outline", size: "sm" })`) — no drift, no
UI change made.

**Residual/deferred (Phase 1P, per the approved C5/C6 plan):**
- No shared rate-limiter exists in this codebase (`grep` for
  rate-limit/ratelimit infra returns only comments explicitly disclaiming
  one — see `lib/invoices/dal.ts:271`). Per the C6 plan's own instruction,
  no ad-hoc in-memory limiter was invented (it would be unsafe in a
  serverless/multi-instance deployment). Documented as Phase 1P debt.
- Global CSP/security-header rollout remains Phase 1P debt; only the
  export-response-specific headers (already frozen in C5, re-verified here)
  were in scope for C6.
- Paged export can theoretically observe data mutated between pages (stale/
  eventual-consistency read). Accepted at current launch scale, consistent
  with the rest of this report subsystem; no snapshot-transaction machinery
  introduced.
