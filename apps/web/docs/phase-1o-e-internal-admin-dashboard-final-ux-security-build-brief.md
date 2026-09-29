# Phase 1O-E — Internal Admin Dashboard / Final UX & Security

Status: **COMPLETE for everything this phase's own instructions authorize.**
System Health and Settings remain explicitly deferred (see §04) — that is a
requirement of the phase brief, not a shortfall.
Frozen baseline: `6f5eda55997208cbb0efe6a4dd70392e6bb772a1` (branch `feature/expenses-financials`).

This is a lean, combined build brief (six sections in one document) — justified
because this pass is a visual/UX consolidation of an already-built, already-tested
authorization surface (1O-A–1O-D), not a new domain. Nothing here changes platform
authority; see §5 for the explicit "what did NOT change" list.

---

## 01 — Product Requirements Document

**Problem.** The internal admin console (1O-A–1O-D) is functionally complete but
visually minimal (a single `max-w-5xl` column, plain text nav, no KPI/overview
surface) and does not read as a "Super Admin" operations console distinct from the
tenant-facing product.

**Goal.** Redesign the console shell into a premium, dark-charcoal, violet/indigo-
accented operations console with real Overview, Businesses, Support, Subscriptions,
and Platform Audit surfaces — using only real, bounded, already-derivable data —
without changing any authorization boundary established in 1O-A–1O-D.

**Non-goals (explicitly out of scope, per the phase brief):** landing/marketing work,
1Q (POS/barcode/scanner), broadening any platform permission, a support-ticket system
that doesn't exist, a monitoring/uptime backend, arbitrary platform settings.

**Success criteria:** the console visually reads as a distinct "Platform Console" from
the tenant app; every number shown has a written, bounded definition; no existing
platform test regresses; every route's permission boundary is enforced identically
before and after the redesign; BILLING's least-privilege posture (no
`businesses.view`, no Support) is provably unchanged.

## 02 — Technical Design Document

- **Stack**: unchanged — Next.js App Router, Supabase Postgres + RPC, Tailwind v4
  tokens, shadcn/ui primitives (`Sheet`, `Select`, `Input` reused throughout), Lucide
  icons. No chart library exists in `package.json` and none was added — every
  summary panel uses plain `<dl>`/stat-tile markup instead of a bar/donut chart.
- **Read-only RPCs, migration 1** (`20261003080000_platform_dashboard_overview.sql`):
  `get_platform_dashboard_overview()`, `list_platform_recent_actions(page, page_size)`.
- **Read-only RPCs, migration 2** (`20261004080000_platform_audit_subscriptions_support.sql`):
  - `get_platform_dashboard_overview()` **re-defined** (`CREATE OR REPLACE`) to add
    one more counter, `canceled_subscriptions` — purely additive to the returned
    jsonb; every prior key's value and meaning is unchanged.
  - `list_platform_audit(page, page_size, action_type?, business_search?, date_from?, date_to?)`
    — platform-wide bounded read of `platform_action_audit`, gated on
    `platform.audit.view`. Collapses `before_state`/`after_state` into a safe
    plain-text `change_summary` server-side; never returns raw jsonb to the client.
  - `list_platform_subscriptions(page, page_size, search?, status?)` — gated on
    `platform.subscriptions.view`.
  - `list_platform_business_diagnostics(page, page_size, severity?, search?)` +
    `get_platform_support_summary()` — both gated on `platform.businesses.view`
    (reused, not a new `platform.support.view`). Diagnostics are computed **set-based
    across every business in one bounded pass** (a single CTE + `UNION ALL` of the
    seven frozen 1O-C diagnostic conditions), never one RPC call per business.
  - All six functions are owned by the **existing** `private_platform_directory_reader`
    role (1O-B) — no new role. One small additive grant was needed:
    `EXECUTE` on the existing `private.escape_ilike_pattern` (introduced in 1O-D for
    a different role) was also granted to this role, for the new search filters.
  - **Bug found and fixed during this pass**: the first draft of
    `list_platform_business_diagnostics` raised `column reference "business_id" is
    ambiguous` — its `RETURNS TABLE (business_id uuid, ...)` output parameter and a
    same-named CTE column collided inside PL/pgSQL. Fixed by qualifying every
    reference with its CTE alias (`stats.business_id`, `counted.business_id`, etc.).
    Caught by `tests/integration/platform-audit-subscriptions-support.test.ts`
    before this ever reached a page.
- **Design tokens**: unchanged from the shell-foundation pass — `.platform-shell` in
  `app/globals.css`, scoped to `components/platform/platform-shell.tsx` only.
- **Shell/nav**: `PlatformShell` now renders five permission-gated destinations
  (Overview, Businesses, Support, Subscriptions, Platform Audit) plus the existing
  Actions link — see §03/§04.
- **New primitive**: `PlatformPagination` (`components/platform/platform-primitives.tsx`)
  — one bounded Previous/Next pager shared by Audit, Subscriptions, and Support (used
  3 times, mirrors `business-directory-pagination.tsx`'s own established shape).
- **New filter components**: `AuditFilters`, `SubscriptionFilters`, `SupportFilters`
  (`components/platform/`) — client components pushing validated query params, same
  pattern as `BusinessDirectoryFilters`.

## 03 — App Flow & State Map

```
/internal/admin (layout)
 └─ requirePlatformAdmin() [role-only gate, unchanged from 1O-A]
     └─ PlatformShell (sidebar: Overview / Businesses / Support / Subscriptions /
                                Platform Audit / Actions*)
         ├─ /internal/admin                Overview      [platform.dashboard.view + AAL2]
         ├─ /internal/admin/businesses     Directory     [platform.businesses.view + AAL2] (1O-B, unchanged)
         ├─ /internal/admin/businesses/[id]              (1O-B/C/D tabs, unchanged)
         ├─ /internal/admin/support        Support       [platform.businesses.view + AAL2] (NEW)
         ├─ /internal/admin/subscriptions  Subscriptions [platform.subscriptions.view + AAL2] (NEW)
         ├─ /internal/admin/audit          Platform Audit[platform.audit.view + AAL2] (NEW)
         ├─ /internal/admin/actions*       Billing lookup (1O-D, unchanged)
         └─ /internal/admin/mfa            AAL2 challenge/enroll (unchanged)
```
`*` Actions link only rendered when the caller holds ≥1 controlled-action permission.
Businesses and Support share one permission (`platform.businesses.view`) and are
shown/hidden together in the sidebar.

**Still deferred, not routed** (no nav entry, no route file — a requirement of the
phase brief, not a shortfall): `/internal/admin/system-health`,
`/internal/admin/settings`.

## 04 — UI/UX Design Brief

**Visual language:** unchanged from the shell-foundation pass — dark-charcoal
(`#0c0c12`) fixed sidebar, violet/indigo primary accent, blue secondary accent,
white/cool-gray light canvas, near-black dark canvas. Every new page (Audit,
Subscriptions, Support) is built exclusively from the existing `PlatformPanel`/
`PlatformSectionHeader`/`PlatformStatCard`/`PlatformEmptyState`/`PlatformStatusBadge`/
`PlatformPagination` primitives — no separate visual language, no legacy markup.
Verified visually at 390/1440, light and dark, for all three new routes
(`apps/web/qa-1oe-{audit,subscriptions,support}-{390,1440}-{light,dark}.png`), on top
of the prior pass's 390/768/1280/1440 Overview/Businesses coverage.

**Navigation destinations, final state:**

| Destination | Status | Permission |
|---|---|---|
| Overview | Shipped | `platform.dashboard.view` (every role) |
| Businesses | Shipped (1O-B, restyled only) | `platform.businesses.view` |
| Support | **Shipped this pass** | `platform.businesses.view` (reused) |
| Subscriptions | **Shipped this pass** | `platform.subscriptions.view` |
| Platform Audit | **Shipped this pass** | `platform.audit.view` |
| Actions | Shipped (1O-D, restyled only) | any of suspend/reactivate/extend_trial |
| System Health | **Deferred, per-instruction** | No monitoring/uptime backend exists — a hardcoded number here is exactly the fake metric §18/§39 of this pass's own instructions forbid. The topbar's `NODE_ENV`-derived environment badge remains the one truthful signal. |
| Settings | **Deferred, per-instruction** | No real platform settings model exists — nothing to expose truthfully. |

**Terminology discipline (per §12 of this pass's instructions):** the Support page
is titled "Support" with a subtitle explicitly stating "Not a ticketing system", and
never uses the words "Ticket", "Case", or "Inbox" anywhere in its copy — every row is
one of the seven frozen 1O-C diagnostic codes.

**Empty states, final set:** "No platform actions found." / "No platform actions
match your filters." (Audit), "No subscriptions found." / "No subscriptions match
this view." (Subscriptions), "No businesses currently require attention." / "No
diagnostics match your filters." (Support) — plus every pre-existing empty state from
the shell-foundation pass.

**Accessibility — automated evidence (closes the prior UNKNOWN):**
`tests/e2e/internal-admin-audit-subscriptions-support.spec.ts`'s "accessibility
smoke" suite (Playwright's own role/ARIA queries — no axe or other a11y library is
installed, and per this pass's own instruction §33 none was added) checks, for every
new/updated route (`/internal/admin`, `/businesses`, `/support`, `/subscriptions`,
`/audit`):
- exactly one `<h1>` landmark heading,
- a `nav` and a `main` landmark present,
- every visible button has a non-empty accessible name,
- every visible form control (`input`/`select`/`textarea`, excluding elements
  genuinely hidden from the accessibility tree — `type="hidden"` or
  `aria-hidden="true"`) has a label via `<label for>`, `aria-label`, or
  `aria-labelledby`.

A second test verifies the sidebar's active link is keyboard-focusable and carries
`aria-current="page"`. A third verifies the mobile drawer (`Sheet`/Radix `Dialog`)
opens as a `role="dialog"`, contains the same nav, and actually closes on navigation.

**Two real defects were found and fixed by this automated pass, not just
documented:**
1. Every page-title heading in `/internal/admin/*` (Overview, Businesses, Business
   detail, Actions, Find-a-business) was an `<h2>`, breaking the app-wide convention
   (every other route in this codebase titles itself with an `<h1>` — e.g.
   `app/[businessId]/customers/page.tsx`). Fixed in
   `components/platform/platform-primitives.tsx` (`PlatformSectionHeader`) and the
   four page files that had their own inline `<h2>`.
2. That same fix incidentally exposed a latent brittleness in
   `tests/e2e/internal-admin.spec.ts` (a bare `getByText("Internal Administration")`
   became ambiguous against Next.js's own route-announcer element once a real `<h1>`
   with identical text existed) — fixed by scoping that assertion to
   `getByRole("heading", ...)`, which is what it was actually trying to prove.

**What remains manual** (honestly listed, not silently dropped): full WCAG color-
contrast audit beyond the design tokens' own AA verification (see `app/globals.css`'s
existing contrast-fix comments), screen-reader behavioral testing, and a full
axe-equivalent ruleset — none of which the current toolchain can verify without
adding a new dependency, which this pass's own instructions direct against doing
automatically.

## 05 — Backend & Data Design

**Every Overview metric** (unchanged from the prior pass, plus one addition):

| Metric | Definition |
|---|---|
| Total Businesses | `count(*) from businesses where status <> 'archived'` |
| Active Businesses | `count(*) where status = 'active'` |
| Suspended | `count(*) where status = 'suspended'` |
| Active Subscriptions | `count(*) from business_subscriptions where status = 'ACTIVE'` |
| Trialing | `count(*) where status = 'TRIALING'` |
| Past Due | `count(*) where status = 'PAST_DUE'` |
| **Canceled** (new) | `count(*) where status = 'CANCELED'` |
| New Businesses (7d) | `count(*) where status <> 'archived' and created_at >= now() - interval '7 days'` |

**Audit page fields** (`list_platform_audit`): `action_type`, `actor_email` (resolved
platform-wide — see §02's own note on why this differs from the Overview panel's
narrower choice), `target_business_name`, `reason` (rendered as plain text, never raw
HTML), `change_summary` (a computed plain-text sentence, e.g. `"status: active ->
suspended"` or `"trial ends: <ts> -> <ts>"` — **never** the raw `before_state`/
`after_state` jsonb), `occurred_at`. Filters: action type (enum-validated), business
name search (via `private.escape_ilike_pattern` — a literal `%`/`_` never wildcard-
expands), date range (`YYYY-MM-DD`, inclusive of the whole end day).

**Subscriptions page fields** (`list_platform_subscriptions`): business name, plan
code/name, status, trial end, current period end, cancel-at-period-end flag. No
provider reference, payment token, or webhook payload field exists here —
`private_platform_directory_reader` was never granted those columns in the first
place, so there is no code path that could leak them even by mistake (verified by
`tests/integration/platform-audit-subscriptions-support.test.ts`'s explicit
`not.toHaveProperty` assertions).

**Support page fields** (`list_platform_business_diagnostics` +
`get_platform_support_summary`): business name, diagnostic `code` (one of the seven
frozen 1O-C values — `NO_ACTIVE_OWNER`, `NO_ACTIVE_BRANCH`, `ZERO_ACTIVE_MEMBERS`,
`SUBSCRIPTION_MISSING`, `SUBSCRIPTION_PLAN_MISSING`, `EXPIRED_TRIAL`,
`RECENT_WHATSAPP_FAILURES`), `severity` (`WARNING`/`INFO` only), a fixed human-
readable `message`. No health score, no AI recommendation, no invented code.

**`recent_whatsapp_failures` numeric semantics (corrected — see §06 "Remediation
pass").** This is the actual count of failed WhatsApp messages in the frozen recent
window, summed across every non-archived business:

```sql
select coalesce(sum(stats.recent_whatsapp_failures), 0) from stats
```

where `stats.recent_whatsapp_failures` is, per business,
`count(*) from whatsapp_messages where status = 'FAILED' and failed_at > now() -
interval '7 days'` — the exact same window `list_platform_business_diagnostics`'s own
`RECENT_WHATSAPP_FAILURES` row message already used (`'%s WhatsApp delivery
failure(s) in the last 7 days.'`), so the KPI card and the diagnostic row it summarizes
have always agreed on the window; only the KPI's own aggregation was wrong. **Prior
wording in this document describing `recent_whatsapp_failures` as already correct, or
not specifying it counts affected businesses vs. actual failures, is superseded by
this section.** The card's hint text (`app/internal/admin/support/page.tsx`) now
reads "Failed WhatsApp messages in the last 7 days" to make the window explicit to
the reader, not just to someone who inspects the RPC.

**Permission map, final state (verified against
`20260928080000_platform_admin_security_foundation.sql` and
`20261001080000_platform_controlled_actions.sql` — unchanged by this pass):**

| Role | dashboard.view | businesses.view (→ Businesses + Support) | subscriptions.view (→ Subscriptions) | audit.view (→ Platform Audit) | suspend | reactivate | extend_trial |
|---|---|---|---|---|---|---|---|
| SUPER_ADMIN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OPERATIONS | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| SUPPORT | ✓ | ✓ | — | — | — | — | — |
| BILLING | ✓ | — | ✓ | — | — | — | ✓ |
| VIEWER | ✓ | — | — | — | — | — | — |

BILLING therefore sees Overview, Subscriptions, and Actions — never Businesses or
Support — exactly matching the frozen 1O-A/1O-D matrix, and verified end-to-end in
`tests/e2e/internal-admin-audit-subscriptions-support.spec.ts`.

**Extend Trial linking:** the Subscriptions page shows an "Extend Trial" link next to
a `TRIALING` row **only** when the caller independently holds
`platform.subscriptions.extend_trial`, pointing to the existing, unmodified
`/internal/admin/businesses/[businessId]/actions` route — no mutation logic is
duplicated on the Subscriptions page itself.

## 06 — Engineering Implementation Plan

**Shipped in this completion pass:**
1. Migration `20261004080000_platform_audit_subscriptions_support.sql` — 4 new RPCs
   + 1 re-defined RPC (additive) + 1 new helper function + 1 additive grant.
2. `lib/platform/audit-dal.ts`, `subscriptions-dal.ts`, `support-dal.ts` +
   corresponding `lib/validation/platform-{audit,subscriptions,support}.ts`.
3. `app/internal/admin/{audit,subscriptions,support}/page.tsx`.
4. `components/platform/{audit,subscription,support}-filters.tsx`.
5. `PlatformPagination` added to `platform-primitives.tsx`.
6. `PlatformShell` and `layout.tsx` updated with three new permission-gated nav items.
7. Overview page (`app/internal/admin/page.tsx`) updated: Subscription Overview panel
   gained a Canceled stat + a "Subscription details" link; Recent Platform Actions
   gained a "Full history" link to `/internal/admin/audit`; a new Support Snapshot
   panel with an "Attention queue" link to `/internal/admin/support`.
8. Heading-level fix across 5 existing page files (`<h2>` → `<h1>`) — see §04.
9. `tests/integration/platform-audit-subscriptions-support.test.ts` — 25 tests
   (full role matrix + AAL1/inactive-admin/tenant-owner/anonymous denial + field-
   exposure + wildcard/validation checks for all 4 new RPCs).
10. `tests/e2e/internal-admin-audit-subscriptions-support.spec.ts` — 12 tests
    (navigation + role-matrix + accessibility smoke, covering all three new pages).
11. One pre-existing e2e assertion (`internal-admin.spec.ts`) hardened from a bare
    `getByText` to a scoped `getByRole("heading", ...)` — see §04.
12. Regenerated `lib/supabase/database.types.ts` entries for all new/changed RPCs.
13. Visual QA screenshots for all three new pages at 390/1440 × light/dark.

**Remediation pass (post-Codex-review, forward migration — not a rewrite of an
already-applied migration):**
1. `supabase/migrations/20261004090000_fix_platform_support_summary.sql` —
   `create or replace function get_platform_support_summary()` only.
   `recent_whatsapp_failures` previously counted `count(*) from flags where
   whatsapp = 1` — one row per business with ≥1 recent failure, i.e. an
   **affected-business count**, not a failure count (a business with 5 failures
   reported `1`). Fixed to `coalesce(sum(stats.recent_whatsapp_failures), 0)` —
   the true sum of per-business failed-message counts. `businesses_requiring_attention`,
   `warnings`, and `info` are unchanged (still `count(distinct business_id)` / `count(*)
   where severity = ...` over the same `flags` CTE). Authorization (`platform.
   businesses.view`, AAL2 via `private.has_platform_permission`), `security definer`,
   `set search_path = ''`, and the `public`/`anon` revoke + narrow `authenticated`
   grant are byte-for-byte unchanged from the original migration.
2. `tests/integration/platform-audit-subscriptions-support.test.ts` — 3 new tests
   under "recent_whatsapp_failures numeric semantics": a single-business
   five-failure exact-delta test (before/after `get_platform_support_summary()`
   snapshots around the insert; asserts `after - before === 5`, proving one
   business contributing five failures adds exactly five, not one, independent
   of any pre-existing fixture data — superseding an earlier version of this
   test that only asserted `>= 5`), two businesses with 5 and 2 failures plus a
   third with 0 (proves the total's delta is exactly `7`, never `2`), and a
   failure timestamped 8 days ago (proves it contributes `0` — the frozen 7-day
   window is unchanged).
3. `app/internal/admin/support/page.tsx` — diagnostic badge accessibility fix (LOW
   finding): the badge previously rendered only `{row.code}` (e.g.
   `NO_ACTIVE_BRANCH`), conveying WARNING vs. INFO through background/text color
   alone. Now renders `"{Warning|Info} · {code}"` as one visible text node (a
   `SEVERITY_LABEL` map, never `aria-hidden`), so severity is readable without color
   perception while the existing orange/blue tone classes remain purely
   supplemental. The KPI card also gained an explicit `hint` stating the window
   ("Failed WhatsApp messages in the last 7 days").
4. `tests/e2e/internal-admin.spec.ts` — one new test, "Support page renders
   diagnostic severity as visible text, not color alone": seeds a real
   `NO_ACTIVE_BRANCH` WARNING and a real `RECENT_WHATSAPP_FAILURES` INFO row via
   direct fixture data, then asserts `getByText(/^Warning\s*·\s*NO_ACTIVE_BRANCH$/)`
   and `getByText(/^Info\s*·\s*RECENT_WHATSAPP_FAILURES$/)` — text assertions, never
   a CSS class or color check.
5. No diagnostic code, permission, role mapping, or other diagnostic count changed.
   No other page in `/internal/admin/*` was touched.

**Still deferred (a requirement of the phase brief, not a shortfall):**
- `/internal/admin/system-health`, `/internal/admin/settings` — no truthful data
  source for either exists yet.
- A real chart library, if a richer visualization is wanted for Platform Activity
  trends later (none exists in `package.json` today; not added this pass).
- Full WCAG contrast/screen-reader audit and an axe-equivalent ruleset (see §04's
  "what remains manual").
