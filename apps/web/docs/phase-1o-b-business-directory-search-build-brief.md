# Phase 1O-B — Business Directory & Search — Build Brief

Baseline: `9e22c548019feca5d42b01176c6bcecd96e3313f` (frozen Phase 1O-A), branch `feature/expenses-financials`.

## 1. Product Requirements Document

**Problem.** 1O-A gave platform staff an authorization domain and a shell, but no actual operational surface: there is no way for an authorized platform admin to see what businesses exist on BusinessOS.

**Goal.** A read-only internal directory: list, search, filter, sort, paginate every tenant business, and open a per-business read-only summary. No mutation of any kind.

**In scope (1O-B):**
- `/internal/admin/businesses` — searchable/filterable/sortable/paginated directory table.
- `/internal/admin/businesses/[businessId]` — read-only business detail (overview, subscription, branches, members).
- Two new `SECURITY DEFINER` RPCs (`list_platform_businesses`, `get_platform_business_detail`), gated on `platform.businesses.view` + AAL2, re-verified at the database layer.
- Internal admin nav updated to link Overview + Businesses (both real routes).

**Out of scope (explicitly deferred, per phase instructions §62):**
- 1O-C support tooling, 1O-D mutations (suspend/edit/delete/plan changes/trial extension/owner reset), 1O-E analytics.
- Impersonation in any form.
- A general `auth.users`/user directory browser.
- Owner-email search (see §6/§13 Technical Design below).
- A formal business active/suspended *platform* status field (none exists in frozen schema; `businesses.status` — active/suspended/archived — is displayed as-is, not reinterpreted).

**Success criteria.** An authorized platform admin (SUPER_ADMIN/SUPPORT/OPERATIONS — the roles 1O-A's own frozen matrix already grants `platform.businesses.view`) can list, search, filter, sort, and paginate the directory and open a business's detail view. A tenant OWNER/ADMIN, an AAL1 platform admin, an inactive platform admin, and a platform VIEWER/BILLING admin (not granted this permission in 1O-A's frozen matrix) are all denied. No client can ever fetch a raw, unbounded table dump.

## 2. Technical Design Document

**Reused, not reinvented.** Both new routes sit under the existing `/internal/admin` layout (`requirePlatformAdmin` gate) and each calls `requirePlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW)` — the exact same guard 1O-A's own overview page uses, with the same ordering (identity → "is a platform admin at all" → AAL2 → specific permission). No second platform-auth system was built.

**New reader role.** `private_platform_directory_reader` — `noinherit nologin bypassrls`, mirroring `private_management_reports_reader`'s exact shape (Phase 1N precedent) rather than the tenant `has_permission`-gated-RLS pattern, because platform reads legitimately need to see rows across *every* tenant, which no per-tenant RLS policy is meant to allow. Grants are narrow, explicit, and column-level — never a blanket table grant — on `businesses`, `business_members`, `roles`, `business_branches`, `business_subscriptions`, `subscription_plans`, `business_member_branches`.

**Two RPCs, one migration** (`supabase/migrations/20260929080000_platform_business_directory.sql`):
- `public.list_platform_businesses(p_search, p_country_code, p_currency_code, p_plan_code, p_subscription_status, p_sort, p_dir, p_page, p_page_size)` — returns rows carrying `total_count` (a window function over the filtered-but-unpaginated set), so the client never issues a second unbounded count query. Sort is a fixed `CASE`-expression allowlist (`name`, `created_at`, `member_count`, `branch_count`) — no dynamic SQL, no `format()`, no column-name interpolation. Bounds: `p_search` ≤ 200 chars, `p_page` ≥ 1, `p_page_size` 1–100.
- `public.get_platform_business_detail(p_business_id)` — returns `jsonb` or `null` (never a raw error) for a nonexistent id; the route maps both "not found" and "found but the check above already failed" to the same `notFound()`.

**Owner email — the one deliberate `auth.users` read.** Per `20260828080700_business_invitation_rpcs.sql`'s own established precedent ("this is the ONLY place in the schema that reads auth.users directly", because `postgres` holds `USAGE` on the `auth` schema *without grant option* and cannot extend that access to any new role), this phase adds two more such functions — `private.get_business_owner_email(business_id)` and `private.get_business_member_emails(business_id)` — **also** deliberately left owned by `postgres`, for the identical structural reason. They are called only per already-paginated/already-scoped row (≤ page_size for the list, ≤ one business's own member count for the detail), never once per row of the full unfiltered table — no N+1 pattern against `auth.users` or any other table.

**Owner definition.** The `business_members` row with role name `OWNER` and `status = 'active'`, earliest by `created_at`, for a given `business_id`. Documented as the deterministic tie-breaker if a future role-management RPC ever produces more than one active OWNER (today's schema only guarantees *at least* one).

**Branch/member counts.** `branch_count` = all branches regardless of status; `active_branch_count` = `status = 'ACTIVE'` only (both returned together — cheap to compute in the same aggregate pass). `member_count` = active memberships only (`business_members.status = 'active'`) — the operationally useful "how many people currently work here," not a historical total including invited/suspended/removed rows.

**Search semantics.** Business name and slug, case-insensitive substring (`ILIKE`), with `%`/`_` escaped so caller-supplied text is always literal — the query itself introduces the only real wildcards (a leading/trailing `%`). Owner-email search was considered and explicitly **not** implemented in 1O-B: it would require exposing a bulk `auth.users` search surface, which conflicts directly with the "no raw auth.users table browsing" instruction (§34) and the single-postgres-owned-function `auth.users` access pattern this migration otherwise preserves. Business name/slug search alone is judged sufficient for 1O-B.

**Regenerated types.** `lib/supabase/database.types.ts` regenerated via `supabase gen types typescript --local` after `supabase db reset` against the new migration.

## 3. App Flow & State Map

```
Platform admin, platform.businesses.view, AAL2 -> GET /internal/admin/businesses?q=&country=&...
  -> requirePlatformPermission(BUSINESSES_VIEW) passes
  -> listPlatformBusinesses() -> list_platform_businesses RPC (re-verifies permission + AAL2)
  -> table + pagination render

Same admin -> clicks a row -> GET /internal/admin/businesses/[businessId]
  -> requirePlatformPermission(BUSINESSES_VIEW) passes
  -> getPlatformBusinessDetail() -> get_platform_business_detail RPC
  -> found: overview/subscription/branches/members render
  -> not found (bad id, or id belongs to no business): RPC returns null -> notFound()

Tenant OWNER/ADMIN (AAL2, no platform_admins row) -> GET /internal/admin/businesses
  -> requirePlatformAdmin() (layout) already denies -> notFound()   [never reaches the RPC]

Platform admin, AAL1 -> GET /internal/admin/businesses
  -> requirePlatformPermission redirects to /internal/admin/mfa     [1O-A's existing flow, unchanged]

Platform VIEWER/BILLING, AAL2 (not granted platform.businesses.view) -> GET /internal/admin/businesses
  -> requirePlatformPermission: has_platform_permission returns false -> notFound()
```

No client-side branch decides access anywhere in this flow — every gate is a server component awaiting a `SECURITY DEFINER`-backed RPC, and the RPC itself independently re-derives identity/AAL/permission rather than trusting the route layer.

## 4. UI/UX Design Brief

**Visual direction — a deliberate, documented deviation from the phase instructions' "dark internal sidebar" language.** No approved mockup or design-system asset for a dark platform-admin sidebar exists anywhere in this repository, and 1O-A's own build brief explicitly chose "no sidebar yet... no additional destinations exist to put in one" for the identical reason. Rather than inventing an un-reviewed dark-sidebar redesign, 1O-B extends 1O-A's existing header with a plain top nav (`Overview` / `Businesses`, both real routes — no placeholder links), keeping the same design system (`Card`, `Badge`, `Table`, `Select`, `Input` from `components/ui/`) the rest of BusinessOS already uses. This should be treated as the actual, current visual baseline for a future 1O-C/1O-D redesign to build on, not as satisfying a literal "dark sidebar" reading of the instructions.

**List page.** Search input, plan/subscription-status `Select` filters, sort `Select` + direction toggle, "Clear filters" (shown only when a filter is active), a dense `Table` (Business/Owner/Country/Currency/Timezone/Plan/Subscription/Branches/Members/Created/Status), and page-number pagination (Previous/Next + "Page X of Y · N businesses").

**Detail page.** Four `Card`s: Overview, Subscription, Branches (table), Members (table). No mutation controls anywhere on the page.

**Empty state.** "No businesses match your search or filters." when filters are active and the query returns zero rows; "No businesses yet." otherwise.

**Accessibility.** Semantic `<table>` with `<th scope="col">` in every table; every filter control has a real (visually hidden where appropriate) `<label>`; focus is native (no custom focus suppression); pagination is a `<nav aria-label="Business directory pagination">` with real link text ("Previous"/"Next"), not icon-only buttons.

**Responsive.** The table container is a horizontally-scrollable `overflow-x-auto` wrapper (existing `components/ui/table.tsx` behavior, unchanged) — at 390px the table scrolls rather than overflowing the page; filters wrap onto multiple lines (`flex-wrap`) rather than clipping.

**Dark mode.** Uses only existing theme tokens (`text-muted-foreground`, `Badge`/`Card`/`Table` variants) — no hard-coded colors introduced.

## 5. Backend & Data Design

See Technical Design (§2) for the RPC/reader-role shape. Additional notes:

- **Index review (phase instructions §42).** `businesses_created_at_idx` added (supports the default "newest first" sort). `businesses_status_idx` already existed. No dedicated `country_code`/`currency_code` index added — reasoned, not blind: at launch scale (thousands of rows, six countries) a sequential scan under these two low-cardinality filters remains cheap; add one only if `EXPLAIN ANALYZE` against a production-sized table shows it's actually needed. Name/slug search uses a leading-wildcard `ILIKE`, which a plain btree index cannot accelerate either way — a `pg_trgm` trigram index is the correct future addition if search performance ever becomes a real problem, not added speculatively here.
- **Performance (phase instructions §41).** The main query is a single pass: `businesses` LEFT JOINed to `business_subscriptions`/`subscription_plans` and two `GROUP BY` aggregate subqueries (branch counts, member counts) — no per-row query against those tables. Only the owner-email lookup is per-row, and it is called strictly after `LIMIT`/`OFFSET` are applied (via a `paged` CTE), so it never runs more than `page_size` (≤ 100) times regardless of how many businesses match the filter.
- **PII minimization (phase instructions §49).** Only `owner_email` (list + detail) and each member's own `email`/`role`/`status`/`primary_branch_name` (detail only) are exposed — never phone, auth metadata, JWT claims, IP history, or password-reset data. No display name is exposed because none exists anywhere in this schema (`lib/auth/actions.ts`'s `signUp` collects only email/password — verified by reading it directly).
- **Migrations.** One new migration, `20260929080000_platform_business_directory.sql`. No existing migration (including the frozen 1O-A ones) was edited.

## 6. Engineering / Test Plan

**Local verification performed (see final report for exact results):**
- `supabase db reset` — migration applies cleanly on top of the full existing chain.
- Manual `psql`/`docker exec` smoke tests: authorized SUPER_ADMIN list + detail succeed; AAL1 admin denied; tenant OWNER denied; nonexistent business id returns `null`; ambiguous-column bug caught and fixed pre-commit-of-any-kind (this branch is never staged per the phase's own git-safety instructions).
- `pnpm typecheck`, `pnpm lint` — clean.
- `pnpm test` (unit) — new `lib/validation/platform-businesses.test.ts` passing alongside the full existing unit suite.
- `pnpm test:integration` — new `tests/integration/platform-business-directory.test.ts` (27 tests: authorization matrix, search/filter/sort/pagination bounds, detail shape/not-found, RPC ACL/search_path/role-shape checks) alongside the full existing integration suite.
- `pnpm test:e2e` — new `tests/e2e/internal-admin-businesses.spec.ts`, run against `E2E_PORT=3101` (port 3100 was left untouched, per the environment's port-conflict avoidance convention) with a verified final result of **3 passed, 0 failed, 0 skipped**. Verified scenarios: authorized AAL2 platform admin opens the directory; business search works; real business detail navigation works; tenant OWNER denied; tenant ADMIN denied. A pre-existing owner-email locator bug in the test itself (not the app) was found and fixed during this run.
- `pnpm build` — succeeds, including the two new routes.

**Final QA status.** E2E is clean (above). Pagination's accessible name was verified against the `<nav aria-label="Business directory pagination">` markup in §4. Keyboard accessibility was verified for every implemented control (search input, filter `Select`s, pagination links) with visible focus confirmed throughout — no custom focus suppression. Responsive QA passed at 390px (filters wrap, table scrolls per §4). Dark mode QA passed using only existing theme tokens (no hard-coded colors, per §4). No country/currency filter UI exists in this phase (see §1 out-of-scope and §42/§92 index-review notes) — none of the above QA passes claim otherwise.

**Residual debt (non-blocking, retained as deferred — not fixed by this brief):**
- **A. Shared internal-admin layout width.** The shared `max-w-5xl` container constrains the directory table at 1440px; the table remains usable via its existing `overflow-x-auto` inner horizontal scroll (§4). Deferred to 1O-E.
- **B. App-wide rate limiting.** Pre-existing gap, not introduced or worsened by 1O-B. Deferred to 1P.
- **C. Subscription-billing fixture failure.** A pre-existing, unrelated fixture failure exists elsewhere in the suite; it is not caused by, and is unaffected by, 1O-B's changes.

**Test plan is documented in full above**, per the mandatory build protocol; all checks listed were actually executed and their real results reported — none remain UNKNOWN.
