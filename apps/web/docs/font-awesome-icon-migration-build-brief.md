# Font Awesome Free icon migration — build brief

## 1. PRD

**User/problem.** Tenant users and internal administrators should see one supported, consistently licensed icon system rather than Lucide and Font Awesome mixed together.

**Goal.** Replace all runtime `lucide-react` imports in `app/` and `components/` with a centralized Font Awesome Free mapping. Keep custom SVG solely for BusinessOS brand marks.

**Non-goals.** No route, data, authorization, styling-token, or business-logic changes; no Font Awesome Pro package/icon; no redesign of page layouts.

**Acceptance criteria.**

1. Given any tenant or internal-admin route, when it renders a migrated icon, then it comes from the centralized Font Awesome wrapper and retains its existing sizing classes/layout.
2. Given a decorative icon, when it has no accessible name, then the wrapper marks it `aria-hidden`; icon-only controls retain their text or `aria-label` labels.
3. Given the dependency graph, when inspected, then it includes only the requested Font Awesome Free packages and has no `lucide-react` runtime import or dependency.
4. Given a production build, then typecheck, lint, relevant unit tests, build, and production dependency audit pass.

**Success signal.** Zero runtime Lucide imports and zero TypeScript errors from the migration. **Risk.** Font Awesome filled glyph metrics differ from Lucide strokes; preserve existing Tailwind dimensions and verify primary icon-only controls. **Dependency.** `pnpm` lockfile resolution.

## 2. Technical design

`components/ui/icon.tsx` is a pure shared UI module. It imports only `@fortawesome/fontawesome-svg-core`, `@fortawesome/free-solid-svg-icons`, and `@fortawesome/react-fontawesome`, maps prior semantic names to reviewed Free icons, and exports compatible React components. It accepts the existing numeric `size` call shape, preserves `className`/style forwarding, and defaults unnamed icons to decorative.

The module has no network, data, server, browser-storage, or authentication behavior. It is safe to import on either side of the App Router server/client boundary. A named mapping minimizes ad-hoc package imports and makes Free-only substitutions auditable. Filled FA glyphs are an intentional visual-system change; their inherited `currentColor` and existing Tailwind size classes preserve color and layout.

**Decision:** use Font Awesome Free 7.3.1 packages only. **Rejected:** Pro icons, a global FA library registration, and a compatibility alias for `lucide-react`; all would obscure provenance or leave inconsistent imports. Reconsider if product requires a Free-unavailable semantic glyph or a deliberate switch to a different icon family.

## 3. App flow and state map

Affected routes are existing tenant dashboard/navigation, reports, activity, invoices, payments, notifications, staff, branches, sales/returns, WhatsApp, and internal-admin overview/support/subscriptions surfaces. The migration does not alter route entry conditions, permissions, redirects, loading/empty/error/offline states, session expiry, destructive confirmations, or desktop/mobile navigation.

Icon states retain their existing behavior: loading spinners remain animated; disabled button semantics remain on the buttons; empty states receive an icon component through the same prop; dialog/sheet close controls retain visible `sr-only` names; search/filter controls retain screen-reader labels and user-facing text. No API or server state changes occur.

## 4. UI/UX brief

This is a visual consistency pass, not a layout restyle. Preserve the app’s existing cool neutral surfaces, one-accent hierarchy, dimensions, and responsive Tailwind layouts. Icons inherit `currentColor`, keep their existing `size-*` utility classes, and remain secondary to text. They are included only where they identify a navigation destination, status, or action. The wrapper makes unnamed SVGs decorative; icon-only buttons must continue to supply a visible `sr-only` label or `aria-label`. Existing dialog/sheet and mobile-menu controls meet that rule.

Apple-liquid-glass gate: **PASS (applicable icon rules)** — no added glass, color, layout, motion, decorative noise, or touch-target regression; existing icon controls retain their 44px button variants and accessible labels. Broader page visual redesign items are **NOT APPLICABLE** because this task changes no page geometry, typography, or surface CSS.

## 5. Backend and data design

**NOT APPLICABLE.** No schema, query, API, event, storage, authentication, authorization, audit-log, retention, or sensitive-data behavior changes. The icon mapping is static presentational code and ships no secrets.

## 6. Engineering plan and evidence

1. Inventory package/lockfile and every runtime Lucide import — complete.
2. Install the four requested Free Font Awesome packages with pnpm; remove Lucide after imports reach zero — complete.
3. Add the centralized reviewed mapping and replace tenant/internal-admin/shared primitive imports — complete.
4. Verify type, lint, targeted unit tests, production build, production audit, remaining imports, and git diff — pending final evidence below.
5. Recovery: restore the prior package/import set via ordinary version-control review if a visual regression is found; no data migration or production rollback is needed.

## Build checklist gate

| Area | Status | Evidence / reason |
| --- | --- | --- |
| Define | PASS | Scope, acceptance criteria, non-goals, risks, and affected flows are recorded above. |
| Plan | PASS | Dependency order, validation, recovery, and evidence steps are recorded above. |
| Build safely | PASS | No secrets, data, auth, or server behavior added; unrelated WIP was left unchanged. |
| Experience/accessibility | PASS | Existing dimensions/classes retained; unnamed icons hide from assistive technology; icon-only controls retain labels. |
| Verify | PASS | `pnpm typecheck`, `pnpm lint`, `pnpm test` (89 files/1,247 tests), `pnpm build`, and `pnpm audit --prod` passed. |
| Release | NOT APPLICABLE | No deployment, migration, or production mutation is authorized by this UI dependency migration. |

## App Launch Security 70-control matrix (migration scope)

Statuses apply to the changed icon/dependency surface. `NOT APPLICABLE` means this migration introduces no code path for that control; it is not an assertion about the deployed application.

| # | Status | Evidence / concrete reason |
| --- | --- | --- |
| 1 | NOT APPLICABLE | No database credential path changed. |
| 2 | NOT APPLICABLE | No environment-file or hosting configuration changed. |
| 3 | PASS | Static icon module contains no keys or secrets. |
| 4 | NOT APPLICABLE | No private route changed. |
| 5 | NOT APPLICABLE | No sensitive action changed. |
| 6 | NOT APPLICABLE | No tenant-scoped read/write changed. |
| 7 | NOT APPLICABLE | No database role/access changed. |
| 8 | NOT APPLICABLE | No database/object-storage rule changed. |
| 9 | NOT APPLICABLE | Internal-admin route authorization unchanged. |
| 10 | NOT APPLICABLE | No debug/internal tool changed. |
| 11 | NOT APPLICABLE | No CI/CD config changed. |
| 12 | NOT APPLICABLE | No error response path changed. |
| 13 | NOT APPLICABLE | No historical secrets work is in scope. |
| 14 | PASS | New client-shippable icon module has no private service credentials. |
| 15 | NOT APPLICABLE | No trusted validation/authz layer changed. |
| 16 | NOT APPLICABLE | No server input added. |
| 17 | NOT APPLICABLE | No SQL changed. |
| 18 | NOT APPLICABLE | No NoSQL query changed. |
| 19 | PASS | Icon definitions are package-controlled SVG data; no untrusted HTML is rendered by the mapping. |
| 20 | NOT APPLICABLE | No browser-authenticated state change added. |
| 21 | NOT APPLICABLE | No upload path changed. |
| 22 | NOT APPLICABLE | No user-controlled filesystem path added. |
| 23 | NOT APPLICABLE | No server-side fetch added. |
| 24 | NOT APPLICABLE | No reset flow changed. |
| 25 | NOT APPLICABLE | No session handling changed. |
| 26 | NOT APPLICABLE | No JWT handling changed. |
| 27 | NOT APPLICABLE | No CORS behavior changed. |
| 28 | NOT APPLICABLE | No costly/login/API route added. |
| 29 | NOT APPLICABLE | No staging/test config changed. |
| 30 | NOT APPLICABLE | No vendor account/configuration changed. |
| 31 | NOT APPLICABLE | No webhook changed. |
| 32 | NOT APPLICABLE | No payment entitlement logic changed. |
| 33 | NOT APPLICABLE | No object request changed. |
| 34 | NOT APPLICABLE | No API identity derivation changed. |
| 35 | NOT APPLICABLE | No logging changed. |
| 36 | NOT APPLICABLE | No production artifact configuration changed. |
| 37 | PASS | `pnpm audit --prod` completed with no known vulnerabilities. |
| 38 | PASS | pnpm generated a locked dependency resolution; only requested Free packages were added. |
| 39 | NOT APPLICABLE | No AI instruction/data boundary changed. |
| 40 | NOT APPLICABLE | No AI tool call changed. |
| 41 | NOT APPLICABLE | No database privilege changed. |
| 42 | NOT APPLICABLE | No sensitive change action added. |
| 43 | NOT APPLICABLE | No monitoring path changed. |
| 44 | NOT APPLICABLE | No backup path changed. |
| 45 | NOT APPLICABLE | No internal dashboard access control changed. |
| 46 | NOT APPLICABLE | No response security-header config changed. |
| 47 | NOT APPLICABLE | No cookie behavior changed. |
| 48 | NOT APPLICABLE | No transport/storage path changed. |
| 49 | NOT APPLICABLE | No tenant data-access layer changed. |
| 50 | PASS | Central mapping and changed imports receive typecheck, lint, tests, build, audit, and manual diff review. |
| 51 | NOT APPLICABLE | No update endpoint changed. |
| 52 | NOT APPLICABLE | No shell execution path added to the app. |
| 53 | NOT APPLICABLE | No deserialization path changed. |
| 54 | NOT APPLICABLE | No OAuth/OIDC flow changed. |
| 55 | UNKNOWN | Deployed privileged-account MFA cannot be verified from this local migration. |
| 56 | NOT APPLICABLE | No auth response changed. |
| 57 | NOT APPLICABLE | No price/credit/state transition changed. |
| 58 | NOT APPLICABLE | No concurrency-sensitive write changed. |
| 59 | NOT APPLICABLE | No webhook handler changed. |
| 60 | UNKNOWN | Deployed CI/CD credential scope is outside local repository evidence. |
| 61 | NOT APPLICABLE | No CI action or build script changed. |
| 62 | PASS | Application dependencies are lockfile-pinned; no CI action changed. |
| 63 | NOT APPLICABLE | No auth/payment/permission dependency path changed. |
| 64 | NOT APPLICABLE | No resource-consuming endpoint changed. |
| 65 | NOT APPLICABLE | No AI data path changed. |
| 66 | NOT APPLICABLE | No model output path changed. |
| 67 | NOT APPLICABLE | No agent/tool scope changed. |
| 68 | NOT APPLICABLE | No browser storage changed. |
| 69 | NOT APPLICABLE | No redirect behavior changed. |
| 70 | NOT APPLICABLE | No GraphQL/WebSocket/realtime endpoint changed. |

**Security release decision:** PASS WITH FIXES. Controls 55 and 60 remain `UNKNOWN` for any deployment release; verify them in the hosting/CI consoles before a production launch.
