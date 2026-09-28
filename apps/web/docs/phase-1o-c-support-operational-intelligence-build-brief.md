# Phase 1O-C — Support & Operational Intelligence — Build Brief

Frozen baseline: `c5da7f82524517fb788a11f7d519f9c02e297509` (feat: add platform
business directory — the tip of `feature/expenses-financials` at the start of this
phase). Frozen 1O-A (`20260928080000_platform_admin_security_foundation.sql`,
`20260928090000_platform_admin_require_aal2.sql`) and 1O-B
(`20260929080000_platform_business_directory.sql`, including
`public.get_platform_business_detail`) are unmodified — this phase only adds new,
additive migrations, RPCs, and application files alongside them.

This brief is intentionally lean where a section would otherwise restate what the
code already documents in its own header comments — each section says so explicitly
rather than omitting it.

---

## 1. Product Requirements Document

**Problem.** Platform support/operations staff (1O-A `platform_admins`) could browse
and open a single business (1O-B) but had no way to inspect its members, recent
transaction activity, operational health, or audit history without direct database
access.

**Users.** Internal BusinessOS platform admins only (`SUPER_ADMIN`, `SUPPORT`,
`OPERATIONS`, `BILLING`, `VIEWER` — the frozen 1O-A role set). Never tenant users.

**Scope (this phase).** Read-only support console: Overview, Members, Branches,
Subscription, Activity, Diagnostics, Audit tabs on the existing
`/internal/admin/businesses/[businessId]` route. No mutation of any kind (§33 of the
phase instructions), no impersonation (§34).

**Out of scope, explicitly deferred:**
- Any write/mutate action (suspend, edit, reset owner, etc.) — Phase 1O-D.
- Shared `max-w-5xl` layout constant extraction — Phase 1O-E.
- Global rate limiting — Phase 1P.
- Pre-existing subscription-billing fixture test debt — tracked separately, not
  touched by this phase.

**Success criteria.** A platform admin holding `platform.businesses.view` can review
a business's full operational picture (members, branches, subscription, recent
activity, deterministic diagnostics) without ever seeing audit data unless they
separately hold `platform.audit.view`; every RPC independently enforces this at the
database layer; zero regressions to frozen 1O-A/1O-B behavior (proven in §11).

## 2. Technical Design Document

**Two-permission model (non-negotiable, per approved architecture).**
`platform.businesses.view` gates the page shell and every tab except Audit.
`platform.audit.view` gates the Audit tab and its RPC *independently* —
`platform.businesses.view` never implies it, and this phase adds no row to
`platform_role_permissions` widening the frozen 1O-A matrix (verified in §26).

**RPCs added** (all `SECURITY DEFINER`, `SET search_path = ''`, owned by
`private_platform_directory_reader` — see
`supabase/migrations/20260930080000_platform_business_operational_intelligence.sql`):

| RPC | Permission required |
| --- | --- |
| `get_platform_business_overview(business_id)` | `platform.businesses.view` |
| `list_platform_business_members(business_id, filters…)` | `platform.businesses.view` |
| `list_platform_business_activity(business_id, page…)` | `platform.businesses.view` |
| `list_platform_business_audit(business_id, page…)` | `platform.audit.view` |

`public.get_platform_business_detail` (1O-B) is untouched — kept as compatibility
surface per phase instruction §5.

**Auth.users access.** No generic search/list primitive is added. A single new
helper, `private.get_business_actor_emails(business_id)`, mirrors 1O-B's
`get_business_owner_email`/`get_business_member_emails` exactly: owned by
`postgres`, joins `auth.users` only through `business_members` rows already scoped
to the one requested `business_id`.

**Reader role.** Reuses `private_platform_directory_reader` (1O-B) with additive,
narrow, column-level `SELECT` grants on `expenses`, `sales`, `sale_returns`,
`invoice_payments`, `invoices`, `whatsapp_messages`, `audit_events` — no new
`BYPASSRLS` role.

## 3. App Flow & State Map

```
/internal/admin/businesses/[businessId]?tab=<tab>
  overview (default) → GET overview RPC once, rendered by OverviewTab
  members            → GET members RPC with q/role/status/branch/sort/dir/page
  branches           → reuses the same overview RPC result (BranchesTab)
  subscription       → reuses the same overview RPC result (SubscriptionTab)
  activity           → GET activity RPC with page
  diagnostics        → reuses the same overview RPC result (DiagnosticsTab)
  audit              → GET audit RPC with page; returns "unavailable" message
                        (never an error page) if the caller lacks platform.audit.view
```

An invalid/unrecognized `?tab=` value normalizes to `overview`
(`parseSupportTab`, `lib/validation/platform-business-operations.ts`). Overview,
Branches, Subscription and Diagnostics share a single overview RPC call per request
(only the active tab is rendered — `app/internal/admin/businesses/[businessId]/page.tsx`
switches on `activeTab`, so exactly one of the five tab components executes its data
fetch per request, per phase instruction §35).

## 4. UI/UX Design Brief

Reuses the existing shadcn `Card`/`Table`/`Badge`/`Select`/`Input` primitives already
established by 1O-A/1O-B — no new design system introduced. Tab navigation
(`BusinessSupportTabs`) is plain server-rendered `Link`s driving `?tab=`, not the
client-state shadcn `Tabs` primitive, so only the active tab's server component ever
fetches data. The Audit link itself is omitted from the nav entirely when the caller
lacks `platform.audit.view` (never rendered-but-disabled — see §28 below).
Diagnostics severity is shown as both a badge color *and* the literal word
(OK/INFO/WARNING) in text, never color alone. Verified in the browser at 390/768/
1280/1440 — see §51–54.

## 5. Backend & Data Design

See the migration's own extensive header comments
(`supabase/migrations/20260930080000_platform_business_operational_intelligence.sql`)
for the full per-RPC design rationale (diagnostic rules, activity normalization,
audit PII minimization, index review). Not restated here to avoid drift between two
sources of truth — the migration file is authoritative.

## 6. Engineering Implementation Plan

1. Additive migration (RPCs + grants + one partial index) — done, applied to local
   Supabase, and regenerated `lib/supabase/database.types.ts`.
2. Validation layer (`lib/validation/platform-business-operations.ts`) — tab/query
   parsing, mirroring RPC-side bounds.
3. DAL layer (`lib/platform/business-operations-dal.ts`) — one function per RPC,
   `listPlatformBusinessAudit` returning `null` (never throwing) on
   `insufficient_privilege`.
4. UI: tab nav + one component per tab + shared pagination/filter components.
5. Route: `app/internal/admin/businesses/[businessId]/page.tsx` rewritten to route
   on `?tab=`.
6. Unit tests (16), integration tests (32 covering the full authorization matrix +
   functional behavior + RPC ACL/search_path hygiene).
7. Typecheck, lint, unit suite, full integration suite, production build — all run
   and passing (§43–48 of the final report below).
8. Browser QA across four breakpoints plus an authorization-boundary walkthrough
   (§39–41).
