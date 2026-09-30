# Phase 1Q-E — Hardware Barcode Scanner Support — Build Brief

Baseline: `43dcc9b3a4d4b402badd4db3d456642617934927` on `feature/expenses-financials`. Nothing staged,
committed or pushed. Builds on 1Q-B (identifier model, check digit), 1Q-C (local-first lookup, provider
protections, `ProductLookupField`) and 1Q-D (camera scanner). **No migration, no server change, no new
dependency, no new server action.**

Six build documents live in this one file, lean by design (small, client-only phase):
§1 PRD · §2 Technical Design · §3 App Flow & State Map · §4 UI/UX Brief ·
§5 Backend & Data Design (one paragraph — nothing changes) · §6 Engineering Plan.

---

## 1 — Product Requirements Document

**Problem.** Shops own cheap USB / Bluetooth barcode scanners. Today a user still has to click into the
barcode field and press *Look up* after every scan.
**Goal.** Scan a product with a physical scanner and have the existing 1Q-C lookup run automatically —
without the scanner ever corrupting other fields or capturing unrelated typing.

| Must have | Acceptance (observable) |
| --- | --- |
| Keyboard-wedge scanner recognised on the product-creation lookup surface | Fast valid EAN-8 / UPC-A / EAN-13 + Enter ⇒ barcode field filled, lookup runs (unit, E2E A) |
| Reuse 1Q-C, no second lookup path | Same `lookupProductByIdentifier` call (unit: called once with `("biz-1", code)`) |
| Human typing never mistaken for a scan | 100–300 ms typing, pasted values, manual Enter ⇒ no scan (unit, E2E B) |
| Product Name (any field) never corrupted | "Coca-Cola 50cl" unchanged after a scan with Name focused (unit, E2E A/C) |
| Invalid scan ⇒ no provider call, clear notice, form kept | Unit + E2E F |
| Duplicate / replacement scans safe | One request for repeated scan; B beats pending A (unit, E2E D/E) |
| No keylogging | Scoped, digits-only, ≤14-char in-memory buffer, sensitive fields blocked (unit, E2E) |
| Camera scanner unaffected | 1Q-D unit + E2E regression green; detector detached while camera dialog open (E2E J) |

**Success.** A user plugs in a scanner, focuses anywhere in the *New product* form, scans, and sees the
same result card a typed lookup would show.

**Out of scope (confirmed absent):** WebUSB / Web Serial / vendor SDKs, scanner configuration UI or wizard,
prefix/suffix configuration, alphanumeric (Code 128 / OTHER) scanner payloads, POS scan-to-sell,
unknown-product quick-create (1Q-F), label printing, app-wide scanning, telemetry, new icons.

---

## 2 — Technical Design Document

### Architecture (keyboard-wedge only)

```
USB HID scanner ─┐
                 ├→ keyboard events → HardwareScanDetector → identifier ─┐
Bluetooth HID  ──┘      (use-hardware-barcode-scanner.ts)                │
                                                                        ├→ ProductLookupField
Camera (1Q-D) ───────────────→ BarcodeDetector → identifier ────────────┘   applyScannedIdentifier()
                                                                            → runLookup() → 1Q-C server action
```

| Layer | File | Responsibility |
| --- | --- | --- |
| Detector (pure) | `lib/products/scanner/hardware-detector.ts` | key events (with timestamps) → `scan` / `rejected` / `buffering` / `ignored`. No DOM, no clock, no timers (it only *declares* `IDLE_CLEAR_MS`). |
| DOM hook | `lib/products/scanner/use-hardware-barcode-scanner.ts` | scope + target classification, field snapshot/restore, terminator consumption, **idle-timeout and blur clearing of the partial buffer**. |
| Integration | `components/products/product-lookup-field.tsx` | `applyScannedIdentifier` shared by camera + hardware; duplicate/replacement policy; notices. |

### USB HID / Bluetooth HID model
Both present to the browser as ordinary keyboards: characters, then a suffix key. One detector serves both;
no separate Bluetooth implementation exists or is needed. **No scanner model is certified.** Supported
profile: *keyboard-wedge HID scanner, sends EAN-8 / UPC-A / EAN-13 digits, terminates with Enter (Tab also
accepted)*. No WebUSB (`navigator.usb`), Web Serial, drivers, native helper or vendor SDK (grep-verified:
none of those identifiers appear in the change).

### Timing algorithm & constants (`HARDWARE_SCAN_TUNING`, all in one object for easy tuning)

| Constant | Value | Rationale |
| --- | --- | --- |
| `MAX_INTER_KEY_MS` | 50 | USB scanners emit a key every ~1–10 ms; Bluetooth ~10–30 ms with jitter. Sustained human numeric-keypad typing is ≳ 70–80 ms/key. 50 ms separates the populations with headroom for browser scheduling on low-end devices. A gap above 50 ms restarts the burst. |
| `MAX_AVG_INTER_KEY_MS` | 35 | Mean over the burst. Rejects a sequence that scrapes just under the per-key limit on every key — a pattern neither scanners nor humans produce (borderline test). |
| `MIN_LENGTH` | 8 | Shortest supported identifier (EAN-8). |
| `MAX_LENGTH` | 14 | GTIN-14 ceiling; longer bursts are noise and reset. |
| `IDLE_CLEAR_MS` | 200 | Inactivity after which a **partial** buffer is discarded (privacy). 4× `MAX_INTER_KEY_MS`: the timer is re-armed on every accepted digit and every scanner gap is ≤ 50 ms, so a live scan can never expire mid-burst (test B); ≈ 2.5× shorter than a human's ≥ 500 ms pause, so stale raw digits never outlive an ordinary interval. A person pausing > 200 ms mid-number loses only a partial buffer that could not have become a scan anyway (a > 50 ms gap already restarts the burst). Kept in the hook (the detector stays clock-free); the constant lives in `HARDWARE_SCAN_TUNING` for one-place tuning. |
| `DUPLICATE_SCAN_WINDOW_MS` | 1500 | (in `product-lookup-field.tsx`) re-scan of the same code inside this window, or while its lookup is unsettled, is a trigger double-pull. |

These values are reasoned, **not measured on physical hardware** (see Real-hardware QA). If a slow
Bluetooth model misses scans, raise `MAX_INTER_KEY_MS`/`MAX_AVG_INTER_KEY_MS`; if false positives ever
appear, lower them.

Classification needs ALL of: digits only · every gap ≤ 50 ms · mean gap ≤ 35 ms · ≥ 8 digits · a terminator
within 50 ms of the last digit. Then the identifier must pass real validation (`acceptDecodedBarcode`:
length 8/12/13 **and** GS1 check digit) — validation is the final authority. A fast, terminated burst of
8–14 digits that fails validation is `rejected` (notice), not silently dropped.

### Partial-buffer clearing (final remediation)
The buffer is discarded on **all** of: idle timeout (200 ms) · focus leaving any field (`focusout` / capture
`blur`) and window blur · unmount · detector disabled (camera dialog opens ⇒ effect cleanup) · any non-digit,
Backspace/arrow/Escape/F-key · Ctrl/Alt/Meta · IME composition / `repeat` · a key from a blocked or
out-of-scope target · a completed scan · a rejected scan. Timer safety: exactly **one** timer
(`idleTimer`); it is cancelled before being re-armed, on every `clear()`, and on cleanup; the callback
re-checks `idleTimer === its own handle` and a `disposed` flag so a stale callback can never wipe a newer burst
or run after unmount; the callback touches no React state. A bare Shift inside a live burst leaves buffer and
timer alone (so a scan containing Shift is not broken).

### Keys the detector refuses
`isComposing` / `keyCode 229` / `Process` / `Dead` (IME) · any Ctrl/Alt/Meta combination · `event.repeat`
(a held `0` would otherwise form a valid EAN-8 `00000000`) · letters and symbols · Backspace/arrows/Escape/
F-keys (end the burst) · bare Shift/CapsLock/NumLock (ignored, don't break a burst). Paste produces no key
burst, so it is ordinary manual input.

### Terminators
Enter and Tab. They are consumed (`preventDefault` + `stopPropagation`) **only** when a fast, ≥ 8-digit
burst is already buffered. With an empty or human-speed buffer, Enter/Tab are never touched — normal form
submission, button activation and Tab navigation are intact (unit + E2E). Consuming Enter also stops the
barcode field's own Enter handler from running a second lookup.

### Focus strategy — "never eat legitimate typing" (chosen approach: snapshot & restore)
Scanner digits land in whichever field has focus *before* we can know it is a scanner. Blocking keys
speculatively would destroy human typing, so:
1. Keys are never blocked while a burst is unconfirmed.
2. When a candidate burst **starts** on a text field, its value and selection are snapshotted.
3. When the terminator confirms a scan (or a rejected scanner-shaped burst), the field is restored to the
   snapshot through the native value setter + an `input` event (so controlled React fields and
   uncontrolled fields both revert), and the barcode field receives the identifier.
4. If the burst is not a scan, the snapshot is dropped and the typed text stays exactly as typed.
Result: "Coca-Cola 50cl" stays "Coca-Cola 50cl" (unit + E2E A/C), also for `type=number` and `textarea`
(no newline injected).

### Activation scope & sensitive-input exclusion
* Listener (`keydown`, capture, on `document`) exists **only while `ProductLookupField` is mounted and
  `enabled`**; it is removed on unmount and while the camera dialog is open. No app-wide listener.
* Event targets must be inside the product `<form>` (or `<body>`). Anything else (global search, sidebar,
  dialogs) resets the buffer immediately.
* `classifyTarget` **blocks**: `type=password|hidden|file`, `autocomplete` of `cc-*` / `one-time-code` /
  `current-password` / `new-password`, anything under `[data-no-hardware-scan]`, contenteditable, native
  `<select>`, ARIA roles `combobox|listbox|textbox|searchbox|spinbutton|slider`, date/time/color/range
  inputs, and unknown elements. Blocked targets buffer nothing.
* Read-only fields and buttons/links/checkboxes are *passive* (scan works, nothing to snapshot).

### Keylogger-risk analysis
A keystroke listener is inherently sensitive, so the design is deliberately minimal:

| Risk | Mitigation | Evidence |
| --- | --- | --- |
| Global keylogging | Mounted only on the product lookup surface; scope-checked per event | `use-hardware-barcode-scanner.ts` `classifyTarget`; unit "keys outside the form ignored", "removed on unmount" |
| Sensitive-field capture | Password / cc / OTP / opt-out / contenteditable / select blocked | unit: password, cc-number, `data-no-hardware-scan`; E2E injected password field |
| Retention | ≤ 14 digits, in memory in a detector instance; cleared on every non-digit, terminator, unmount, focus/window blur **and after 200 ms of inactivity** | `hardware-detector.ts` `reset()`; `use-hardware-barcode-scanner.ts` `armIdle`/`clear`; `use-hardware-barcode-scanner.test.tsx` (26 tests) |
| Exfiltration | Detector has no network code; only an *accepted* identifier goes to the existing action | grep: no `fetch`/`sendBeacon`/storage/console in the three files |
| Persistence / telemetry | None — no localStorage/sessionStorage/IndexedDB/analytics/logging | same grep |
| Shortcut interference | Ctrl/Alt/Meta reset the buffer and are never prevented | unit "Ctrl/Meta/Alt … not prevented" |

### Duplicate & replacement scans
* Same code again while its lookup is live ⇒ ignored (one request). When the scanner's own keystrokes edit
  the barcode field they cancel that lookup's result (editing always abandons a lookup), so the duplicate
  path **re-adopts the same promise** — still one server call, result still shown (unit + E2E D).
* Same code after the window and settled ⇒ fresh lookup (unit, `performance.now` stubbed).
* Different code while A pending ⇒ `applyScannedIdentifier` → `resetForNewValue()` bumps `requestId` →
  B's lookup runs; A's late response is dropped by 1Q-C's `requestId` guard (unit + E2E E with A held 2.5 s).

### Reuse of 1Q-C / 1Q-D
`handleScanned` (camera) and `handleHardwareScan` both end in `applyScannedIdentifier(identifier)` →
`onBarcodeChange` + `resetForNewValue` + `runLookup`. Normalisation, auth, tenant scope, local-first lookup,
provider protections/SSRF/caching and form preservation are untouched (`lib/products/lookup/**` has no diff).
The `ScannerDialog`/camera code is untouched; the hardware listener is detached while the dialog is open.

### Test-only seams (no production bypass)
`hardwareTimeSource` (prop on `ProductLookupField`, like 1Q-D's `scannerDeps`) lets unit tests supply
timestamps. It only changes how the *browser* classifies key timing — something a user controls anyway — and
carries no server authority. E2E uses Playwright's real keyboard (delay 0 vs 120 ms); nothing test-only
ships.

---

## 3 — App Flow & State Map

Detector states (explicit, per burst): `IDLE → BUFFERING → (SCAN_DETECTED | REJECTED | back to IDLE)`.
`LOOKUP_PENDING` / `ERROR` are the existing 1Q-C component states (`pending`, `PROVIDER_ERROR`), not a second
machine.

```
key ─ blocked target / out of scope ─────────────────────→ reset, ignore
key ─ modifier / IME / repeat / non-digit / other key ───→ reset, ignore
digit ─ gap > 50 ms ─→ restart burst (snapshot text field) ; else append (≤ 14) ; (re)arm 200 ms idle timer
idle 200 ms ─ partial buffer ─→ reset, drop snapshot
blur / focusout / window blur / unmount / detector disabled ─→ reset, cancel timer
Enter|Tab ─ < 8 digits | slow | mean > 35 ms ────────────→ reset, key behaves normally
Enter|Tab ─ fast ≥ 8 digits ─ valid ─→ restore field, consume key, notice "Barcode scanned." → lookup
                             └ invalid → restore field, consume key, barcode field = raw digits,
                                         alert "That scan isn't a valid product barcode…", NO lookup
lookup result ─ LOCAL_MATCH | EXTERNAL_MATCH (explicit apply) | NOT_FOUND | INVALID | PROVIDER_ERROR
```
Coverage: loading ("Looking up barcode…", existing), empty (n/a), validation (invalid notice), error
(provider/network — recoverable, form kept), permission-denied (n/a — no device permission exists).

---

## 4 — UI/UX Design Brief

Inherits the existing design system unchanged. Additions inside `ProductLookupField`, all plain text using
existing tokens (`text-xs/text-sm`, `text-muted-foreground`, `text-destructive`) so light/dark work for free:
* Help line under the row: "Most USB and Bluetooth barcode scanners work automatically when set to send Enter
  after a scan." (`id="barcode-scanner-help"`, referenced by the input's `aria-describedby`).
* `role="status"` "Barcode scanned." after an accepted scan; `role="alert"` for an invalid scan.
* No modal, no toggle, no icon (Font Awesome abstraction untouched; no Lucide).
Accessibility: Enter/Tab untouched unless a scan is confirmed; no focus trap or hidden focusable element is
added; screen readers get the status/alert regions; the field label and existing error wiring are unchanged.

---

## 5 — Backend & Data Design

Unchanged. No migration, table, RPC, grant, policy or server-action change. Scans feed the existing
`lookupProductByIdentifier` (`requireUser` → `products.view` → business-scoped RPC → provider only for
GTIN-family + `products.manage`). Raw key streams never leave the browser.

---

## 6 — Engineering Implementation Plan

1. Pure detector + exhaustive deterministic unit tests (33). Final remediation: hook idle-timeout/blur clearing + 26 fake-timer hook tests.
2. DOM hook (scope, classification, snapshot/restore, terminator consumption).
3. Integrate into `ProductLookupField`; factor `applyScannedIdentifier`; duplicate policy; notices; help line.
4. Component integration tests (30) with a fake clock and browser-faithful key emulation.
5. Playwright E2E (13) with real keyboard; responsive/theme sweep; regression of 1Q-C + 1Q-D E2E.
6. Validation (types, lint, unit, build, audit), this brief.

Rollback: `git checkout -- apps/web/components/products/product-lookup-field.tsx` and delete the two new
`lib/products/scanner/*hardware*` files plus their tests/spec/brief. No data or schema to revert.

---

## Files changed

Modified: `apps/web/components/products/product-lookup-field.tsx`
Added: `lib/products/scanner/hardware-detector.ts` (+ `IDLE_CLEAR_MS`), `lib/products/scanner/use-hardware-barcode-scanner.ts` (idle timer, blur),
`lib/products/scanner/use-hardware-barcode-scanner.test.tsx` (idle/blur/cleanup tests), `lib/products/scanner/hardware-detector.test.ts`, `components/products/product-hardware-scan-integration.test.tsx`,
`tests/e2e/product-hardware-scanner.spec.ts`, this brief. (Screenshots: `qa-screenshots/1q-e-lookup-*.png`, untracked QA output.)

## Validation results (this session)

| Check | Result |
| --- | --- |
| Hardware detector unit | 33 / 33 pass |
| Hardware hook (idle/blur/cleanup, fake timers) | 26 / 26 pass |
| Hardware component/integration | 30 / 30 pass |
| Full unit suite (`vitest run`) | 100 files, 1456 tests pass (includes 1Q-C + 1Q-D unit regressions) |
| Hardware E2E | 13 / 13 pass (re-run after the idle-timer change) |
| 1Q-C + 1Q-D E2E regression | 21 / 21 pass (34 / 34 in the combined run) |
| `tsc --noEmit` | clean |
| `eslint` | clean |
| Production build (`scripts/build-for-e2e.mjs` → `next build`) | success |
| `pnpm audit --prod` (2026-09-30, after the final change) | **PASS — "No known vulnerabilities found" (0)**. No `package.json`/lockfile diff from this phase. |
| Note on earlier audit text | An earlier draft of this brief recorded a failing audit (12 vulnerabilities). That observation could not be reproduced by an independent run or by the run above; it is **not** current evidence and was removed. |
| Formatting | UNKNOWN — repo defines no format script; not run |
| axe / Lighthouse | UNKNOWN — not installed; not run |
| DB integration | Not run — no migration/server/data change |

Responsive/theme QA (E2E sweep, no horizontal overflow, help/Look up/Scan visible, screenshots saved):
390 ✔ · 430 ✔ · 768 ✔ · 1280 ✔ · 1440 ✔, each in light and dark. 390-dark screenshot reviewed by eye.

## Accepted follow-ups (do not block the phase; no code or dependency added for them)
* **REAL DEVICE QA** — USB keyboard-wedge scanner; Bluetooth keyboard-wedge scanner; Android Bluetooth scanner if applicable; validate the 50 ms / 35 ms thresholds.
* **ACCESSIBILITY** — automated axe / Lighthouse run and contrast measurement (neither tool is installed; not run).
* **PLATFORM HARDENING (Phase 1P)** — per-user rate limiting on `lookupProductByIdentifier` (control 28) and CSP / security headers (control 46) are pre-existing, app-wide, and deferred to Phase 1P.

## Real-hardware QA status
**No physical USB or Bluetooth scanner was available; none tested.** CI simulation (Playwright trusted
keystrokes) validates the logic, not any scanner model; it is not certification. Mobile/tablet Bluetooth
scanner behaviour is also untested. Follow-up for the owner: scan with (a) a USB wedge scanner, (b) a
Bluetooth one, on desktop Chrome and Android, checking the 50 ms / 35 ms thresholds; consider logging-free
tuning if a model misses scans.

## Limitations
* Timing thresholds unproven on real devices.
* Focus on a native `<select>` or custom combobox (e.g. branch picker) is deliberately *blocked*: digits
  there may type-ahead the selection, and a scan will neither work nor be restored on that control.
* Scanners configured with a prefix, without a terminator, or emitting non-digit payloads are unsupported.
* Only the product-creation form is covered (by design).
* Field restore relies on the intermediate digit `input` events being harmless; an app-side `onChange` that
  triggers irreversible side effects on each keystroke would need review (none exists in this form).

---

## Security assessment — 70 controls

Scope: the 1Q-E change (client keyboard handling + reuse of the existing 1Q-C action) plus repo-level facts
verified this session (git-tracked env files, source maps, lockfile, `pnpm audit`, workflows dir, dependency
diff). Deployed surface reviewed: **no** (local E2E only). `N/A` here means the surface does not exist in
the change and was not introduced by it; it is **not** a claim about the rest of the app. `UNKNOWN` is used
where app-wide or deployed evidence is required.

**SUMMARY — PASS 26 · FAIL 2 · UNKNOWN 16 · N/A 26 = 70**

### FAIL
* **28 Missing rate limits — FAIL (pre-existing, 1Q-C).** Evidence: `lib/products/lookup/actions.ts` has no
  per-user/IP limit; mitigations are UI in-flight/duplicate guards (1Q-E) and server-side provider cache and
  in-flight dedupe. Failure mode: an authenticated user could script the action. Smallest fix: per-user
  limiter on `lookupProductByIdentifier`. Verify: automated burst test expecting 429-style result.
* **46 Missing security headers — FAIL (pre-existing).** Evidence: `next.config.ts` defines no `headers()`/CSP
  (also noted in 1Q-D brief). Fix: add CSP/nosniff/frame headers app-wide. Verify: response headers on the
  deployed origin.

### UNKNOWN (evidence not accessible here)
07 Open DB permissions · 08 Supabase rules (DB integration not run; no DB change) · 11 Build logs · 13 Git
history secrets (not scanned) · 20 CSRF (Server Action origin checks not verified this session) · 29
Staging protection · 30 Default credentials · 41 DB role privileges · 43 Monitoring/alerts · 44 Backup/restore
· 45 Internal dashboards · 47 Cookie attributes (deployed) · 48 TLS/at-rest (deployed) · 55 MFA (account
setting) · 60 CI/CD credentials · 64 Resource limits/quotas (provider timeouts not re-verified this phase).
Each needs the named deployed/account evidence; owner: repo/account owner.

### PASS (evidence)
| # | Control | Evidence |
| --- | --- | --- |
| 01 | DB credentials | Diff reads no env/config; grep of the 3 changed files clean |
| 02 | Public .env | `git ls-files` shows only `.env.example`, `.env.test.local.example` |
| 03 | Hardcoded keys | No keys in diff (grep) |
| 04 | Authentication | `requireUser()` at `lookup/actions.ts:42,135` — unchanged path |
| 05 | Server authz | `PRODUCTS_VIEW` check `actions.ts` ~L140; `PRODUCTS_MANAGE` gates provider |
| 06 | Cross-user data | Business-scoped RPC; E2E "cross-business isolation" (1Q-C spec) passes |
| 10 | Debug tools | No debug routes; test seam prop is inert in production |
| 12 | Verbose errors | Lookup failures mapped to static copy (`lookup/messages.ts`); catch → `PROVIDER_ERROR` |
| 14 | Frontend secrets | No secrets added to client code |
| 15 | Client-only checks | Client `acceptDecodedBarcode` is UX only; server re-validates (`actions.ts`) |
| 16 | Input validation | Client check-digit + length; server normalization via RPC |
| 17 | SQL injection | Parameterised `supabase.rpc(..., {p_raw_value})`; no SQL in diff |
| 19 | XSS | Scanner value only rendered as React text / input value; no `dangerouslySetInnerHTML` (grep) |
| 23 | SSRF | No new outbound fetch; detector emits digits only; `lookup/**` has no diff; provider tests pass |
| 33 | IDOR/BOLA | Business id authorised server-side per call (`getPermissions(businessId)`) |
| 34 | Identity from session | `requireUser`/`getPermissions`; no role/id from client input |
| 35 | Sensitive data in logs | No logging in detector/hook/field (grep for `console`) |
| 36 | Source maps | No `*.map` in `.next/static`; `productionBrowserSourceMaps` unset |
| 37 | Vulnerable dependencies | `pnpm audit --prod` run 2026-09-30 → "No known vulnerabilities found"; no dependency change in this phase |
| 38 | Malicious packages | No dependency added (`package.json`/lockfile no diff) |
| 49 | Tenant isolation | Same as 06 |
| 50 | AI-code over-trust | Full-diff review, 63 new tests, typecheck/lint/build/E2E run, findings fixed (duplicate-adoption bug found by reasoning and covered by test) |
| 58 | Race conditions | `requestId` stale guard + in-flight + promise re-adoption; unit "replacement", "duplicate (barcode focused)"; E2E D/E |
| 62 | Unpinned deps | `apps/web/pnpm-lock.yaml` tracked |
| 63 | Fail-open checks | Unauthorised/errored lookup returns `INVALID`/throws, never a match (`actions.ts`) |
| 68 | Browser storage | No local/sessionStorage/IndexedDB in the change (grep); raw keystrokes never stored; partial buffer is memory-only and idle-cleared after 200 ms (`use-hardware-barcode-scanner.test.tsx`: expiry, blur, unmount, invalid key, completed/rejected scan) |

### NOT APPLICABLE (reasons)
09 Admin routes — no admin surface in the change (product-creation form only) · 18 NoSQL — app uses Supabase
Postgres; no document-store dependency in `package.json` · 21 Uploads — change accepts no files · 22 Path
traversal — no path/filename input · 24 Password reset — no auth flow touched · 25 Sessions — no session
handling touched · 26 JWT — no JWT handling in the change · 27 CORS — no cross-origin API added · 31 Webhook
signatures / 59 replay — no webhook added · 32 Payments — no payment/entitlement code · 39/40/65/66/67 AI —
no LLM or agent feature exists in the change · 42 Audit logs — scan/lookup is read-only, no sensitive state
change · 51 Mass assignment — no endpoint accepting a write object was added (scan only sets a client field) ·
52 Command injection — no subprocess · 53 Deserialization — none of untrusted data · 54 OAuth — no social
login touched · 56 Account enumeration — no account flow · 57 Business-logic — scan changes no money/quantity
· 61 Untrusted CI actions — no `.github/workflows` directory · 69 Open redirects — no redirect added ·
70 GraphQL/WebSocket — none in the change.

### Focus-area conclusions
Keylogging/privacy: scoped, digit-only, ≤ 14 chars, in memory, idle-cleared after 200 ms and on blur/unmount/invalid key, no storage/telemetry — PASS. Sensitive input
exclusion — PASS (unit + E2E). Client-input trust / scanner spoofing: any keyboard can imitate a scanner; that
is acceptable because the scan is not an authority boundary — server still enforces auth, tenant scope,
identifier validation and provider protections. Stale races / flooding — PASS for the client; server-side
rate limit is FAIL 28 (pre-existing). Form integrity — PASS. XSS — PASS. Test-only hooks — PASS (inert props).
Storage/telemetry — PASS (none).

## Release decision (for 1Q-E): **PASS WITH FIXES**
No FAIL touches authentication, authorization, private data, payments, secrets or spend, and none was
introduced by 1Q-E. Open items: FAIL 28/46 (pre-existing; owner: repo owner), 16 UNKNOWNs (deployed
evidence), and **real USB/Bluetooth hardware QA outstanding** (Codex to decide whether that blocks freeze).

## Checklist status (`build-checklist.md`, 95 items)
PASS 59 · FAIL 1 · UNKNOWN 11 · N/A 24 (= 95).
FAIL: §5 security headers (dependency currency and §12 dependency scan are now PASS — `pnpm audit --prod` clean). UNKNOWN: §6 contrast measurement, §6
automated a11y tool, §7 bundle weight, §9 human walkthrough (real scanner), §12 formatting, §12 a11y,
§14 error routing, §14 alerts, §15 backups ×3. N/A items are sections genuinely absent for a client-only,
unpublished change (SEO ×4, deployment/HTTPS/smoke, README/env, migrations, DB integration, backup of new
state, feature flags).
