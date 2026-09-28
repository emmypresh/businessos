# Phase 1O-A — Platform Admin Security Foundation — Build Brief

Baseline: `04d7ce57c86b9574802319294e89c3f1a89ffd4c` (frozen Phase 1N-C6), branch `feature/expenses-financials`.

This phase is small in surface area but privileged in nature, so every section below is written out fully rather than combined — the security stakes, not the line count, drive the format.

## 1. Product Requirements Document

**Problem.** BusinessOS has one authorization domain today: tenant membership (`business_members` → `roles` → `role_permissions`). There is no way for internal BusinessOS staff to access an internal operations surface without inventing a fake "business" for themselves or piggybacking on tenant roles — both of which would let tenant authority leak into platform authority.

**Goal.** Introduce a second, wholly independent authorization domain — platform administration — and the minimal internal shell that authenticates against it. No tenant role, including OWNER, ever implies platform authority.

**In scope (1O-A):**
- `platform_admins` table and platform role enum (SUPER_ADMIN, SUPPORT, OPERATIONS, BILLING, VIEWER).
- A small, explicit, read-only (`*.view`) platform permission catalog.
- Server-authoritative permission resolution (`has_platform_permission`, `get_my_platform_role`).
- `/internal/admin` route: a minimal shell showing the caller's own platform role and permissions.
- Explicit, operator-only bootstrap procedure for the first SUPER_ADMIN.
- Negative tests proving tenant authority does not leak upward.

**Out of scope (explicitly deferred):**
- 1O-B/C: business directory, member directory, subscription directory, SaaS analytics, tenant support tooling.
- 1O-D: platform mutation permissions, platform admin management UI, platform audit log writes.
- Impersonation, in any form.
- Billing/subscription mutation.
- Anything from 1P (CSP, rate limiting, WAF, backups) or 1Q (industry/POS/barcode).

**Success criteria.** A tenant OWNER/ADMIN, including one owning multiple businesses, cannot reach `/internal/admin`. An explicitly provisioned, active platform admin can. An inactive platform admin cannot. No client-side role branch is ever the security boundary.

## 2. Technical Design Document

**Two domains, no shared table.** Tenant authorization reads `business_members`/`roles`/`role_permissions`, keyed by `business_id`. Platform authorization reads `platform_admins`/`platform_permissions`/`platform_role_permissions`, keyed by nothing but the caller's own identity — there is no `business_id` anywhere in the platform schema, and no join between the two domains exists at any layer.

**Identity.** Always `private.current_uid()` (JWT `sub`, already used by `create_business`'s RPC boundary), inside `SECURITY DEFINER` functions. No function in this migration accepts a `user_id`/`p_user_id` parameter — a caller can only ever ask "am I a platform admin", never "is user X a platform admin".

**Data access pattern.** Mirrors the existing tenant pattern (`private.is_business_member` / `private.has_permission` / `public.has_permission`) exactly:
- `private.has_platform_permission(p_permission_key text)` — `SECURITY DEFINER`, `STABLE`, `set search_path = ''`, fully-qualified references, revoked from PUBLIC/anon/authenticated, granted to `authenticated` only.
- `public.has_platform_permission(p_permission_key text)` — `SECURITY INVOKER` wrapper, PostgREST-callable, granted to `authenticated` only.
- `private.get_my_platform_role()` / `public.get_my_platform_role()` — same shape, for the overview screen.

**Table security.** `platform_admins`, `platform_permissions`, and `platform_role_permissions` all have RLS enabled and forced, and carry **no policy at all** for `authenticated`/`anon`, and **no GRANT at all** to `authenticated`/`anon` (only `service_role` gets `SELECT`). This is stricter than the tenant tables (which grant `authenticated` a scoped `SELECT` under a real RLS policy) because there is no legitimate reason for any authenticated session, including a real platform admin's own, to query these tables directly via PostgREST — every legitimate read goes through the two `SECURITY DEFINER` functions above, which answer only "about me".

**Route.** `/internal/admin` (not `/[businessId]/internal`, not nested under any tenant route). `app/internal/admin/layout.tsx` calls `requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW)` once; every route under it inherits that gate. Denial is `notFound()` — identical to the tenant `requirePermissionOrNotFound` convention — so the route's existence is never revealed to a caller without access.

**Regenerated types.** `lib/supabase/database.types.ts` regenerated via `supabase gen types typescript --local` after `supabase db reset`.

## 3. App Flow & State Map

```
Unauthenticated visitor -> GET /internal/admin
  -> middleware (lib/supabase/proxy.ts) has no special-case for /internal/*
  -> falls through to the general "no claims, not an always-allowed/auth-only route" rule
  -> redirected to /login?next=/internal/admin        [existing behavior, unchanged]

Authenticated, NOT a platform admin -> GET /internal/admin
  -> InternalAdminLayout -> requirePlatformPermission(DASHBOARD_VIEW)
  -> has_platform_permission returns false (no platform_admins row)
  -> notFound()                                        [renders the app's normal 404]

Authenticated, platform admin, is_active = false -> GET /internal/admin
  -> has_platform_permission returns false (is_active filtered out in SQL)
  -> notFound()

Authenticated, active platform admin, role holds platform.dashboard.view -> GET /internal/admin
  -> requirePlatformPermission passes
  -> page renders: role (get_my_platform_role) + granted permissions
```

There is no client-side branch anywhere in this flow: every decision point is a server component awaiting a Supabase RPC backed by a `SECURITY DEFINER` function.

## 4. UI/UX Design Brief

Minimal operational console, same design system as the rest of BusinessOS (fonts, `Card`, `Badge` from `components/ui/`), visually distinguished only by the "BusinessOS Internal" eyebrow label in the header — not a separate theme.

- **Layout:** simple header (`BusinessOS Internal` / `Overview`) + centered content column, no sidebar yet (no additional destinations exist to put in one — see §21/52 of the phase instructions: no fake nav).
- **Content (1O-A):** current platform role (`Badge`), current permissions (list of permission keys). No analytics, no tables, no directories.
- **Responsive:** single-column flex layout, tested visually at 390/768/1280/1440 — no bespoke breakpoints needed at this content density.
- **Dark mode:** uses only existing `bg-muted`, `text-muted-foreground`, `Card`/`Badge` tokens — no hard-coded colors introduced.
- **Accessibility:** semantic `header`/`main`, real heading hierarchy (`h1` in the layout header, `h2` on the page), no icon-only controls (there are no controls at all in 1O-A — pure read-only display).

## 5. Backend & Data Design

**`platform_admins`**
| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| user_id | uuid, unique, not null | `references auth.users(id) on delete cascade` |
| role | text, not null | `check (role in ('SUPER_ADMIN','SUPPORT','OPERATIONS','BILLING','VIEWER'))` |
| is_active | boolean, not null, default true | |
| created_at / updated_at | timestamptz | `updated_at` maintained by the existing `private.set_updated_at()` trigger |
| created_by | uuid, nullable | `references auth.users(id)`; null for the operator-bootstrapped first row |

**`platform_permissions`** (`key` pk, `description`) — seeded with the five 1O-A `*.view` keys.

**`platform_role_permissions`** (`role`, `permission_key` fk) — seeded matrix:

| role | permissions |
|---|---|
| SUPER_ADMIN | all five |
| SUPPORT | dashboard.view, businesses.view, users.view |
| OPERATIONS | dashboard.view, businesses.view, subscriptions.view |
| BILLING | dashboard.view, subscriptions.view |
| VIEWER | dashboard.view only |

**Bootstrap.** The first `SUPER_ADMIN` row is inserted by an operator with direct database access (Supabase SQL editor, or `psql`/`supabase db` against the target project), e.g.:

```sql
insert into public.platform_admins (user_id, role)
values ('<the operator-verified auth.users.id>', 'SUPER_ADMIN');
```

No migration, seed file, or application code ever contains a specific email or user id — the operator looks up the target user's id out of band (e.g. via the Supabase dashboard's Auth users list) and runs this statement by hand, once, per environment. This is a deliberate manual step, not automation, precisely so no code path can be tricked into self-granting platform authority.

**Migration file:** `supabase/migrations/20260928080000_platform_admin_security_foundation.sql`. No existing function, table, or trigger was recreated from a stale body — every statement in it is new.

## 6. Engineering Implementation Plan

1. Inspect existing tenant authorization pattern (`lib/auth/dal.ts`, `lib/business/dal.ts`, `private_authorization_helpers.sql`, `create_business_members.sql`, `create_business_rpc_boundary_hardening.sql`) — done, informs every design choice above.
2. Migration: `platform_admins` + catalog tables + RLS/FORCE RLS + `SECURITY DEFINER`/`INVOKER` function pairs + grants — done.
3. `supabase db reset` + `supabase gen types typescript --local` — done, diff limited to the new tables/functions.
4. `lib/platform/constants.ts` (`PLATFORM_ROLE`, `PLATFORM_PERMISSION`) — done.
5. `lib/platform/dal.ts` (`getPlatformRole`, `hasPlatformPermission`, `getMyPlatformPermissions`, `requirePlatformPermission`) — done.
6. `app/internal/admin/layout.tsx` + `page.tsx` — done.
7. Unit tests: `lib/platform/dal.test.ts` — done.
8. Integration tests: `tests/integration/platform-admin-security.test.ts` (RLS/FORCE RLS, direct-table denial, anon denial, tenant OWNER/ADMIN/multi-business-OWNER denial, VIEWER/SUPER_ADMIN/inactive-admin resolution, cross-user spoofing, RPC grant ACLs, `search_path`) — done.
9. Focused E2E: `tests/e2e/internal-admin.spec.ts` (anonymous redirect, tenant OWNER denial, tenant ADMIN denial, platform SUPER_ADMIN success) — done.
10. Quality gates: format/typecheck/lint/unit/integration/build — run and reported in the final report below.
11. Security review against this phase's actual attack surface (privilege escalation, tenant→platform escalation, metadata trust, IDOR, RLS, `SECURITY DEFINER`, grants, admin enumeration, service-role exposure, client-side-only guards, inactive admins, cross-user spoofing) — reported below.
12. This build brief.

Not done, and intentionally deferred: platform admin management UI, any mutation permission or endpoint, platform audit log writes — none are in 1O-A's scope.

## 7. MFA / AAL2 Follow-up

Codex's first review of 1O-A approved the code with two remaining findings: (MEDIUM) platform-admin access lacked verified MFA/AAL2 enforcement, and (LOW) integration tests didn't directly exercise denial for `platform_permissions`/`platform_role_permissions`. This section documents the remediation.

**Requirement.** Platform-admin access now requires BOTH (1) an active `platform_admins` row with the requested permission, AND (2) the current session being at Authenticator Assurance Level 2 (AAL2) — a second factor actually verified this session, not merely enrolled. AAL1 (password-only) is never sufficient, for any role including `SUPER_ADMIN`.

**Authoritative AAL source.** `lib/auth/dal.ts`'s new `getAssuranceLevel()` calls `supabase.auth.getClaims()` — the same signature-verifying mechanism `lib/supabase/proxy.ts` already uses for its session check — and reads the standard `aal` claim from the verified payload. This is never a manual/unverified JWT decode. Identity itself is unchanged: `getUser()`/`requireUser()` remains the authority for "who is this", per the existing convention; `getAssuranceLevel()` only adds the session's assurance level on top.

**Server-side enforcement location.** `lib/platform/dal.ts`'s `requirePlatformPermission()` — the single reusable guard every gated route calls — now runs, in order:
1. `requirePlatformAdmin()`: is the caller an active platform admin at all (role/`is_active` only, AAL-independent). A "no" denies as a generic `notFound()`, before AAL is ever considered, so a tenant user is never routed through the internal-admin MFA flow.
2. `getAssuranceLevel()`: if not exactly `"aal2"` (including `null` — missing/unverified/unexpected claims all fail closed), `redirect("/internal/admin/mfa")`. This is the "legitimate admin, not yet elevated" case — distinct from denial.
3. `hasPlatformPermission()`: the specific requested permission, re-verified at the database layer including AAL2 (see below) as defense in depth.

**Database-level enforcement.** `supabase/migrations/20260928090000_platform_admin_require_aal2.sql` adds an AAL2 requirement directly inside `private.has_platform_permission`, reading the trusted, PostgREST-verified `request.jwt.claims` — the same source `private.current_uid()` already reads identity from, never a function parameter. Fails closed: missing claims, missing/null `aal`, `"aal1"`, or anything other than the literal `"aal2"` all deny. This is a new forward migration rather than an edit to the original `20260928080000` migration body, since 1O-A is still uncommitted but the repository's established convention (seen across every other phase) is additive forward migrations, not rewriting a prior one in place. `get_my_platform_role()` is deliberately left AAL-unaware — see below.

**Why `get_my_platform_role()` stays AAL-unaware.** It is not an authorization boundary (`has_platform_permission` is); it's the signal `requirePlatformAdmin()` and the MFA challenge page use to decide "is this identity a platform admin at all," which must stay answerable at AAL1 so a legitimate AAL1 admin can be routed to the MFA challenge instead of a flat 404. Widening it to require AAL2 would not change what a caller can actually *do* without AAL2 (that's still gated by `has_platform_permission`), but it would collapse "not an admin" and "admin, not yet elevated" into the same signal, breaking the intended UX split.

**AAL1 platform-admin behavior.** Redirected to `/internal/admin/mfa` (`app/internal/admin/mfa/page.tsx`), gated by the same `app/internal/admin/layout.tsx` → `requirePlatformAdmin()` as the console (so a non-admin gets the same 404 there too, never a glimpse of the challenge/enrollment UI). The page itself checks AAL: if already `"aal2"`, redirects into `/internal/admin` (nothing to do); otherwise renders a challenge form (already has a verified TOTP factor) or an enrollment flow (doesn't).

**No-MFA-enrolled admin.** Falls into the enrollment branch of the same page — never downgraded to AAL1 access, never shown privileged content. This is intentionally the same minimal flow as the AAL1-with-existing-factor case, not a separate error state; the phase brief calls for "a safe internal-admin MFA-required/enrollment-required flow," and one page serving both keeps the fail-closed behavior identical either way.

**MFA challenge flow.** `lib/auth/mfa.ts` (read: `listVerifiedTotpFactors`, via `supabase.auth.mfa.listFactors()`) and `lib/auth/mfa-actions.ts` (`"use server"`: `enrollTotpFactor` calls `supabase.auth.mfa.enroll({ factorType: "totp" })`; `verifyMfaChallenge` validates a 6-digit code with `lib/validation/auth.ts`'s `MfaVerifySchema`, then calls `supabase.auth.mfa.challengeAndVerify()`). Factor type: TOTP only — no WebAuthn/passkey expansion, per scope. Both actions additionally gate on `requirePlatformAdmin()`, not just `requireUser()`: this flow exists to elevate a platform admin's own session, and an ordinary tenant user calling either action directly gets the same `notFound()` as visiting the page. UI: `components/auth/mfa-enroll-flow.tsx` (QR + manual-entry secret + code input) and `components/auth/mfa-challenge-form.tsx` (code input only) — deliberately minimal, not the premium internal-admin login redesign approved separately for a later UI phase.

**Session refresh.** `challengeAndVerify()` is called through the SSR-configured client (`lib/supabase/server.ts`), which persists the newly elevated session via the same cookie-writing path (`setAll`) every other auth action in this app already uses. The server action doesn't need to re-check AAL itself before its final `redirect("/internal/admin")` — `requirePlatformPermission` re-reads AAL from `getClaims()` on the next request, against the now-elevated session.

**No secrets logged.** Neither `enrollTotpFactor` nor `verifyMfaChallenge` logs the Supabase `error`/`data` payloads (which can carry a factor secret or verification detail) or the submitted code. The QR/secret returned by `enroll()` is held only in React client-component state (`useActionState`), never placed in a URL, query string, or redirect target.

**Tenant OWNER/ADMIN + AAL2.** Still denied. Elevating a tenant user's own session to AAL2 (e.g. by enrolling MFA on an unrelated feature in the future) grants zero platform authority — `has_platform_permission` still requires an active `platform_admins` row first; AAL2 alone satisfies only one of its two conditions. Proven in `tests/integration/platform-admin-security.test.ts`.

**SUPER_ADMIN + AAL1.** Explicitly denied — no role bypasses the AAL2 requirement. Proven in both the integration suite (RPC-level) and `tests/e2e/internal-admin.spec.ts` (route-level, via redirect to the MFA challenge rather than console content).

**Inactive admin + AAL2.** Still denied — `is_active = false` is checked inside the same `has_platform_permission` predicate as the AAL2 condition; MFA never bypasses it.

**Direct-table denial (Codex LOW finding).** `tests/integration/platform-admin-security.test.ts` now proves authenticated- and anon-denial for `platform_admins`, `platform_permissions`, and `platform_role_permissions` individually (previously only `platform_admins` had direct coverage), plus write-attempt coverage (`INSERT`/`UPDATE` on `platform_admins`, `INSERT` on `platform_role_permissions`) confirming no self-promotion or self-escalation path exists at the PostgREST boundary.

**Known limitation.** `enrollTotpFactor()` creates a new unverified TOTP factor on every call; repeated abandoned enrollment attempts accumulate unverified factors on a real admin's account (Supabase does not auto-expire these in a way this phase manages). This is a UX/hygiene gap, not a security gap (an unverified factor cannot be used to reach AAL2), and is left for the later premium internal-admin UI phase rather than expanded here.

**Migration:** `supabase/migrations/20260928090000_platform_admin_require_aal2.sql` (new, additive — the original `20260928080000` migration is untouched). **Generated types:** not regenerated — no table/column/function-signature change, only a function body change, so `lib/supabase/database.types.ts` has no diff to produce.
