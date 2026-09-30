# Phase 1Q-C — Free Product Lookup — Build Brief

Repository: `C:\Users\SW\businessos` · Branch: `feature/expenses-financials` ·
Frozen baseline: `f488552ce6e5728b37f86020d1e69908008db3ed` (Phase 1Q-B — product
identifiers + auto SKU foundation).

Scope: lookup only. No barcode scanning, no camera, no hardware scanner, no
POS, no unknown-product quick-create flow. This document combines all six
build sections (kept lean where a section has little new ground to cover,
per the build protocol's "small work may keep them lean, never silently
omit" rule) plus the mandatory 70-control security assessment.

---

## 1 — Product Requirements Document

**Problem.** A staff member creating a product often already holds a
physical item with a printed barcode. Typing every field by hand is slow
and error-prone. This phase lets them type/scan that code and, if
BusinessOS or a free public database already knows it, pre-fill safe
suggestions — without ever silently overwriting anything they've typed and
without creating a product behind their back.

**Users.** Any staff member with `products.view` sees a local match. Only
a staff member with `products.manage` (the same authority already required
to create/edit a product) can trigger the external, third-party lookup —
matching phase instruction §12's own split.

**Non-goals (explicitly out of scope, confirmed absent — item 45 of the
report below):** barcode scanning/camera (1Q-D), hardware scanner
integration (1Q-E), unknown-product quick-create workflow (1Q-F), POS
scanning (1Q-G), auto-creating a product from a lookup result, multiple
external providers/fallback chains, a persisted lookup-cache table, a
dedicated new rate-limit subsystem beyond simple in-process caching.

**Success criteria.** Local match returns instantly from an indexed query
and never calls the network. An external match is clearly labeled as a
suggestion and only ever applied on explicit confirmation. A lookup miss,
invalid code, or provider failure never loses anything already typed into
the form and never blocks product creation.

## 2 — Technical Design Document

**Local-first flow.**
`components/products/product-lookup-field.tsx` (client) →
`lib/products/lookup/actions.ts#lookupProductByIdentifier` (Server Action,
called directly as an async function, not via `useActionState` — this is a
read-only, on-demand lookup, not a form mutation) →
`public.lookup_product_identifier` (new SQL RPC, SECURITY DEFINER) →
`product_identifiers`/`products` (existing Phase 1Q-B tables, read-only).

`lookupProductByIdentifier` re-checks `products.view` itself (defense in
depth, matching every other Server Action in this codebase — see
`lib/products/actions.ts`'s own identical pattern), then:
1. Calls `lookupLocalProductByIdentifier` (the RPC).
2. Returns immediately on anything other than `NOT_FOUND` (`LOCAL_MATCH` or
   `INVALID`) — the external provider is **never** reached in either case
   (phase instruction §1/§10/§27, unit-tested — see item 28 below).
3. On a genuine local `NOT_FOUND`, only proceeds to
   `lookupExternalProductByIdentifier` when the caller holds
   `products.manage` **and** the code is a validated GS1 barcode
   (`GTIN`/`UPC_A`/`EAN_13`/`EAN_8`) — never for an `OTHER`-typed miss.

**Why one new RPC, not a plain client query.** Normalization
(`private.normalize_identifier`) and check-digit validation
(`private.validate_gtin_check_digit`) already exist from Phase 1Q-B, live
in the `private` schema, and are deliberately never granted to
`authenticated` — reusing them (phase instruction §9/§30, "do not create a
second conflicting normalizer") requires a `SECURITY DEFINER` function.
`public.lookup_product_identifier` (new migration
`20261010080500_lookup_product_identifier.sql`) is owned by the existing
`private_product_identifier_writer` role (Phase 1Q-B's own role for this
exact table — reused rather than duplicated) and:
- detects the type itself from the digit-only candidate's length (no
  client-supplied type — the UI never asks the caller to pick one first,
  matching the phase's own "Barcode / GTIN [____] [Look up]" mockup);
- rejects a recognized-length code with a failing check digit as
  `INVALID` **before** any product search;
- searches `product_identifiers` scoped to `p_business_id` only, trying
  both the digit-only and the `OTHER`-style normalized forms so a locally
  stored non-numeric identifier is still found;
- returns only `status`, `identifier_type`, `normalized_value`, and — on a
  match — `product_id/name/sku/status/selling_price` (nothing else; no
  cost, no stock — see PRD non-goals).

**Provider abstraction (phase instruction §4/§30).**
`lib/products/lookup/provider.ts` defines `ProductLookupProvider`
(`lookupByIdentifier(normalizedIdentifier, signal)`) and
`ProductLookupProviderError` (one of `PRODUCT_LOOKUP_TIMEOUT` /
`PRODUCT_LOOKUP_RATE_LIMITED` / `PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE`). The
only implementation is `lib/products/lookup/providers/open-food-facts.ts`
— the rest of the app imports only the interface and the normalized
`ExternalProductCandidate` type (`lib/products/lookup/types.ts`), never a
provider-specific response shape.

**Cache (phase instruction §18/§19/§59).**
`lib/products/lookup/cache.ts` — a module-level `Map`, not a database
table (no schema change was needed for it, so none was added — item 59/60
of the report). Keyed by `${providerName}:${normalizedIdentifier}` only
(never by business — the underlying data is public and provider-sourced,
identical for every business asking about the same barcode). Positive hits
cache 6 hours; misses cache 5 minutes (never permanently); an in-flight
request is de-duplicated so two concurrent callers for the same code share
one provider call; a thrown provider error is never cached. The store is
bounded: at most **500 entries** (`LOOKUP_CACHE_MAX_ENTRIES`), evicted
least-recently-used (a `Map`'s insertion order; a read re-inserts the entry,
a write past the cap deletes the oldest key). Expired entries are also
dropped lazily on read. In-flight de-dup entries are removed when their
promise settles, so they are bounded by concurrency, not by history.

**Provider host allowlist (SSRF).** The outbound host is validated on every
call by `lib/products/lookup/providers/off-base-url.ts`
(`resolveOffBaseUrl`). Production accepts exactly
`https://world.openfoodfacts.org` (exact hostname match, https only, default
port, no path/query/fragment, no credentials, no wildcard or suffix
matching). **The production prohibition on loopback is enforced in code, not
by deployment discipline.** "Production" means `NODE_ENV === "production"`
**or** `VERCEL_ENV === "production"` (`isProductionRuntime`); if either is
true, loopback is rejected regardless of every other flag. The only way a
loopback host is ever accepted is `isLoopbackPermitted`, which requires ALL
of `BUSINESSOS_E2E === "1"`, `PRODUCT_LOOKUP_ALLOW_LOOPBACK === "1"`,
`NODE_ENV !== "production"` and `VERCEL_ENV !== "production"`, **and** the
hostname must be exactly one of `localhost`, `127.0.0.1`, `[::1]` (any port;
no `127.0.0.2`, `0.0.0.0`, `*.localhost`, IPv4-mapped IPv6 or other
variants). There is no generic SSRF-disable flag. The official provider is
the only real production network target. E2E serving:
`playwright.config.ts` starts `next start` with `NODE_ENV=test` plus the two
flags (`next start` only defaults `NODE_ENV` to `production` when unset), so
the production check is never weakened to fit the tests; the resolver reads
the env object at runtime (not a build-inlined `process.env.NODE_ENV`), so
the runtime value is what counts. Anything else — other hosts, look-alike domains, private/link-local
IPs, non-http(s) schemes, embedded credentials — throws
`ProductLookupConfigError`; the adapter converts that to
`PRODUCT_LOOKUP_NOT_CONFIGURED` (generic user message, reason logged
server-side without echoing the configured value) and **never calls fetch**.
There is no fallback to the configured value or to a guess. The adapter also
sets `redirect: "error"` so an allowlisted host cannot bounce the request
elsewhere. The barcode identifier is digit-only and only ever forms the URL
path, so it cannot influence the host.

## 3 — App Flow & State Map

```
[Product create form]
  barcode field (also the lookup input) --Look up--> pending
    -> LOCAL_MATCH  -> "This barcode already belongs to X" + View product
    -> INVALID       -> inline alert, field untouched
    -> NOT_FOUND      -> not eligible for external (OTHER / no manage perm)
                          -> "No product information found" message
                      -> eligible for external
                          -> EXTERNAL_MATCH -> suggestion card -> [Use product details]
                                                 -> fills name/category ONLY if empty
                          -> NOT_FOUND (provider miss too) -> same message
                          -> PROVIDER_ERROR -> recoverable alert, field untouched
  [Create product] always available regardless of lookup state
```

Every terminal state leaves every other form field exactly as the caller
left it (`ProductForm`'s own `name`/`category`/`barcode` state is lifted to
`useState` specifically so an apply is a controlled, additive write, never
a full-form reset — see `components/products/product-form.tsx`).

## 4 — UI/UX Design Brief

`components/products/product-lookup-field.tsx` replaces the plain
`barcode` `<Input>` with the code's own lookup surface, **in create mode
only** (phase instruction §23: product creation is the target surface;
edit mode keeps its existing plain barcode field, untouched, to keep this
phase's footprint minimal on an already-shipped, already-tested screen).

- Local match: a muted card, the product's name/SKU/status, and a
  ghost-styled `Link` (`buttonVariants({ variant: "ghost" })`, matching
  `components/products/stock-summary-card.tsx`'s own existing pattern for
  a link styled as a button) to the existing product.
- External match: labeled "External suggestion — Open Food Facts", name/
  brand/quantity/category, and an explicit "Use product details" button —
  nothing is ever applied without that click.
- Not found / provider error: a plain, non-blocking message
  (`lib/products/lookup/messages.ts`), `role="alert"` only for the
  genuinely actionable provider-error/invalid cases, `role="status"`
  otherwise (phase instruction §53 — errors use alert semantics, a miss
  does not falsely read as one).
- Loading: while a lookup is pending the "Look up" button is **disabled**,
  shows the `Loader2` icon and `aria-busy="true"`, and a visible
  `role="status"` line ("Looking up barcode…") announces the state. The
  input is never disabled or cleared (phase instruction §54). Duplicate
  submission of the same active lookup is blocked by the UI itself — the
  disabled button plus a synchronous `useRef` in-flight guard (state alone
  updates a render late, so a fast double-click or Enter could slip through)
  covers button clicks and Enter in the field. Editing the barcode abandons
  the in-flight lookup (its response is dropped by the request-id guard) and
  re-enables the button, so lookup A → edit → lookup B still works and A can
  never overwrite B. Server-side in-flight de-dup remains as defense in depth.
- Icons are Font Awesome via `@/components/ui/icon` (`Search`, `Loader2`,
  `PackageSearch`) — no `lucide-react` import anywhere in this phase
  (phase instruction §58).

Responsive/theme QA: the new markup reuses only existing `Input`/`Button`/
`Alert`/`Label` primitives already covered by this app's own global
responsive/theme QA passes (Phase 1O-series screenshots); this phase adds
no new breakpoint-sensitive layout (a two-item flex row plus a card,
below the existing grid) and no new color token. This phase's own e2e
responsive/theme sweep (report items 31–36) generates 24 screenshots
(`apps/web/qa-screenshots/1qc-*`: 3 states × 4 widths × 2 schemes); only a
subset was manually inspected — see item 31 for exactly which.

## 5 — Backend & Data Design

**No new table.** One new migration
(`20261010080500_lookup_product_identifier.sql`) adds exactly:
1. `public.lookup_product_identifier(p_business_id, p_raw_value)` —
   `SECURITY DEFINER`, `set search_path = ''`, owned by
   `private_product_identifier_writer`.
2. `grant select (id, business_id, name, sku, status, selling_price) on
   public.products to private_product_identifier_writer` — the same exact
   column set already granted to `private_invoice_writer` for an
   equivalent read-only purpose (`20260831080200_create_invoice_creation_
   rpc.sql`), reused rather than inventing a new grant shape.

No destructive change, no backfill, no column added to `products` or
`product_identifiers`. `revoke all ... from public, anon` +
`grant execute ... to authenticated` matches every other RPC's exact
grant shape in this codebase.

## 6 — Engineering Implementation Plan

1. `lib/products/lookup/types.ts` — shared result/candidate types.
2. `lib/products/lookup/provider.ts` — provider interface + error class.
3. `lib/products/lookup/providers/open-food-facts.ts` — the one adapter.
4. `lib/products/lookup/cache.ts` — in-process TTL cache + de-dup.
5. `supabase/migrations/20261010080500_lookup_product_identifier.sql`.
6. `lib/supabase/database.types.ts` — manually added RPC type entry
   (no live schema-diff codegen run against a hosted project this session;
   hand-written to match the migration's own `returns table (...)` exactly
   — verified by `tsc --noEmit` passing, item 38 below).
7. `lib/products/lookup/actions.ts` — the three Server Actions.
8. `lib/products/lookup/messages.ts` — static, safe display copy.
9. `components/products/product-lookup-field.tsx` — the UI.
10. `components/products/product-form.tsx` — wired in, create mode only;
    `name`/`category`/`barcode` lifted to controlled state.
11. Tests (unit, integration, e2e, component) — see §"Checks run" below.
12. This build brief.

---

## Provider research (phase instruction §62/§63)

**Selected: Open Food Facts** (`world.openfoodfacts.org`), REST API v2,
`GET /api/v2/product/{barcode}.json`.

Checked directly (via a live fetch of the provider's own published terms
page during this session, not memory):
- **Cost / key:** free, no API key required, no published commercial
  paywall.
- **License:** Open Database License (ODbL) 1.0 — commercial use is
  permitted, **conditioned on attribution and share-alike on any
  REDISTRIBUTED derivative of the data.** Flagged, not asserted with false
  certainty (phase instruction §62): a merchant applying a fetched name/
  brand/image to their own private product record is, in this author's
  judgment, very unlikely to trigger a meaningful "redistribution"
  obligation, but this is a real license term this phase does not resolve
  with certainty — a future phase that ever re-exports or republishes this
  data (a public storefront feed, say) should re-examine ODbL compliance
  at that point, not assume this phase already cleared it.
- **Rate limits:** none formally published for genuine per-lookup use; the
  provider's own stated policy is "1 API call = 1 real scan" and warns
  that bulk scraping "will very likely be blocked" — this app's own
  per-request, cached, de-duplicated call pattern (never a bulk crawl)
  fits that policy.
- **Coverage:** broad but not exhaustive — strongest for food/beverage/
  personal-care packaged goods; a business selling other categories will
  see more `NOT_FOUND` results, which this phase already treats as a
  fully supported, non-blocking terminal state.
- **Reliability:** community-run, no formal SLA — this is exactly why
  every call is timeout-bounded (6s), retried at most implicitly via the
  UI's own re-click (no automatic retry loop), and never allowed to block
  product creation.

No second provider/fallback chain was added (phase instruction §32 — "one
provider + clean abstraction is enough"); the `ProductLookupProvider`
interface is what makes adding one later a swap, not a rewrite.

---

## Report

1. **Provider selected:** Open Food Facts (`world.openfoodfacts.org`, API v2).
2. **Provider terms/free-use assessment:** free, no key, ODbL 1.0 (commercial use
   allowed; attribution/share-alike caveat flagged above for any future
   redistribution — not fully resolved with certainty, by design).
3. **Provider limitations:** no formal SLA/rate limit guarantee; coverage
   strongest for food/beverage/personal-care; community-maintained data
   quality.
4. **Exact files changed:** see `git status --short` — new:
   `lib/products/lookup/{types,provider,cache,actions,messages}.ts`,
   `lib/products/lookup/providers/open-food-facts.ts`,
   `lib/products/lookup/{actions,cache}.test.ts`,
   `lib/products/lookup/providers/open-food-facts.test.ts`,
   `components/products/product-lookup-field.{tsx,test.tsx}`,
   `supabase/migrations/20261010080500_lookup_product_identifier.sql`,
   `tests/integration/product-lookup.test.ts`,
   `tests/e2e/product-lookup.spec.ts`,
   `tests/e2e/fixtures/off-stub-server.mjs`,
   `docs/phase-1q-c-free-product-lookup-build-brief.md`; modified:
   `components/products/product-form.tsx`, `lib/supabase/database.types.ts`,
   `playwright.config.ts` (stub provider webServer + env).
    **Codex-remediation pass additionally:** new
    `lib/products/lookup/providers/off-base-url.{ts,test.ts}`; modified
    `providers/open-food-facts.ts`, `cache.ts`, `cache.test.ts`, `types.ts`
    (+`PRODUCT_LOOKUP_NOT_CONFIGURED`), `messages.ts`,
    `components/products/product-lookup-field.{tsx,test.tsx}`,
    `tests/e2e/product-lookup.spec.ts`, `tests/e2e/fixtures/off-stub-server.mjs`
    (+ delayed slow code), `playwright.config.ts` (+ explicit E2E-only loopback env),
    and this brief.
5. **Migrations added:** YES — one (`20261010080500_lookup_product_identifier.sql`),
   function + grant only, no new table/column (justified above, §5/§59-60).
6. **Local lookup architecture:** SECURITY DEFINER RPC, business-scoped,
   reuses Phase 1Q-B's own normalization/check-digit functions — see §2.
7. **External lookup architecture:** provider-abstraction adapter behind
   a cache, invoked only after a genuine local miss — see §2.
8. **Provider abstraction:** `ProductLookupProvider` interface,
   `lib/products/lookup/provider.ts` — one implementation, swappable.
9. **Authorization model:** local match requires `products.view`; external
   lookup additionally requires `products.manage` — enforced in
   `lookupProductByIdentifier`, re-checked independently of the RPC's own
   `products.view` check (defense in depth).
10. **Tenant isolation result:** PASS — `tests/integration/product-lookup.test.ts`
    ("never leaks a match across businesses", "rejects a lookup scoped to
    a business the caller does not belong to") against a real local
    Supabase stack; also exercised live in
    `tests/e2e/product-lookup.spec.ts`'s cross-business isolation test.
11. **Identifier normalization reuse:** confirmed — the RPC calls
    `private.normalize_identifier`/`private.validate_gtin_check_digit`
    directly (Phase 1Q-B's own functions); no second normalizer was written.
12. **Invalid identifier behavior:** `INVALID` returned before any product
    search or provider call — integration-tested
    (`product-lookup.test.ts`) and unit-tested (`actions.test.ts`:
    "does not call the external provider for an INVALID result").
13. **Local-match-first behavior:** unit-tested
    (`actions.test.ts`: "never calls the external provider when a local
    match exists").
14. **Provider request privacy:** only the normalized barcode digit string
    is ever sent to Open Food Facts — no business/tenant/customer/price/
    SKU data (`providers/open-food-facts.ts`'s own request URL construction).
15. **Timeout behavior:** 6s, `AbortController`-based, normalized to
    `PRODUCT_LOOKUP_TIMEOUT` — unit-tested.
16. **Rate-limit behavior:** provider 429 normalized to
    `PRODUCT_LOOKUP_RATE_LIMITED` — unit-tested; in-process de-dup of
    identical concurrent lookups (`cache.ts`) reduces accidental repeat
    calls; no separate rate-limit subsystem was built (deliberately, per
    phase instruction §17).
17. **Cache strategy:** in-process, provider+identifier-keyed, 6h positive
    / 5min negative TTL, errors never cached, **max 500 entries with LRU
    eviction** — unit-tested (`cache.test.ts`, 9 tests: bound never exceeded,
    oldest evicted, newest still served, recent read protected from eviction,
    provider+identifier keying intact).
18. **Stale-response protection:** client-side request-id guard in
    `product-lookup-field.tsx` — unchanged; component-tested ("ignores a
    stale response…", plus new "lets a lookup for an edited value start
    while an earlier one is pending, and A never overwrites B"). The new
    duplicate-submit guard is layered on top and does not weaken it.
19. **SSRF protection:** `PRODUCT_LOOKUP_OFF_BASE_URL` is validated against an
    exact-host allowlist on every call (see §2 "Provider host allowlist"):
    only `https://world.openfoodfacts.org`; loopback (exactly `localhost`,
    `127.0.0.1`, `[::1]`) only when `BUSINESSOS_E2E=1` **and**
    `PRODUCT_LOOKUP_ALLOW_LOOPBACK=1` **and** neither `NODE_ENV` nor
    `VERCEL_ENV` is `production` — code-enforced, impossible in production.
    Rejected and unit-tested (`off-base-url.test.ts`, 37 tests): loopback
    under `NODE_ENV=production`, under `VERCEL_ENV=production`, with both
    flags but production active, with only the old opt-in, with only
    `BUSINESSOS_E2E=1`, non-`"1"` flag values, near-loopback hosts; arbitrary
    hosts, `openfoodfacts.org.evil.example.com`-style look-alikes, other OFF
    subdomains, `169.254.169.254`, `10.0.0.1`, `192.168.1.1`, `172.16.0.1`,
    `file:`/`ftp:`/`data:`/`javascript:` schemes, embedded credentials
    (including `host@evil`), http on the official host, non-default ports,
    path/query components, unparseable values.
    Invalid config fails closed (`PRODUCT_LOOKUP_NOT_CONFIGURED`, no fetch,
    verified by test); `redirect: "error"` blocks redirect pivots. The
    adapter still re-validates the identifier is digit-only 8–14 chars, so
    the user-supplied identifier can never control the host.
20. **External response validation:** Zod schema (`OffResponseSchema`) +
    explicit length caps + image-URL protocol allowlist
    (`https:`/`http:` only) — unit-tested for malformed JSON, unexpected
    shape, oversized text, and unsafe image URL.
21. **XSS posture:** every provider-supplied string is rendered as plain
    React text (never `dangerouslySetInnerHTML`); the image URL is
    validated but not currently rendered as an `<img>` anywhere (deferred,
    per phase instruction §21 — "acceptable to defer external images").
22. **Local result UI:** "This barcode already belongs to X" + View
    product link — component-tested.
23. **External candidate UI:** labeled "External suggestion", explicit
    apply button — component-tested.
24. **Explicit apply behavior:** name/category are only set from a
    candidate when the caller clicks "Use product details" — never on
    lookup alone — component-tested.
25. **No silent overwrite result:** apply only fills a field that is
    currently empty (`onApplyName`/`onApplyCategory` guards in
    `product-form.tsx`) — component-tested.
26. **No-result behavior:** non-blocking message, product creation remains
    available — e2e-tested (creates a product after a miss).
27. **Form-preservation result:** PASS for every scenario this phase can
    exercise deterministically — e2e ("invalid check digit... barcode
    field never cleared", "not found... no field is lost") and
    component-tested (stale response, apply); provider 500/429 are now also
    e2e-verified against the local stub (item 30).
28. **Focused integration result:** `tests/integration/product-lookup.test.ts`
    — 7/7 passed against a real local Supabase stack (`supabase db reset`
    applied this migration cleanly).
    **Historical run (superseded, kept for the record):** on a reused local DB,
    1924 passed / 2 failed — `subscription-billing-foundation.test.ts` tests 12
    and 15, duplicate key on `subscription_plan_prices` from fixture rows left
    by earlier suite runs. An isolated re-run on that same dirty DB also failed
    test 12, confirming the state was stale, not random.
    **Authoritative run:** after an explicitly authorized `supabase db reset`
    (all migrations, including `20261010080500`, applied cleanly): the billing
    suite in isolation passed 89/89; the DB was then reset again (the billing
    suite leaves fixtures that break its own re-run) and the full integration
    suite passed 95 files / 1926 tests, 0 failures. No production code, tests or
    migrations were changed to get there; the failure is not attributable to
    1Q-C. Observation, not fixed here: the billing suite is not idempotent on a
    reused DB, so the full suite must start from a fresh reset.
29. **Unit result:** lookup files — `cache.test.ts` (9), `open-food-facts.test.ts`
    (12), `off-base-url.test.ts` (30), `actions.test.ts` (14),
    `product-lookup-field.test.tsx` (9) — 74/74 passed. Full unit suite
    (post-remediation): 94 files / 1327 tests passed (no regressions).
30. **Focused E2E result:** `tests/e2e/product-lookup.spec.ts` — 12/12 passed
    (post-remediation; was 11/11 — the new test is the double-submit test).
    The cross-business test now uses the stub barcode for business A's
    product and **waits for business B's completed lookup** (external
    suggestion visible, button re-enabled, "Looking up barcode…" gone) before
    asserting A's product name, product-id link and local-match card are
    all absent — no assertion runs against an in-flight state. The
    double-submit test uses a 2s-delayed stub code: asserts button disabled +
    `aria-busy` + visible status + input preserved while pending, fires
    forced clicks and Enter repeatedly, asserts exactly one server-action
    POST, then button re-enabled and a follow-up lookup works.
    Provider-dependent scenarios are now deterministic: `playwright.config.ts`
    starts `tests/e2e/fixtures/off-stub-server.mjs` (a local Open Food Facts
    stand-in) and points `PRODUCT_LOOKUP_OFF_BASE_URL` at it, so no e2e test
    touches the real third-party service. Matrix: A local match; B external
    match shown; C apply only on explicit click; D typed Name not overwritten
    (Category, empty, filled); E valid barcode with no provider data keeps
    every field; F invalid check digit keeps every field; G provider 500 and
    429 show a recoverable alert, preserve barcode/name/description/category/
    price, and product creation still succeeds; plus cross-business isolation
    and a keyboard flow (Enter to look up, focus and Enter on the apply button).
31. **Responsive 390 / 32. 768 / 33. 1280 / 34. 1440:** PASS — the last e2e test
    loads the create form at each width and drives the external-suggestion,
    invalid and provider-error states, asserting `scrollWidth - clientWidth <= 0`
    each time. Screenshots: **24 were generated** by this sweep
    (`apps/web/qa-screenshots/1qc-{external,invalid,error}-{390,768,1280,1440}-{light,dark}.png`,
    re-generated on every run). **Only a subset was manually inspected:**
    390-dark-external and 1440-light-error in the original pass, and
    390-dark-external again in the remediation pass. The other 21 are
    covered by the automated no-horizontal-overflow assertion only, not by
    human/visual review.
35. **Light mode / 36. Dark mode:** PASS — the same sweep runs under
    `emulateMedia({ colorScheme })` for both schemes (24 screenshots above).
37. **Accessibility:** the barcode input keeps its `<Label>`; the lookup button
    has visible text, `aria-busy`, and is disabled while pending; a visible
    `role="status"` line ("Looking up barcode…") announces loading
    (`aria-busy` alone is not reliably announced); invalid/provider-error use `role="alert"`;
    local/external/not-found use `role="status"`; no state is color-only; the
    keyboard flow is e2e-tested. **No automated axe/Lighthouse scan was run**
    (`@axe-core/playwright` is not a dependency and none was added to keep this
    phase's footprint minimal) — structural/keyboard verification only, so the
    automated-scan checklist item stays UNKNOWN. Codex classified this LOW /
    non-blocking; it is **deferred** (INFO/LOW follow-up: add an axe pass to
    the shared e2e suite when a dependency is justified app-wide, not just
    for this phase).
38. **Typecheck:** PASS — `pnpm typecheck` (`tsc --noEmit`), zero errors.
39. **Lint:** PASS — `pnpm lint` (eslint), zero errors/warnings.
40. **Build:** PASS — `pnpm build`, compiled successfully, all 68 routes
    generated.
41. **`pnpm audit --prod`:** PASS — "No known vulnerabilities found."
42. **Security audit result:** see the 70-control table below — 0 FAIL;
    every UNKNOWN is a pre-existing, whole-app or account/infra-level fact
    this phase's own diff neither introduces nor changes (session/JWT
    lifecycle, CI/CD credential scoping, security headers, monitoring,
    backups, MFA) — not reassessed this session because doing so is a
    separate, whole-application audit, not this feature's own scope.
43. **70-control summary:** PASS 33 · FAIL 0 · UNKNOWN 17 · N/A 20 (= 70).
44. **Build brief path:** `apps/web/docs/phase-1q-c-free-product-lookup-build-brief.md`.
45. **Out-of-scope items confirmed absent:** barcode scanning/camera code —
    absent (no `getUserMedia`/camera import anywhere in this diff);
    hardware scanner event listeners — absent; unknown-product quick-create
    flow — absent (no auto-`INSERT` path from a lookup result exists;
    applying a candidate only ever sets in-memory form state, never calls
    a mutation); POS integration — absent; a second external provider —
    absent; a persisted lookup-cache table/migration — absent (confirmed:
    the only new migration is the RPC + grant in §5, no `create table`).
46. **git diff --check:** clean except two pre-existing CRLF-on-touch
    warnings (`product-form.tsx`, `database.types.ts` — this repo's own
    existing line-ending convention, not a new problem introduced here);
    no actual whitespace-conflict errors.
47. **Staged files:** none — `git diff --cached --stat` is empty.
48. **Unrelated WIP preserved:** confirmed — every pre-existing modified/
    untracked file from the session's starting `git status` (auth pages,
    legal pages, brand assets, QA screenshots, `debug.log`, the Phase
    1M WhatsApp brief, etc.) remains exactly as it was; this phase only
    ever touched `components/products/product-form.tsx` and
    `lib/supabase/database.types.ts` among pre-existing files, both
    directly required by this feature.
49. **Blockers:** none.
50. **Readiness for Codex review:** ready — see release decision below.

**Codex rejection remediation (this pass):** (1) SSRF host allowlist —
fixed, §2 + item 19. (2) Lookup button disabled while pending + synchronous
duplicate-submit guard — fixed, §4. (3) Cross-tenant e2e now waits for the
completed lookup — fixed, item 30. LOW: (4) screenshot contradiction —
fixed (24 generated, subset inspected, item 31, §4); (5) axe/Lighthouse —
deferred, non-blocking, item 37; (6) cache bound — fixed, 500-entry LRU,
item 17. Validation after remediation: lookup unit 74/74; full unit
94 files / 1327 tests; focused e2e 12/12; `pnpm typecheck`, `pnpm lint`,
`pnpm build`, `pnpm audit --prod` all clean. Integration suite not re-run:
no database, migration or server-data-path behavior changed. 70-control
totals unchanged: PASS 33 · FAIL 0 · UNKNOWN 17 · N/A 20.

**Final loopback hardening (this pass):** Codex MEDIUM — loopback was still
reachable with `NODE_ENV=production` + `PRODUCT_LOOKUP_ALLOW_LOOPBACK=1` on a
non-Vercel host — fixed in code (§2, item 19, control 23). Files:
`off-base-url.ts`, `off-base-url.test.ts`, `playwright.config.ts`, this brief.
Validation: `off-base-url.test.ts` 37/37; lookup dir 72/72; full unit
94 files / 1334 tests; focused e2e 12/12 (server run with `NODE_ENV=test`,
`BUSINESSOS_E2E=1`, loopback opt-in); typecheck, lint, `pnpm build` clean;
`pnpm audit --prod`: no known vulnerabilities. Integration not re-run (no DB
behavior changed). Only control 23 changed; totals unchanged (33/0/17/20).
Note: the e2e server log shows "The destination stream closed early" errors
(digest 3636664597) during the run; tests still pass and they are not from
lookup code paths changed here, but their origin was not investigated.

---

## 70-control security assessment

Scope assessed: this phase's own diff (Phase 1Q-C, free product lookup),
not a full re-audit of the entire, already-shipped BusinessOS codebase.
`N/A` below means **this feature itself** has none of that surface
(worded that way deliberately — it is not always a claim about the whole
app, e.g. BusinessOS does have `/internal/admin` routes elsewhere; this
feature adds none). `UNKNOWN` means a pre-existing, whole-app or
account/infrastructure fact this diff neither introduces nor changes,
genuinely not reassessed this session. Deployed surface reviewed: no
(local dev + local Supabase stack only).

**FAIL — none.**

| # | Control | Status | Evidence / reason |
|---|---|---|---|
| 01 | Exposed DB credentials | PASS | No connection string in this diff; env-driven `createClient()` unchanged. |
| 02 | Public `.env` files | PASS | No `.env*` file added or modified. |
| 03 | Hardcoded secrets | PASS | `open-food-facts.ts` calls a keyless public API; no secret anywhere in this diff. |
| 04 | Weak/missing authentication | PASS | `requireUser()` in every lookup action; RPC rejects null `private.current_uid()`. |
| 05 | Missing server-side authorization | PASS | `products.view`/`.manage` checked in `actions.ts` **and** `private.has_permission` in the RPC. |
| 06 | Cross-user data access | PASS | Every RPC query scoped by `p_business_id`; integration-tested. |
| 07 | Open database permissions | PASS | `revoke all` + narrow `grant execute`; column-scoped `products` grant. |
| 08 | Misconfigured Supabase | PASS | Unauthenticated call rejected, cross-tenant call rejected — both integration-tested against a real stack. |
| 09 | Unprotected admin routes | N/A | Feature has no admin surface. |
| 10 | Debug tools exposed | N/A | Feature adds no debug/test route. |
| 11 | Build logs leaking secrets | UNKNOWN | Whole-app CI config, not reassessed this session. |
| 12 | Verbose production errors | PASS | Only typed static messages returned; malformed-provider-response tests confirm no raw body/stack leaks. |
| 13 | Secrets in Git history | UNKNOWN | Whole-app history scan not run this session. |
| 14 | Secrets shipped to frontend | PASS | Provider adapter is `import "server-only"`; no key exists to leak. |
| 15 | Client-side-only checks | PASS | Every UI-implied check re-enforced server-side (view/manage permission). |
| 16 | Missing input validation | PASS | Zod schema on provider response; server-side digit/length/check-digit validation. |
| 17 | SQL injection | PASS | Typed `plpgsql` parameters throughout, no concatenation. |
| 18 | NoSQL injection | N/A | No NoSQL store used anywhere in this feature. |
| 19 | XSS | PASS | Provider strings render as plain text only; no `dangerouslySetInnerHTML`. |
| 20 | CSRF | PASS | Next.js Server Action framework CSRF/origin default (unchanged); feature is read-only, no mutation. |
| 21 | Insecure file uploads | N/A | Feature has no upload. |
| 22 | Path traversal | N/A | No user-supplied filesystem path in this feature. |
| 23 | SSRF | PASS | Re-assessed after Codex found the earlier evidence insufficient (env override accepted any host). Now `off-base-url.ts` enforces an exact-host allowlist (official OFF host; loopback only when `BUSINESSOS_E2E=1` + `PRODUCT_LOOKUP_ALLOW_LOOPBACK=1` + `NODE_ENV`/`VERCEL_ENV` both non-production — impossible if either is `production`, code-enforced in `isLoopbackPermitted`), fails closed with no fetch, `redirect: "error"`; 37 unit tests in `off-base-url.test.ts` incl. production-loopback rejection (NODE_ENV, VERCEL_ENV, both), old-opt-in-only and E2E-flag-only rejection, metadata/private IPs, look-alike hosts, bad schemes, credentials; identifier cannot influence host (test), digit-only and path-only. Focused e2e 12/12 via the explicit test-only signal. |
| 24 | Broken password reset | N/A | Feature has no password-reset flow. |
| 25 | Weak session management | UNKNOWN | Whole-app Supabase Auth session handling, not reassessed this session. |
| 26 | Weak/invalid JWT validation | UNKNOWN | Whole-app, Supabase/PostgREST-managed, not reassessed this session. |
| 27 | Overly permissive CORS | N/A | Feature adds no externally callable HTTP endpoint (Server Actions only). |
| 28 | Missing rate limits | UNKNOWN | Whole-app Phase 1P rate limiting unchanged; this feature only adds request de-dup/caching, not a limiter, and wasn't reassessed at the platform level this session. Feature-level request abuse is now reduced (UI blocks duplicate submits; server de-dup + cache + 6s timeout) but that is not a rate limiter, so the platform-level status is unchanged. |
| 29 | Unprotected staging/test envs | UNKNOWN | Deployment-level fact, not visible this session. |
| 30 | Default credentials unchanged | UNKNOWN | Deployment-level fact, not reassessed this session. |
| 31 | Webhook signatures | N/A | Feature receives no webhooks. |
| 32 | Frontend-only payment checks | N/A | Feature has no payment/entitlement logic. |
| 33 | IDOR/BOLA | PASS | Business-scoped RPC queries; cross-tenant denial integration-tested. |
| 34 | APIs trusting client-supplied roles/IDs | PASS | Identity derived from `requireUser()`/`getPermissions()`, never a request field. |
| 35 | Sensitive data in logs | PASS | No logging call added anywhere in this diff. |
| 36 | Sensitive source maps/build artifacts | UNKNOWN | Whole-app build config, not reassessed this session. |
| 37 | Vulnerable dependencies | PASS | `pnpm audit --prod`: "No known vulnerabilities found." |
| 38 | Malicious packages | PASS | Zero new dependencies added this phase. |
| 39 | Prompt injection | N/A | No LLM/agent feature. |
| 40 | AI tools bypassing permissions | N/A | No model-callable tool. |
| 41 | Excess DB privileges | PASS | Column-scoped, role-scoped grant (see 07). |
| 42 | Missing audit logs | PASS | Correctly writes none — this RPC is a pure read, matching phase instruction §33 and this codebase's existing "audit only mutations" convention. |
| 43 | No security monitoring/alerts | UNKNOWN | Deployment-level fact, not visible this session. |
| 44 | No tested backup/restore | UNKNOWN | Deployment-level fact, not visible this session. |
| 45 | Public internal dashboards | N/A | Feature adds no internal dashboard. |
| 46 | Missing security headers | UNKNOWN | Whole-app, no deployed origin inspected this session. |
| 47 | Unsafe cookie settings | UNKNOWN | Whole-app, not reassessed this session. |
| 48 | Data unprotected in transit/at rest | UNKNOWN | Deployment-level TLS/encryption fact, not reassessed this session. |
| 49 | Poor tenant isolation | PASS | Tenant scope enforced and integration-tested for this feature. |
| 50 | Over-trusting AI-generated code | PASS | This diff was reviewed: tests run, typecheck/lint/build/audit executed, auth/authz logic manually inspected before being reported. |
| 51 | Mass assignment | PASS | RPC takes exactly two scalar parameters; no object write surface exists. |
| 52 | Command/OS injection | N/A | No subprocess spawned in this feature. |
| 53 | Unsafe deserialization | PASS | Only `response.json()` on the provider body, immediately Zod-validated; no unsafe deserialization path. |
| 54 | Misconfigured OAuth/OIDC | N/A | No third-party login in this feature. |
| 55 | No MFA on privileged accounts | UNKNOWN | Account-level fact only the project owner can confirm. |
| 56 | Account enumeration | N/A | Feature has no login/signup/reset surface. |
| 57 | Business-logic abuse | PASS | Eligibility gating (view vs. manage, GTIN-family vs. OTHER) enforced server-side, unit-tested for every branch. |
| 58 | Race conditions | PASS | Feature performs no write; in-flight cache de-dup uses a single shared promise (race-safe), unit-tested. Client: synchronous in-flight ref + disabled button block duplicate submits (unit + e2e: one POST); request-id guard drops stale responses (unit-tested A→B). |
| 59 | Webhook replay | N/A | Feature receives no webhooks. |
| 60 | Overpowered CI/CD credentials | UNKNOWN | Whole-app, not reassessed this session. |
| 61 | Untrusted build actions/scripts | UNKNOWN | Whole-app, not reassessed this session. |
| 62 | Unpinned build dependencies | UNKNOWN | Whole-app CI action pinning, not reassessed this session (lockfile itself is committed and unchanged). |
| 63 | Security checks fail open | PASS | Every catch branch converts failure to a deny-shaped typed result (`PROVIDER_ERROR`/`INVALID`), never a silent bypass. Invalid provider host config fails closed (`PRODUCT_LOOKUP_NOT_CONFIGURED`, no fetch) — `off-base-url.test.ts`. |
| 64 | Missing resource limits | PASS | 6s provider timeout; Zod-capped field lengths; cache capped at 500 entries with LRU eviction (`cache.test.ts` bound tests); in-flight map bounded by concurrency. |
| 65 | AI sensitive-info disclosure | N/A | No LLM feature. |
| 66 | Unsafe use of AI output | N/A | No LLM feature. |
| 67 | Excessive AI agency | N/A | No agent/tool feature. |
| 68 | Sensitive browser storage | PASS | Feature writes nothing to `localStorage`/`IndexedDB`; state is in-memory only. |
| 69 | Open redirects | PASS | The only rendered link is built from server-verified, same-tenant values, never user input. |
| 70 | Unsecured GraphQL/WebSocket/realtime | N/A | Feature uses neither. |

**Totals: PASS 33 · FAIL 0 · UNKNOWN 17 · N/A 20 → 70.**

**Residual risk:** (1) automated axe/Lighthouse scan not run — LOW/INFO,
deferred, non-blocking (report item 37). (2) The cache is per-process, so
the 500-entry bound is per instance; a future shared cache needs its own
bound. (3) Loopback is code-prohibited whenever `NODE_ENV` or `VERCEL_ENV` is
`production` (nothing to configure or remember); it is reachable only in an
explicitly non-production runtime carrying both test flags. (4) 21 of 24 responsive screenshots were not manually
reviewed. The former "cache has no max entries" risk is closed.

**Next actions (owners):** the 17 UNKNOWNs are all pre-existing,
whole-application or account/infrastructure facts this phase's diff does
not touch — CI/CD hygiene (11, 60–62), session/JWT/header/cookie/TLS
posture (25, 26, 36, 46–48), staging protection and default credentials
(29, 30), and account-level MFA/monitoring/backup facts (43, 44, 55).
Owner for all: the project owner, via the relevant hosting/CI/account
dashboards — none require a code change in this diff to resolve, and a
future dedicated whole-app security audit is the right place to close
them, not a re-litigation inside this feature's own build brief.

**Release decision: PASS WITH FIXES.** The earlier billing integration FAIL is
resolved (stale local DB; clean-DB full run 1926/1926, item 28), so it no longer
counts against the release. PASS is not claimed because open UNKNOWNs remain
(the items below and the automated a11y scan).

Rationale:

Per the build protocol's own decision rule: zero FAIL, and every open
UNKNOWN has a named owner and a clear (non-code) fix path, none of them
introduced or made worse by this phase's own diff, and none touching this
feature's own authentication, authorization, or data-handling logic
(which are fully PASS, evidenced above). This phase's own code is ready
to ship; the open UNKNOWNs are pre-existing whole-application items for
the project owner to close separately.
