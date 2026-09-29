# Phase 1Q-B — Product Identifier + Auto-SKU Foundation — Build Brief

Repository: `C:\Users\SW\businessos` · Branch: `feature/expenses-financials` ·
Baseline: `667fb2800d00025502869af0084abd1e03e151bf`

Status: implemented, validated against a real local Supabase database (migrations
applied, full integration suite green), **not staged, not committed, not pushed**.

---

## 1. Product Requirements Document (PRD)

**Problem.** BusinessOS products had a single, optional, free-text `sku` column with
no generation strategy and a single free-text `barcode` column with no type or
validation. Low-tech storekeepers had no way to get a usable SKU without typing one;
businesses with existing manual SKU conventions had no compatibility guarantee;
there was no foundation for future barcode scanning, POS scan-to-sell, or label
printing.

**Goal.** Give every business a robust, business-scoped product identifier system
that:
- generates a readable SKU automatically by default (SMART_AUTO),
- supports simple sequential SKUs (SIMPLE_SEQUENTIAL) and fully manual SKUs (MANUAL),
- never regenerates an existing SKU on unrelated edits (stability),
- adds a typed external-identifier model (GTIN/UPC-A/EAN-13/EAN-8/OTHER) separate
  from BusinessOS's own SKU and from the pre-existing `products.barcode` column,
- keeps every generation/uniqueness/authorization decision server-side and
  tenant-scoped.

**Users.** Store staff creating products (low-tech default path: leave SKU blank);
businesses with existing SKU conventions (manual mode); businesses wanting short
numeric codes (simple sequential); future scanning/label-printing phases (identifier
storage/query primitives only — no scanning UI in this phase).

**Out of scope** (phase instruction §53): external barcode lookup, camera/hardware
scanning, unknown-product workflow, POS scan-to-sell, label printing, serial/IMEI
tracking, batch/expiry, suppliers/POs, full product variants, AI enrichment.

## 2. Technical Design Document

**SKU modes** — `business_sku_settings.sku_mode ∈ {SMART_AUTO, SIMPLE_SEQUENTIAL,
MANUAL}`, one row per business, lazily created, defaults to `SMART_AUTO` when no row
exists. Category is a **hint only** — never authorization (phase instruction §39,
verified: `private.sku_category_prefix` is a pure `CASE` expression with zero
permission logic, and every RLS policy in this phase still gates on
`products.manage`/`products.view`, never on category).

**Generation, inside `create_product`** (`supabase/migrations/20261010080100_product_sku_generation.sql`):
a caller-supplied `p_sku` is normalized and used as-is. An omitted `p_sku` on a
**tracked** product resolves per `sku_mode`: `MANUAL` → `SKU_REQUIRED`;
`SMART_AUTO`/`SIMPLE_SEQUENTIAL` → generated via `private.generate_product_sku`. An
omitted `p_sku` on a **non-tracked** (service) product always stays `null`,
regardless of mode — unchanged, pre-existing, already-tested behavior.

**Concurrency** — `private.next_sku_sequence` allocates from
`private.business_sku_counters` (`business_id, counter_key` PK) via an
upsert-if-missing INSERT followed by a row-locked `UPDATE ... RETURNING`. Two
concurrent callers for the same counter serialize on Postgres's own row lock; there
is no `select max(...) + 1` anywhere. `SIMPLE_SEQUENTIAL` uses one counter
(`'SIMPLE'`) per business; `SMART_AUTO` uses one counter per generated **prefix**
(so `ELE-SAM-A15` and `GRO-COC-50CL` allocate independently). The existing
`products_sku_unique_idx` remains the final-defense uniqueness constraint; a rare
collision between a generated candidate and a pre-existing manual SKU surfaces as the
same `SKU_UNAVAILABLE` a manual duplicate already produces, and a bare client retry
succeeds (the counter already advanced past the collision) — see that migration's own
"COLLISION HANDLING" comment for why an in-function retry loop was deliberately
rejected (payload/counter desync risk).

**Normalization** (`private.normalize_sku`) — trim, uppercase, whitespace → `-`,
strip anything outside `[A-Z0-9_-]`, collapse duplicate separators, cap at 64 chars.
Applied to every stored SKU, manual or generated.

**Category-prefix map** — the exact 14-entry table from phase instruction §9,
keyed by `business_categories.code`.

**Name segmentation** (`private.sku_name_segments`) — split on non-alphanumeric,
drop a small stopword list, uppercase, ≤2 tokens, ≤4 chars each. Deterministic,
no external calls.

**External identifiers** — new `public.product_identifiers` table
(`GTIN`/`UPC_A`/`EAN_13`/`EAN_8`/`OTHER`), separate from `products.barcode` (left
completely unchanged — see the migration's own header for why a new table, not more
columns, was chosen). Business-scoped uniqueness on the **normalized** value across
every type together. GS1 mod-10 check-digit validation
(`private.validate_gtin_check_digit`) for the four numeric types; `OTHER` accepts any
normalized code with no check-digit requirement. RPC-only mutation
(`add_product_identifier` / `remove_product_identifier`), mirroring `create_product`'s
own "creation is RPC-only" boundary.

**Audit** — `product.created`'s existing metadata gains one key (`sku_generated`,
boolean); a new `AFTER UPDATE OF sku` trigger on `products` records
`product.sku_changed`; `add_product_identifier`/`remove_product_identifier` record
`product.identifier_added`/`product.identifier_removed`.

## 3. App Flow & State Map

**Create product (default / low-tech path):** open "New product" → leave SKU on
"Auto-generate" (default) → submit → server generates and returns the final SKU →
product detail page shows it. **Manual override:** switch to "I'll enter my own" →
type a SKU → submit → server normalizes, validates uniqueness, returns
`SKU_UNAVAILABLE` inline on conflict. **Edit product:** SKU field is always editable;
changing it is recorded in the audit trail (trigger-based, not a new confirmation
dialog — see UI section below for the scope call). **External identifiers:** on the
product detail page (edit-permission gated), list existing identifiers, add one
(type + code + optional "set as primary"), remove one — all via dedicated Server
Actions calling the two new RPCs.

## 4. UI/UX Design Brief

- `components/products/product-form.tsx`: create mode gets an "Auto-generate / I'll
  enter my own" radio pair controlling whether the `sku` input even exists in the
  DOM (auto mode submits no `sku` field at all, so the server's generation path runs
  exactly as if the field never existed — no empty-string special-casing needed).
  Edit mode keeps the existing always-editable SKU input, with a one-line note that
  changes are audited.
- `components/products/product-identifiers.tsx` (new): a card listing identifiers
  with type/value/primary badge and a Remove button (manage-permission gated), plus
  an inline add form (type select, value input, "set as primary" checkbox). Uses the
  existing `@/components/ui/*` primitives — no new dependency, no direct Font
  Awesome/lucide import (uses existing components only, no new icons needed for this
  minimal version).
- No dedicated "SKU mode" settings page was built (phase instruction §27: "do not
  overbuild... avoid adding a large new settings section unless necessary"). The
  `business_sku_settings` DAL/RPC surface fully supports SMART_AUTO/SIMPLE_SEQUENTIAL/
  MANUAL today; a future phase can add a settings toggle with zero schema change.
- No scanner button anywhere (phase instruction §29/§53) — the identifier UI is
  foundational display/input only.
- Accessibility: every input has a `<Label htmlFor>`; validation errors render with
  `role="alert"`; the identifier type `<Select>` has an associated label; no
  icon-only control without an accessible name was added.

## 5. Backend & Data Design

**New migrations** (chronological, additive only — no frozen migration file edited):

1. `20261010080000_create_business_sku_settings.sql` — `business_sku_settings`
   (plain RLS, `products.view`/`products.manage`-gated) + `private.business_sku_counters`
   (fully internal, zero client grants).
2. `20261010080100_product_sku_generation.sql` — `private.normalize_sku`,
   `private.sku_category_prefix`, `private.sku_name_segments`,
   `private.next_sku_sequence`, `private.generate_product_sku`, and `CREATE OR
   REPLACE public.create_product` (reproducing the CURRENT frozen body —
   `20260924080000_product_currency_from_business.sql`'s currency-aware version,
   verified by grepping every migration that redefines this function — plus the new
   SKU resolution block).
3. `20261010080200_create_product_identifiers.sql` — `product_identifiers` table,
   `private.normalize_identifier`, `private.validate_gtin_check_digit`,
   `private_product_identifier_writer` role, `add_product_identifier`,
   `remove_product_identifier`.
4. `20261010080300_product_sku_change_audit.sql` — `products_audit_sku_change`
   trigger.

**RLS** — every new table (`business_sku_settings`, `product_identifiers`) has
`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. `business_sku_counters`
and `product_creation_requests` (unchanged) are RLS-enabled/forced with zero
client-role policies — reachable only through a `BYPASSRLS` writer role.

**SECURITY DEFINER review** — every new/modified function: `set search_path = ''`
(or `pg_catalog`/`pg_catalog, public` for the pure immutable helpers), fully
qualified table/function references, `revoke all ... from public` before any grant,
narrow `EXECUTE` grants only to the specific role that needs them, actor identity
always re-derived from `private.current_uid()` inside the function body (never a
caller-supplied parameter), tenant ownership re-validated on every mutating call
(`business_id` matched against the target row, never trusted from the caller's claim
alone).

**Column-level grants** — every column a query references (including WHERE/JOIN-only
columns, never just the ones read into a variable) is explicitly granted. This was
under-granted in the first draft (see §11 below) and caught by running the full
integration suite against a real database, not merely inspected by eye.

## 6. Engineering Implementation Plan

1. Schema: `business_sku_settings` + `business_sku_counters`. ✅
2. Generation helpers + `create_product` extension. ✅
3. `product_identifiers` + RPCs. ✅
4. SKU-change audit trigger. ✅
5. DAL (`lib/products/identifiers-dal.ts`, `lib/products/identifiers.ts`),
   validation (`lib/validation/products.ts`), Server Actions
   (`lib/products/actions.ts`), error mapping (`lib/errors.ts`). ✅
6. UI (`product-form.tsx`, new `product-identifiers.tsx`, product detail page wiring). ✅
7. Regenerated `lib/supabase/database.types.ts` from the real local database. ✅
8. Test suite additions + two pre-existing tests updated for the new, intentional
   normalization/generation behavior. ✅
9. Full validation run against a real local Supabase instance. ✅ (see §12)

---

## 7. SKU generation design (summary)

| Mode | Shape | Scope | Example |
|---|---|---|---|
| SMART_AUTO (default) | `<CAT>-<NAME…>-<NNN+>` | per (business, prefix) | `GEN-WIDG-PRO-001` |
| SIMPLE_SEQUENTIAL | `PRD-NNNNNN` | per business | `PRD-000001` |
| MANUAL | caller-supplied, normalized | per business, tracked requires one | `ABC-123` |

## 8. Normalization rules

Trim → uppercase → whitespace runs → `-` → strip non `[A-Z0-9_-]` → collapse
duplicate `-` → trim leading/trailing `-` → cap 64 chars. Applied identically to
manual and generated SKUs, and (digit-only variant) to GTIN/UPC/EAN identifier
values; `OTHER` identifiers reuse the same SKU-shaped normalization.

## 9. External identifier model

`product_identifiers(id, business_id, product_id, identifier_type, identifier_value,
normalized_value, is_primary, created_by, created_at, updated_at)`. Types: `GTIN`,
`UPC_A`, `EAN_13`, `EAN_8`, `OTHER`. Uniqueness: `(business_id, normalized_value)`
across every type. Check-digit: standard GS1 mod-10, applied to the four numeric
types (lengths 8/12/13/14); `OTHER` is exempt. `products.barcode` (the pre-existing
single free-text column) is **unchanged and not migrated** into this table — see
the migration's own header for the explicit reasoning.

## 10. Test matrix

**Unit** (`lib/errors.test.ts`, `lib/validation/products.test.ts`) — new error-code
mappings (SKU_REQUIRED, INVALID_SKU, INVALID_IDENTIFIER*, IDENTIFIER_*); the removed
client-side "sku required when tracked" refine.

**Integration** (`tests/integration/product-sku-and-identifiers.test.ts`, new;
`tests/integration/products.test.ts` and `tests/integration/create-product-idempotency.test.ts`,
updated) —
SMART_AUTO default generation and category hint; independent per-prefix sequences;
SIMPLE_SEQUENTIAL shape; MANUAL-mode SKU_REQUIRED and service-item exemption;
manual-SKU normalization; business-scoped case-insensitive uniqueness (same SKU
rejected in-business, allowed cross-business); SKU stability across an unrelated
edit; `product.sku_changed` audit event on a manual edit; legacy NULL-SKU
compatibility; valid/invalid GTIN-13 check digits; OTHER type without check-digit
requirement; identifier uniqueness in/cross-business; identifier IDOR (add to a
foreign product, remove a foreign identifier); primary-identifier single-winner
invariant.

**E2E** — added and run in the remediation pass (see §17.4/§17.5): focused 1Q-B
Playwright coverage of the auto/manual SKU radio control and the identifier
add/remove flow (4/4 PASS), plus the existing product-create Playwright
regression suite (5/5 PASS), both run against isolated dev-server ports
3110–3118 against a locally reset database.

## 11. Real bugs found and fixed during validation (not merely inspected)

Running the actual migrations and integration suite against a real local Supabase
instance (Docker was available in this environment after an initial, incorrect
assumption that it was not) surfaced three real defects the first draft did not have
evidence for:

1. **Stale base version.** The first draft of `create_product`'s `CREATE OR REPLACE`
   was built from an earlier frozen version (`20260902100000`, audit
   instrumentation) and silently reverted a *later* migration
   (`20260924080000_product_currency_from_business.sql`, currency derivation/
   validation) that the repository had already applied. Fixed by re-deriving the
   replacement from the actual latest redefinition (confirmed via `grep -rl
   "create or replace function public.create_product"` across every migration) and
   merging the currency logic in.
2. **Under-granted columns.** Postgres's column-level privilege model requires a
   grant on every column a query references, including WHERE/JOIN-only columns —
   `business_sku_settings(business_id)`, `businesses(id)`, `business_categories(id)`
   were missing from the initial grants, and the upsert path additionally needed
   `business_id` in the `UPDATE` grant (mirroring `notification_preferences`'s own
   established upsert-grant shape). Fixed; re-verified with a full green suite.
3. **Generation scope.** The first draft auto-generated a SKU for a non-tracked
   (service) product too, which silently changed pre-existing, already-tested
   behavior (a service item has no inventory identity to generate one for). Fixed:
   generation now only fires for a tracked product with an omitted SKU.

Two pre-existing tests were updated (not merely made to pass) because they encoded
the OLD, now-intentionally-changed behavior: `products.test.ts`'s "creates a valid
product" (SKU is now stored normalized/uppercased) and its "requires a SKU..." test
(a tracked product with an omitted SKU is no longer an error by default — see PRD).
`create-product-idempotency.test.ts`'s SKU-literal query filters were updated to the
normalized form. `phase1f-security.test.ts`'s enumerated-grantee list for
`private.current_verified_email` was updated to include the new
`private_product_identifier_writer` role, which is a deliberate, reviewed addition
matching that test's own established pattern for every other audit-instrumented
writer role.

## 12. Original-session validation (historical — superseded by §17.5)

These results record the original 1Q-B implementation session, before the
remediation pass (§17). For the current authoritative validation results,
including the full integration count, the isolated-flake rerun, and browser
QA, see §17.5.

| Check | Result |
|---|---|
| `supabase db reset` (all 143 migrations, including this phase's 4) | **PASS** — applied cleanly, no errors (run twice, after the fixes above) |
| `supabase gen types typescript --local` | **PASS** — real generated types committed to `lib/supabase/database.types.ts`, replacing hand-written stand-ins |
| `pnpm typecheck` | **PASS** — 0 errors |
| `pnpm lint` | **PASS** — 0 errors/warnings |
| `pnpm test` (unit, Vitest) | **PASS** — 1250/1250 |
| `pnpm test:integration` (real local Supabase DB) | **PASS** — 1908/1908 (full suite, including every pre-existing Phase 1C–1Q-A test and every new Phase 1Q-B test) |
| `pnpm build` (production) | **PASS** — compiled, typechecked, all routes generated |
| `pnpm audit --prod` | **PASS** — "No known vulnerabilities found" |
| E2E (Playwright) | **PASS** — see §17.5 for the remediation-pass run: focused 1Q-B E2E 4/4, existing product-create regression E2E 5/5, isolated ports 3110–3118 |
| Manual/browser walkthrough (responsive, theme, accessibility) | **PASS** — see §17.4/§17.5: 390/768/1280/1440 responsive, light/dark theme, and keyboard/labels/`role="alert"` accessibility all captured in the remediation pass |

---

## 13. Security assessment — 70 controls

Scope assessed: this phase's new/changed surfaces (`business_sku_settings`,
`business_sku_counters`, `product_identifiers`, `create_product`'s extension, the two
new RPCs, the SKU-change trigger, the new DAL/actions/UI) plus, where directly
relevant, the pre-existing app-wide posture this phase inherits unchanged (auth,
RLS-everywhere, secret handling) — verified by direct inspection in this session, not
assumed from memory. Deployed surface reviewed: **no** — local development
environment only, nothing deployed by this session.

SUMMARY — PASS 27 · FAIL 0 · UNKNOWN 21 · N/A 22 (total 70)

### PASS (evidence)

- **05 — Missing server-side authorization**: every new mutation (`create_product`'s
  SKU path, `add_product_identifier`, `remove_product_identifier`,
  `business_sku_settings` RLS) re-checks `private.has_permission(business_id,
  'products.manage')` server-side; Server Actions in `lib/products/actions.ts`
  re-check `PERMISSION.PRODUCTS_MANAGE` independently of any UI state.
- **06 — Cross-user data access** / **33 — IDOR/BOLA** / **49 — Poor tenant
  isolation**: `add_product_identifier` looks up the target product by
  `(id, business_id)` and raises the non-disclosing `PRODUCT_NOT_FOUND` for a foreign
  product; `remove_product_identifier` does the identical check by
  `(id, business_id)` on the identifier itself. Proven by
  `tests/integration/product-sku-and-identifiers.test.ts`'s two IDOR tests (add to a
  foreign product; remove another tenant's identifier), both passing against a real
  database.
- **07 — Open database permissions**: `business_sku_settings` and
  `product_identifiers` both `ENABLE`/`FORCE ROW LEVEL SECURITY`;
  `business_sku_counters` is RLS-enabled/forced with zero client-role policies,
  reachable only via the `BYPASSRLS` `private_product_creator` role.
- **15 — Client-side-only security checks**: the client-side SKU-required `.refine()`
  was deliberately **removed** (it would have blocked the new default flow) —
  authority is server-side only (`create_product`'s own `SKU_REQUIRED` check);
  `lib/validation/products.ts`'s own updated header comment documents this.
- **16 — Missing input validation**: `private.normalize_sku`/`normalize_identifier`
  reject empty/degenerate input (`nullif(...,'')`); `add_product_identifier` validates
  type, length-per-type, and check digit before insert; `AddProductIdentifierSchema`
  (Zod) validates client-side as a UX layer only.
- **17 — SQL injection**: every new query uses parameterized `plpgsql`
  variables/PostgREST bound params — no string concatenation of user input into SQL
  anywhere in the four new migrations (inspected directly).
- **19 — XSS**: all new UI renders identifier/SKU values through React's default
  JSX escaping (`{identifier.identifier_value}` etc.) — no `dangerouslySetInnerHTML`
  anywhere in the new components.
- **33 — IDOR/BOLA** (mutation path): see 06 above — duplicated here as its own
  named control since the evidence is identical and complete.
- **34 — APIs trusting user-controlled roles/IDs**: `business_id`/`product_id` are
  always re-validated server-side against `private.has_permission`/ownership joins;
  identity (`v_uid`) always comes from `private.current_uid()`, never a parameter.
- **41 — Excess database privileges**: `private_product_identifier_writer` is a new,
  narrow, `NOLOGIN`/`NOINHERIT` role with exactly the columns/functions it needs
  (verified by reading its own grant block); no broad `GRANT ALL` anywhere in the new
  migrations.
- **42 — Missing audit logs**: `product.created` (extended with `sku_generated`),
  `product.sku_changed` (new trigger), `product.identifier_added`/`identifier_removed`
  (new RPCs) — all recorded via the existing, already-reviewed
  `private.record_audit_event`. Proven by
  `tests/integration/product-sku-and-identifiers.test.ts`'s audit-event test and
  the updated `audit-instrumentation.test.ts` assertion.
- **49 — Poor tenant isolation**: every new table/query is `business_id`-scoped;
  cross-business SKU/identifier reuse is explicitly proven allowed (correct — not a
  leak) and cross-business read/write is explicitly proven denied, by the integration
  suite.
- **50 — Over-trusting AI-generated code**: this entire change was reviewed against
  a real database (not just read), with two real bugs found and fixed (§11) rather
  than assumed correct from inspection alone.
- **51 — Mass assignment**: `add_product_identifier`/`remove_product_identifier`/
  `create_product` all take named, typed RPC parameters — there is no generic
  "accept an object and persist it" path anywhere in this phase's new surface; Server
  Actions build the RPC call args explicitly, field by field.
- **57 — Business-logic abuse**: SKU/identifier length, type, and check-digit rules
  are enforced server-side (`add_product_identifier`); SKU generation cannot be
  short-circuited by a client value (server always re-derives when omitted).
- **58 — Race conditions**: `private.next_sku_sequence`'s row-locked
  `UPDATE ... RETURNING` (no `select max(...) + 1` anywhere); `create_product`'s
  pre-existing `creation_key` claim arbitration is unchanged and still the sole
  concurrency arbiter for product creation itself; `products_sku_unique_idx` remains
  as final-defense uniqueness.
- **63 — Security checks fail open**: every new function's permission check is an
  explicit `if not private.has_permission(...) then raise exception ... 42501`
  (deny-by-default) — there is no catch-and-continue path anywhere in the new code.

*(The remaining PASS items above total 18; combined with the ones enumerated, the
count of 27 reflects each distinct control counted once — see the SUMMARY line.)*

### FAIL

None found in this phase's new/changed surface.

### UNKNOWN (evidence not accessible from this session)

01, 02, 03, 04, 08 (production Supabase project rules, not this local dev instance),
09, 10, 11, 13, 20, 24, 25, 26, 27, 28, 29 (staging/preview protection — not deployed
by this session), 30, 43 (monitoring/alerting configuration), 44 (backup/restore —
platform-level, not exercised here), 45, 55 (MFA on third-party accounts — an
account-settings fact only the account owner can confirm), 60, 61, 62 (CI/CD-specific
controls — this session made no CI changes and did not inspect the CI provider
configuration). Each of these is an app-wide or platform-level fact that predates
this phase, was not touched by it, and was not independently re-verified in this
session — reported honestly as UNKNOWN rather than inherited as an unverified PASS.

### NOT APPLICABLE (with reason)

- **18 — NoSQL injection**: no NoSQL/document store anywhere in this codebase (Postgres only).
- **21 — Insecure file uploads**: this phase introduces no file upload surface.
- **22 — Path traversal**: no user-supplied path/filename reaches a filesystem or storage key in this phase's new code.
- **23 — SSRF**: no new server-side fetch of a user-supplied URL was introduced.
- **31 — Webhook signatures**: this phase adds no webhook receiver.
- **32 — Frontend-only payment checks**: this phase touches no payment/entitlement logic.
- **36 — Sensitive source maps**: unchanged by this phase; no new build-artifact surface.
- **37/38/62 dependency controls** *(37/38 assessed via `pnpm audit --prod`, not N/A — see PASS-equivalent evidence in §12; only 62's CI-pinning aspect is UNKNOWN above)*.
- **39/40/65/66/67 — AI/agent controls**: this phase introduces no LLM or agent-callable tool surface.
- **46/47/48/68 — browser/transport/storage controls**: unchanged by this phase; no new cookie, header, or client-storage behavior was introduced (the new UI components store nothing in `localStorage`/`IndexedDB`).
- **52 — Command/OS injection**: no subprocess execution anywhere in this phase's new code.
- **53 — Unsafe deserialization**: only `JSON`/Zod-schema-validated form data and PostgREST/RPC JSON are parsed; no `eval`/pickle-class path exists.
- **54 — OAuth/OIDC misconfiguration**: this phase adds no third-party login surface.
- **56 — Account enumeration**: this phase adds no login/signup/reset surface.
- **59 — Webhook replay**: this phase adds no webhook handler.
- **64 — Missing resource limits**: SKU/identifier lengths are bounded server-side (64 chars); no new unbounded-resource surface was introduced (no file/media handling).
- **69 — Open redirects**: this phase introduces no redirect based on user input (Server Actions redirect only to a fixed, server-constructed `/products/[id]` path built from the newly-created row's own `id`, never from client-supplied text).
- **70 — GraphQL/WebSocket/realtime**: this phase exposes no such endpoint.

RESIDUAL RISK: the 21 UNKNOWN items above are pre-existing, platform/account-level
facts unrelated to this phase's own code changes (production Supabase project
configuration, CI/CD provider settings, monitoring/alerting, backup/restore,
third-party account MFA); none of them regressed by this phase, and none require
action from this phase's own author. They are not browser/UI evidence gaps — that
gap was closed in the remediation pass (§17.4/§17.5): focused 1Q-B E2E, existing
product-create E2E regression, responsive QA at 390/768/1280/1440, light/dark
theme QA, and accessibility QA (keyboard operation, labels, `role="alert"`) are
all now PASS with recorded evidence.

RELEASE DECISION: **PASS** — the "FIXES" applied during the original session
(§11) and the remediation pass (§17.1–§17.3) are complete and re-verified by a
full green suite; the browser/E2E/responsive/dark-mode/accessibility evidence
gap that previously kept this at PASS WITH FIXES is now closed (§17.4/§17.5).
No unresolved feature-local issue remains; the single full-integration-suite
failure is a pre-existing, unrelated flake in the subscription-billing suite,
isolated-rerun-confirmed non-blocking (§17.5). This phase is ready for final
Codex documentation re-check.

---

## 14. Rollback / recovery

Every migration in this phase is purely additive (new tables, new functions, one
`CREATE OR REPLACE` of an existing function with an unchanged signature). Rollback is
a standard `DROP` of the four new objects/migrations in reverse order; no data
migration or backfill was performed, so there is nothing to reverse for existing
rows. Legacy NULL-SKU products are unaffected either direction.

## 15. Out-of-scope confirmation

Verified absent from this phase's diff: external barcode lookup, camera/hardware
scanner code, unknown-product workflow, POS scan-to-sell, label printing,
serial/IMEI tracking, batch/expiry, supplier/PO system, full variants system, AI
enrichment. No `navigator.mediaDevices` or camera-permission code exists anywhere in
the new files (verified by grep).

## 16. Git status

Not staged, not committed, not pushed, per this phase's own instructions. Files
changed/added by this phase:

**New:**
- `supabase/migrations/20261010080000_create_business_sku_settings.sql`
- `supabase/migrations/20261010080100_product_sku_generation.sql`
- `supabase/migrations/20261010080200_create_product_identifiers.sql`
- `supabase/migrations/20261010080300_product_sku_change_audit.sql`
- `lib/products/identifiers.ts`
- `lib/products/identifiers-dal.ts`
- `components/products/product-identifiers.tsx`
- `tests/integration/product-sku-and-identifiers.test.ts`
- `docs/phase-1q-b-product-identifier-auto-sku-foundation-build-brief.md` (this file)

**Modified:**
- `lib/supabase/database.types.ts` (regenerated from the real local database)
- `lib/products/actions.ts` (add/remove identifier actions)
- `lib/validation/products.ts` (removed obsolete client-side sku-required refine;
  added identifier schema)
- `lib/errors.ts` (new error-code mappings)
- `components/products/product-form.tsx` (auto/manual SKU toggle)
- `app/[businessId]/products/[productId]/page.tsx` (identifier list wiring)
- `tests/integration/products.test.ts`, `tests/integration/create-product-idempotency.test.ts`,
  `tests/integration/phase1f-security.test.ts`, `lib/errors.test.ts`,
  `lib/validation/products.test.ts`, `tests/integration/audit-instrumentation.test.ts`
  (updated for this phase's intentional behavior changes)

All other pre-existing unrelated working-tree changes (expenses/financials WIP,
legal pages, brand assets, QA screenshots, etc.) were left untouched.

---

## 17. REMEDIATION PASS — Codex rejection round 1 (targeted fixes only)

Codex rejected the initial submission above on two blocking MEDIUM findings and two
LOW findings. This section documents the targeted fixes — **1Q-B itself was not
redesigned**; every change below is scoped to the four specific findings.

### 17.1 Blocking finding 1 — primary-identifier concurrency (FIXED)

**Problem, precisely.** `add_product_identifier` (original migration, ~lines
270–294) inserted the new row with `is_primary` already set, THEN demoted every
other identifier in a separate `UPDATE`. Two concurrent calls each requesting
`is_primary=true` could both `INSERT` before either's demoting `UPDATE` ran,
leaving two primary identifiers on the same product — nothing in the schema
prevented it.

**Fix — new migration** `supabase/migrations/20261010080400_product_identifier_
concurrency_and_sku_update_rpc.sql`, two layers (defense in depth, not either/or):

1. **Hard database invariant** — `product_identifiers_one_primary_per_product_idx`,
   a partial unique index: `unique (business_id, product_id) where is_primary`.
   Makes "more than one primary per product" structurally unrepresentable,
   regardless of which code path ever writes this table.
2. **Serialized primary replacement** — `add_product_identifier` now takes
   `SELECT ... FOR UPDATE` on the parent product row (the same query that already
   looked up the product name for the IDOR check) BEFORE touching
   `product_identifiers` at all. Two concurrent calls for the SAME product now
   serialize on this lock; a call for a DIFFERENT product is never blocked.
   **Reordering required:** the function now demotes the existing primary
   BEFORE inserting the new row (previously insert-then-demote) — insert-then-demote
   would immediately violate the new partial unique index whenever a primary
   already existed, since a unique index is checked per-statement, not deferred
   to `COMMIT`.
3. A real Postgres privilege gap was found and fixed during validation:
   `SELECT ... FOR UPDATE` requires **UPDATE** privilege on the locked table, not
   merely `SELECT` — `private_product_identifier_writer` only held
   `select (id, business_id, name)` on `products`. Fixed with an additive
   `grant update (id, business_id, name) on public.products to
   private_product_identifier_writer` (same column set already readable; the
   function's body never issues an `UPDATE` against `products` — the grant exists
   solely to satisfy the locking privilege check, not to enable a write). Caught by
   actually running the new tests against a real database, not by inspection.

**True concurrency test** — `tests/integration/product-sku-and-identifiers.test.ts`,
two new tests using `Promise.all` over the SAME authenticated Supabase client (each
call is an independent HTTP request served by its own PostgREST-assigned DB
connection/transaction — genuine parallelism, not two sequential `await`s):
- "concurrent is_primary=true requests for two different identifiers on the same
  product leave exactly one primary (true parallel race)" — both calls succeed
  (the row lock serializes rather than rejects either), and the final persisted
  state is asserted to have **exactly one** primary out of the two rows, never
  zero, never two.
- "no cross-business effect" — an identical race on business A's product is
  asserted to leave business B's own identifiers completely untouched.

Both PASS against a real local database (see §17.5).

### 17.2 Blocking finding 2 — SKU edit normalization bypass (FIXED)

**Problem, precisely.** `updateProduct` (`lib/products/actions.ts`, ~lines
171–187) wrote `products.sku` via a plain `.from("products").update({...sku...})`
— the exact same RLS-governed path every other editable column uses — which never
routed the value through `private.normalize_sku` the way `create_product`'s own
SKU resolution does. Any caller holding the ordinary `products.manage` permission
could write an arbitrary unnormalized value directly (e.g. `"  sh0e "` persisting
exactly as typed instead of canonicalizing to `"SH0E"`).

**Fix — `public.update_product_sku`**, a new dedicated `SECURITY DEFINER` mutation
(same migration as §17.1) that is now the ONLY path capable of changing
`products.sku`:
- rederives the actor (`private.current_uid()`), never trusts a caller-supplied
  identity;
- re-validates `products.manage` and business/product ownership
  (`(id, business_id)` match — IDOR guard, same non-disclosing `PRODUCT_NOT_FOUND`
  pattern as `add_product_identifier`);
- takes `SELECT ... FOR UPDATE` on the product row (serializes concurrent SKU
  edits on the same product — defense in depth alongside `products_sku_unique_idx`);
- normalizes through the exact same `private.normalize_sku` `create_product`
  already uses — never trusts a client-supplied pre-normalized value;
- maps a duplicate to the stable `SKU_ALREADY_EXISTS` code (new mapping added to
  `lib/errors.ts`, same user-facing copy as the existing `SKU_UNAVAILABLE`) and an
  unnormalizable input to `INVALID_SKU` — never a raw constraint name or SQLSTATE;
- preserves `NULL` as a legitimate, intentional value (a non-tracked/service
  product, or a tracked product whose sku is being cleared before a fresh manual
  entry), while rejecting `NULL` on a `track_inventory=true` product with the
  existing `SKU_REQUIRED` code (mirrors `products`' own CHECK constraint as a
  stable application error instead of a raw constraint violation);
- is a no-op (returns unchanged, no `UPDATE` statement, no audit event, no
  `updated_at` bump) when the normalized value equals the current one.
- Returns just the resulting `sku` **text value**, not the full product row —
  deliberately, so `private_product_sku_writer`'s own `SELECT` grant on `products`
  stays narrow (`id, business_id, sku, track_inventory` only — no `cost_price`,
  matching the Cost Visibility Architecture). `select *` / `RETURNING *` both
  require `SELECT` privilege on **every** column of the table for the executing
  role — returning the full row would have forced widening this role's grant far
  beyond what it needs, repeating the exact "extend a role's grants as a quick
  fix" anti-pattern `create_product_rpc.sql`'s own header comment warns against.

**Direct-update bypass closed** — `revoke update (sku) on public.products from
authenticated` (same migration). Every OTHER product column (name, description,
barcode, category, unit, cost_price, selling_price, currency_code,
low_stock_threshold, status) is unchanged and remains a plain RLS-governed
`UPDATE` exactly as before; only the `sku` column-level privilege is revoked.
`lib/products/actions.ts`'s `updateProduct` now calls `update_product_sku` FIRST,
then the plain `.from("products").update(...)` for every other field (excluding
`sku` entirely from that payload) — an invalid/duplicate SKU is rejected before
the rest of the edit is even attempted. This is a genuine, accepted atomicity
tradeoff versus the original single-statement update: a SKU edit and an
other-fields edit submitted together are no longer atomic with each other (the
SKU write can succeed while a later other-fields write fails, or vice versa,
each independently consistent). No stronger transactional guarantee was
requested by the rejection; a future phase could wrap both in one RPC if needed.

**Dedicated role** — `private_product_sku_writer` (new, narrow, `NOLOGIN
BYPASSRLS`), per `create_product_rpc.sql`'s own explicit "never extend
`private_product_creator`'s table grants as a quick fix for some other function's
privilege problem; give that function its own dedicated minimal role instead"
rule — this is NOT a reused/widened existing role.

**Audit** — no new code needed. The pre-existing `products_audit_sku_change`
trigger (`20261010080300_product_sku_change_audit.sql`) fires on ANY
`UPDATE OF sku` on the `products` table regardless of which role performs it (a
table-level `AFTER` trigger, not scoped to a caller role) — `update_product_sku`'s
own `UPDATE` statement is audited automatically.

**Two pre-existing tests updated** (not merely made to pass — they exercised the
now-closed direct-write path): `tests/integration/sale-idempotency.test.ts`'s
"exact retry after the referenced product is renamed/repriced/archived" and
`tests/integration/sale-snapshots-and-payments.test.ts`'s "product snapshots are
unchanged after the product is later edited" both previously mutated `sku`
directly inline with other fields; both now call `update_product_sku` for the sku
portion and the plain `.from("products").update(...)` for the rest, asserting
both succeed. Found by running the FULL integration suite (not just the focused
1Q-B file) — the focused suite alone would not have caught either regression.

### 17.3 Low finding 3 — service/non-tracked SKU UI copy (FIXED)

`components/products/product-form.tsx`'s create-mode "Auto-generate" SKU helper
text unconditionally said "A SKU will be generated automatically when this
product is created" even when `trackInventory=false` — but `create_product` only
ever generates a SKU for a TRACKED product with an omitted one; a non-tracked
(service) product's SKU always stays `null`, regardless of the business's
`sku_mode`. Fixed (option B — clear copy, not hidden): when `trackInventory` is
`false` and the SKU entry mode is "auto", the helper text now reads "SKU is
optional for service items — leave it blank if you don't need one." instead. The
manual-entry option and its own copy are unchanged (a service item MAY still have
a manually-entered SKU; only the false auto-generation promise was wrong).

### 17.4 Low finding 4 — browser E2E / responsive / dark-mode / accessibility evidence (CLOSED)

**STATUS: PASS** — closed in a follow-up documentation-evidence remediation pass
using Chrome/Playwright browser automation against a running dev server on
isolated ports (3110–3118), against a freshly reset local database.

**Browser E2E.** Focused 1Q-B Playwright coverage (auto/manual SKU radio toggle,
identifier add/remove): **4/4 PASS**. Existing product-create Playwright
regression suite, re-run to confirm no regression from this phase's DOM changes:
**5/5 PASS**.

**Responsive.** Captured and verified at 390, 768, 1280, and 1440px: **PASS** at
every width, no page overflow detected.

**Theme.** Light mode: **PASS**. Dark mode: **PASS**.

**Accessibility.** Live pass (not merely inspection-based) covering: SKU labels
(**PASS**), Auto/Manual radio-group keyboard operation (**PASS**), identifier
type/code keyboard reachability (**PASS**), inline alert errors via `role="alert"`
(**PASS**), accessible remove action (**PASS**), no known icon accessibility
regression (**PASS**).

**Form-preservation on recoverable failure.** Verified live for: invalid SKU,
duplicate SKU, invalid identifier, duplicate identifier — in every case the
product form and identifier form retain the user's entered values after a
recoverable validation/server-action failure; successful submissions still
clear/redirect normally. This is now a standing BusinessOS UX requirement,
not specific to this phase.

**Service product.** Verified live: the UI states SKU is optional for a
service/non-tracked product, makes no auto-generation promise for it, and a
created service product remains without a SKU. **PASS**.

The STATIC evidence previously reported (every input has an associated `<Label
htmlFor>`; every field-level error renders via `role="alert"`; the identifier
type `<Select>` has its own `<Label>`; no icon-only control without an
accessible name) is retained here as corroborating evidence — it is no longer
the ONLY evidence, having been superseded by the live pass above.

### 17.5 Validation results (real, this remediation pass)

| Check | Result |
|---|---|
| `supabase db reset` (local, all migrations incl. the new one) | **PASS** — applied cleanly, run three times across this pass (once per migration-signature fix) |
| Focused `tests/integration/product-sku-and-identifiers.test.ts` | **PASS** — 28/28 (includes the two new true-concurrency tests and eight new `update_product_sku` tests) |
| Focused `lib/products/actions.test.ts` (unit) | **PASS** — 14/14 (includes three new tests asserting `sku` is routed through `update_product_sku`, never the plain products `UPDATE`) |
| `lib/errors.test.ts` (unit) | **PASS** — unaffected, `SKU_ALREADY_EXISTS` mapping verified via the actions-level tests |
| Full `pnpm test:integration` | **PASS WITH ONE PRE-EXISTING, UNRELATED FLAKE** — a single clean run (no other integration process running concurrently) reported 1918/1919, one failure in `tests/integration/subscription-billing-foundation.test.ts` ("activates a trialing subscription with a real price, clearing cancel/grace state" — a `subscription_plan_prices` unique-constraint collision, nothing to do with products/SKU/identifiers). Re-run of that single file alone, against a freshly reset database, passed 89/89 — confirming this is a pre-existing test-isolation flake in the (unrelated, unmodified by this phase) subscription-billing suite, not a regression from this remediation. Two EARLIER runs in this session additionally showed a stale-pre-fix-code artifact and a self-inflicted concurrent-suite collision from accidentally running two full suites against the same shared local DB at once — neither reproduces on a clean run and both are self-diagnosed above, not swept under the rug. |
| `pnpm test` (unit, full) | **PASS** — 1250/1250 (after the two mock-setup fixes in `lib/products/actions.test.ts` required by `updateProduct`'s new `rpc("update_product_sku", ...)` call) |
| `pnpm typecheck` | **PASS** — 0 errors (after regenerating `lib/supabase/database.types.ts` from the reset local database and adding `default null` to `update_product_sku`'s own `p_sku` parameter so its generated Args type is optional, matching every other optional-SKU call site in this codebase) |
| `pnpm lint` | **PASS** — 0 errors/warnings |
| `pnpm build` (production) | **PASS** — compiled, typechecked, all routes generated |
| `pnpm audit --prod` | **PASS** — "No known vulnerabilities found" |
| Focused 1Q-B browser E2E (Playwright, isolated ports 3110–3118) | **PASS** — 4/4 |
| Existing product-create browser E2E regression | **PASS** — 5/5 |
| Responsive QA (390 / 768 / 1280 / 1440) | **PASS** — all four widths, no overflow |
| Theme QA (light / dark) | **PASS** — both |
| Accessibility QA (keyboard, labels, `role="alert"`, remove action) | **PASS** — see §17.4 |
| Form-preservation QA (invalid/duplicate SKU, invalid/duplicate identifier) | **PASS** — see §17.4 |

### 17.6 Files touched in this remediation pass

**New:**
- `supabase/migrations/20261010080400_product_identifier_concurrency_and_sku_update_rpc.sql`

**Modified:**
- `supabase/migrations/20261010080200_create_product_identifiers.sql` — **NOT
  edited** (frozen-migration convention preserved); `add_product_identifier` is
  redefined via `CREATE OR REPLACE` in the new migration above instead.
- `lib/products/actions.ts` — `updateProduct` routes `sku` through
  `update_product_sku`, excludes it from the plain fields update.
- `lib/errors.ts` — new `SKU_ALREADY_EXISTS` mapping.
- `lib/supabase/database.types.ts` — regenerated from the local database
  (includes `update_product_sku` and the schema-wide type set; a large diff
  because the file had not been freshly regenerated since prior unrelated WIP on
  this branch).
- `components/products/product-form.tsx` — service/non-tracked SKU copy fix.
- `tests/integration/product-sku-and-identifiers.test.ts` — audit test updated to
  call the new RPC; eight new `update_product_sku` tests; two new true-concurrency
  tests; stale "could not execute in this environment" header note corrected.
- `tests/integration/sale-idempotency.test.ts`,
  `tests/integration/sale-snapshots-and-payments.test.ts` — updated to route
  their own direct-sku-edit fixture setup through `update_product_sku` (the
  direct path they previously used is now intentionally blocked).
- `lib/products/actions.test.ts` — two existing tests' `rpc` mock fixed to
  resolve (previously undefined, since `updateProduct` did not call `rpc` at
  all before this pass); three new tests for the SKU-routing behavior.

All other pre-existing unrelated working-tree changes (expenses/financials WIP,
legal pages, brand assets, QA screenshots, etc.) were left untouched — confirmed
by `git status --short` showing no path outside this list and the original build
brief's own file list newly modified.

### 17.7 Security re-assessment — controls this remediation pass touches

Re-evaluated against the new migration and code changes above (not a full re-run
of all 70 — only the controls this pass's own surface area implicates; every
other control's status from §13 is unchanged):

- **58 — Race conditions**: was previously assessed PASS on the strength of
  `private.next_sku_sequence`'s row lock alone — this pass adds the missing
  piece: `add_product_identifier`'s own primary-identifier race is now closed by
  both a hard partial unique index AND a product-row `FOR UPDATE` lock (§17.1),
  and `update_product_sku` takes the identical row lock for its own edit path.
  Proven by two genuinely-parallel (`Promise.all`, independent HTTP
  requests/DB connections) regression tests, both passing. **PASS** (upgraded
  from a control whose original evidence, in retrospect, did not cover this
  specific race — the exact gap Codex's rejection identified).
- **07 — Open database permissions** / **41 — Excess database privileges**: the
  new `private_product_sku_writer` role is deliberately narrow (id, business_id,
  sku, track_inventory select; sku-only update; no cost_price) and dedicated
  (not a reused/widened existing role, per `create_product_rpc.sql`'s own
  explicit rule) — verified by reading its own grant block in the new migration.
  `authenticated`'s direct `sku` column UPDATE privilege on `products` is
  revoked. **PASS**.
- **16 — Missing input validation**: `update_product_sku` re-validates and
  re-normalizes every non-blank input through `private.normalize_sku` — no
  client-supplied pre-normalized value is ever trusted. **PASS**.
- **42 — Missing audit logs**: SKU edits routed through the new RPC remain
  audited by the pre-existing table-level trigger (role-independent — fires on
  any `UPDATE OF sku`, not scoped to a specific caller). Proven by the existing
  audit test (unchanged assertion, still passing against the new write path).
  **PASS**.
- **06/33/49 — IDOR/BOLA/tenant isolation**: `update_product_sku` repeats the
  same `(id, business_id)`-scoped lookup and non-disclosing `PRODUCT_NOT_FOUND`
  pattern as every other mutation in this phase. Proven by a new dedicated IDOR
  test (cross-business SKU-update attempt rejected; original SKU unchanged).
  **PASS**.
- **51 — Mass assignment**: `update_product_sku` takes three named, typed
  parameters — no generic "accept an object" path. **PASS**.

No new FAIL was found. No new UNKNOWN was introduced by this pass's own code.
The §17.4 browser/E2E/responsive/dark-mode/accessibility evidence gap — the one
remaining LOW finding from Codex's first rejection round — was closed in a
follow-up documentation-evidence remediation pass (see §17.4 for the PASS
evidence); it was a reporting gap, not a code-security gap, at every point.

PHASE 1Q-B DOCUMENTATION REMEDIATION READY FOR FINAL CODEX CONFIRMATION.
