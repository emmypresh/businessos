# Phase 1Q-D — Mobile Camera Barcode Scanner — Build Brief

Baseline: `67192eb` on `feature/expenses-financials`. Nothing staged, committed or pushed.
Builds on 1Q-B (identifier model, check-digit rules) and 1Q-C (local-first lookup,
provider protections, `ProductLookupField`). **No migration, no server change, no new
dependency.**

Six build documents live in this one file, lean by design (small, client-only phase):
§1 PRD · §2 Technical Design · §3 App Flow & State Map · §4 UI/UX Brief ·
§5 Backend & Data Design (deliberately one paragraph — nothing changes) · §6 Engineering Plan.

---

## 1 — Product Requirements Document

**Problem.** Typing a 13-digit barcode on a phone is slow and error-prone.
**Goal.** Tap **Scan**, point the camera, and feed the decoded identifier into the *existing*
1Q-C lookup — same pipeline, same results, same form-preservation guarantee.

| Must have | Acceptance (observable) |
| --- | --- |
| Scan with phone/tablet camera from product creation | `Scan` button beside `Look up` opens a dialog with a live preview (E2E A) |
| Reuse 1Q-C lookup | The scanned value calls the same `lookupProductByIdentifier` server action; no second path (unit + E2E B) |
| Local / external / not found / invalid / error all handled | E2E B, C, D; invalid + QR ignored (E2E) |
| Never wipe the form | Typed name/price survive every outcome (unit + E2E E, H) |
| Camera always released | `track.stop()` on close, Escape, unmount, success, hide, switch (unit + E2E G) |
| Manual entry always available | "Enter barcode manually" in every state (E2E E) |
| Privacy | Frames never leave the browser; only the digit string is used (§ Privacy model) |

**Success.** A user on a 390px phone scans a product and sees the same result card as a typed lookup.

**Out of scope (confirmed absent).** Hardware-scanner support, POS scan-to-sell, unknown-product
quick-create (1Q-F), label printing, serial/IMEI, variants, purchase orders, torch, zoom,
image/file barcode upload, scanning on product detail/identifier pages, UPC-E.

---

## 2 — Technical Design Document

### Scanner implementation approach
Three layers, all injectable so nothing needs real camera hardware:

| Layer | File | Responsibility |
| --- | --- | --- |
| Acceptance | `lib/products/scanner/barcode.ts` | Only EAN-13 / EAN-8 / UPC-A with matching length **and** valid GS1 check digit pass; everything else dropped |
| Decoder | `lib/products/scanner/decoder.ts` | `BarcodeDecoder.detect(video)`; native `BarcodeDetector`, restricted to our 3 formats ∩ what the browser supports |
| Camera | `lib/products/scanner/camera.ts` | `getUserMedia` wrapper, support/insecure-context check, error classification, `stopStream` |
| Lifecycle | `lib/products/scanner/use-barcode-scanner.ts` | State machine, stability, lock, visibility, single-owner, cleanup |
| UI | `components/products/barcode-scanner-dialog.tsx` | Dialog surface + controls |
| Integration | `components/products/product-lookup-field.tsx` | `Scan` button; scan → `runLookup(value)` |

### Decoder strategy (native only, no dependency)
Native `BarcodeDetector` is used where available (Chromium/Android Chrome, Edge). **No
fallback library was added.** Reasons: (1) the brief says add one only if required and to avoid
large dependencies; (2) any WASM/worker decoder (e.g. ZXing-WASM) would need CSP `wasm-unsafe-eval`
and/or `worker-src blob:` decisions and a supply-chain review not justified yet; (3) the
manual path always works. **Known limitation:** browsers without `BarcodeDetector` (notably
iOS Safari today) show "Camera scanning is not supported on this browser. Enter the barcode
manually." and never prompt for the camera. **Revisit trigger:** if iOS usage is material, add a
lazily-loaded, maintained WASM decoder behind the same `BarcodeDecoder` interface with its own
CSP/license/bundle review — no UI change needed.

### Supported formats
EAN-13, EAN-8, UPC-A (a UPC-A code that a detector reports as EAN-13 with a leading 0 passes
as EAN-13, which the server already normalizes). GTIN-14/UPC-E/QR/Code-128 etc. are dropped
(`acceptDecodedBarcode` → `UNSUPPORTED_FORMAT`); QR codes are explicitly not product barcodes.

### Camera lifecycle & permissions model
1. Dialog opens → `ScannerSurface` mounts → `start()`.
2. Support check: insecure context → `CAMERA_INSECURE_CONTEXT`; no `getUserMedia` → `CAMERA_NOT_SUPPORTED`.
3. **Decoder is created before asking for the camera**, so an unsupported browser is never prompted.
4. `getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })`. `ideal`, not `exact`:
   rear camera preferred, front/laptop camera used when none. `OverconstrainedError` retries with `video: true`.
5. Stream → `<video muted playsInline>` (`object-cover`), `play()`; device ids enumerated only *after*
   permission (labels never read) to decide whether **Switch camera** appears.
6. Decode loop every 125 ms (~8/s, not camera FPS).
7. Any exit path calls `release()`: stops every track, clears the timer, detaches `srcObject`, frees the camera lock.

Permission is requested once per open. A blocked permission is **never** re-requested automatically;
only the user's **Try again** re-asks, and the copy explains browser settings may be required.

### Stream cleanup strategy
A generation counter is bumped on every start/stop/pause/unmount; every async continuation checks it.
A `getUserMedia` that resolves *after* the dialog closed stops its own stream immediately (unit-tested).
`useEffect` cleanup runs `release()` on unmount/navigation. Successful scans release the camera
**before** `onDetected` runs. Hidden tab (`visibilitychange`) → `release()` + `PAUSED` ("Resume scanning").
Switching cameras stops the old track before opening the new one (order asserted in unit test).
A module-level owner token allows one active scanner at a time (`CAMERA_IN_USE` otherwise).

### Duplicate / stale scan protection
* **Stability:** a value must be seen on two consecutive detections (an empty run of ≥3 ticks resets); a single noisy frame never fires.
* **Lock:** on confirmation `lockedRef` is set, state → `DETECTED`, the loop stops and the camera is released; repeat detections cannot fire again (unit: repeated identical detections → `onDetected` once; E2E F: exactly 1 POST).
* **Stale:** the scan goes through `runLookup`, which reuses 1Q-C's `requestId` + `inFlight` guards; `handleScanned` bumps `requestId` first, so a slow lookup for scan A cannot overwrite scan B (unit-tested A→B).

### Integration with 1Q-C
`handleScanned(value)` → closes dialog → `onBarcodeChange(value)` (only the barcode field) →
`runLookup(value)` → `lookupProductByIdentifier(businessId, value)` (unchanged server action:
`requireUser`, `products.view`, business-scoped RPC, then external provider only for GTIN-family
+ `products.manage`). The scanner has **no** provider access and no second lookup path.

### Privacy model
Frames exist only inside the `<video>` element and the native detector. No canvas export,
`toDataURL/toBlob`, `ImageCapture`, `MediaRecorder`, `fetch`, `sendBeacon`, storage or logging exists
in scanner code (grep-verified, see §70 #35/#68). Only the decoded digit string reaches the server
action. The dialog tells the user this. No barcode values or frames are logged or sent to analytics.

### CSP impact
None. The repo currently ships no CSP (`next.config.ts` has no `headers()`; no Permissions-Policy).
Native `BarcodeDetector` needs no worker, WASM or blob permission, so nothing was added or
weakened. Camera access is governed by the default `camera=(self)` Permissions-Policy. Recommendation
for the whole-app security pass: when a CSP is introduced, `media-src` is not required for
`srcObject` streams and no `blob:` allowance is needed by this phase.

### Test-only mocking (no production bypass)
E2E replaces `getUserMedia`/`BarcodeDetector` with a Playwright `addInitScript` per page (nothing
in the app bundle). The `scannerDeps` prop on `ProductLookupField` is a dependency-injection seam
used by unit tests; it carries no server authority (a caller can only alter what the *browser*
decodes — which a user controls anyway — and every value still passes server auth, permission and
check-digit validation). It is not a bypass.

---

## 3 — App Flow & State Map

```
[Scan] → dialog → REQUESTING_PERMISSION → SCANNING ─(2 matching valid frames)→ DETECTED
                        │                     │  ├ invalid check digit → notice, keep scanning
                        │                     │  ├ no code 12 s → notice, keep scanning
                        │                     │  └ tab hidden → PAUSED → [Resume]
                        └→ ERROR (PERMISSION_DENIED | NOT_FOUND | NOT_SUPPORTED |
                                  INSECURE_CONTEXT | IN_USE | START_FAILED)
DETECTED → camera released → dialog closes → barcode field set → 1Q-C lookup
   LOCAL_MATCH (View product) | EXTERNAL_MATCH (explicit "Use product details") |
   NOT_FOUND ("No product information found…") | INVALID | PROVIDER_ERROR
```
Lookup-side states are intentionally the existing 1Q-C `LookupResult`; the scanner's own states are
`IDLE · REQUESTING_PERMISSION · SCANNING · DETECTED · PAUSED · ERROR`.

**Error taxonomy** (plain-language copy; raw DOMException text never shown):
`CAMERA_PERMISSION_DENIED`, `CAMERA_NOT_FOUND`, `CAMERA_NOT_SUPPORTED`, `CAMERA_INSECURE_CONTEXT`,
`CAMERA_IN_USE`, `CAMERA_START_FAILED`; notices `INVALID_IDENTIFIER`, `BARCODE_NOT_DETECTED`.
**Retry:** *Try again* (permission denied / in use / start failed) and *Resume scanning* (paused);
not offered for unsupported/insecure/no-camera where retry cannot help. No page reload needed.
**Offline:** decoding is local and keeps working; if the lookup fails the 1Q-C `PROVIDER_ERROR`
state shows a recoverable message and the scanned barcode stays in the field.

Coverage: loading (`Starting camera…`), empty (n/a), validation (invalid notice), error, permission-denied — all defined.

---

## 4 — UI/UX Design Brief

Inherits the existing design system (Dialog, Button, Alert tokens, Font Awesome via `@/components/ui/icon` —
added `Barcode`, `Camera`, `CameraRotate`; no `lucide-react`). Field row: `[Barcode input]` full width on
mobile, then `[Look up] [Scan]` as equal 44px-high buttons (`h-11`, `sm:h-8` on desktop). Dialog: title,
privacy sentence, 4:3 preview (`object-cover`, 38dvh in landscape ≤500px height), white scan frame with a
dark hairline (visible on both themes over video), status line, then stacked 44px actions
(Try again / Resume · Switch camera · Enter barcode manually · Close scanner) — thumb-reachable at the bottom.
Accessibility: labelled `Scan barcode with camera` and `Close scanner`; status in `role="status"`
(errors `role="alert"`); `<video>`/frame are `aria-hidden` (text carries meaning, never colour alone);
base-ui Dialog gives focus trap, Escape, focus return to Scan (E2E asserts `Scan` is focused after close);
manual entry moves focus to the barcode field.

---

## 5 — Backend & Data Design

Unchanged. No migration, table, RPC, grant or server-action change. The scanner feeds the existing
`lookupProductByIdentifier`. This section is one paragraph because there is no backend work to describe.

---

## 6 — Engineering Implementation Plan

1. Scanner library (types → barcode → decoder → camera → hook) with unit tests.
2. Dialog component; icons.
3. Integrate into `ProductLookupField` (refactor `runLookup(valueOverride)`, `resetForNewValue`).
4. Field-level integration tests; Playwright spec with injected fake camera.
5. Validation, responsive/theme QA, this brief.

Rollback/recovery: revert `product-lookup-field.tsx` (removes the button and dialog mount) — every other
new file is then dead code; no data or migration to undo. Product creation and manual lookup never depended
on the scanner. Files: see report.

---

## Test strategy & results

| Suite | Result |
| --- | --- |
| Focused scanner unit (`lib/products/scanner`, `product-scan-integration`) | 27 + 6 passing |
| Lookup regression unit (`components/products`, `lib/products`) | 134 passing (10 files) |
| Full unit | 97 files / 1367 tests passing |
| Focused scanner E2E | 9 / 9 passing |
| 1Q-C lookup E2E regression | 12 / 12 passing |
| `tsc --noEmit` / `eslint` | clean |
| Production build (`build-for-e2e.mjs`) | compiled successfully |
| `pnpm audit --prod` | No known vulnerabilities found |
| Integration (DB) | not re-run — no DB/server behavior changed |
| Automated a11y (axe/Lighthouse) | **not run** (UNKNOWN); keyboard/focus covered by E2E only |
| Real-device camera / real `BarcodeDetector` | **not run** (UNKNOWN) — Playwright uses an injected fake |

Responsive QA (E2E sweep, light + dark, no horizontal overflow, Close button in viewport and ≥40px):
390, 430, 768, 1280, 1440 and landscape 844×390. Screenshots in `qa-screenshots/1q-d-*.png`.
A landscape overlap bug (preview covering status/first button) was found in the first screenshot
review and fixed before the final run.

---

## Security audit (vibe-code-security-auditor lens)

Mode: FEATURE AUDIT of the 1Q-D diff, read-only apart from building the feature itself.
Focus checks: permission misuse (no auto re-prompt; one request per open); stream cleanup (unit + E2E
`live === 0` after close/Escape/success); browser-API misuse (no frame export APIs); third-party
decoder supply chain (none added; lockfile unchanged); stale races (unit A→B); camera privacy
(no upload/storage/logging); identifier validation (client filter + server re-validation, invalid never
reaches provider); test-only bypasses (init script only; `scannerDeps` documented above); CSP (no change).
**Findings:** none CRITICAL/HIGH. INFO: `scannerDeps` is shipped in the bundle as an unused optional prop.

---

## 70-control security assessment

Scope assessed: this phase's diff (Phase 1Q-D), following the 1Q-C convention — `N/A` means *this feature
itself* adds none of that surface; `UNKNOWN` means a pre-existing whole-app or account/infrastructure fact
this diff neither introduces nor changes and that was not reassessed. Deployed surface reviewed: no
(local stack only). **FAIL — none.**

| # | Control | Status | Evidence / reason |
| --- | --- | --- | --- |
| 01 | Exposed DB credentials | PASS | Scanner files contain no connection strings or env reads (files read in full). |
| 02 | Public .env files | PASS | `git ls-files` tracks only `.env.example` and `.env.test.local.example`; no env file touched. |
| 03 | Hardcoded secrets | PASS | New files are pure client logic; no keys. |
| 04 | Weak/missing authentication | PASS | Lookup still goes through `requireUser()` (`lib/products/lookup/actions.ts:135`); no new route. |
| 05 | Missing server-side authorization | PASS | `products.view`/`manage` checked in `actions.ts:141-152`; `actions.test.ts` in full unit run. |
| 06 | Cross-user data access | PASS | 1Q-C cross-business E2E re-run, 12/12 (`product-lookup.spec.ts`). |
| 07 | Open database permissions | N/A | No migration, grant or policy changed. |
| 08 | Misconfigured Supabase | N/A | No Supabase configuration touched. |
| 09 | Unprotected admin routes | N/A | Feature adds no admin surface. |
| 10 | Debug tools exposed | PASS | No debug route; fakes exist only in the Playwright init script (`tests/e2e/product-barcode-scanner.spec.ts`), not the app. |
| 11 | Build logs leaking secrets | UNKNOWN | Whole-app CI/CD not reassessed (no `.github/workflows` found in repo). |
| 12 | Verbose production errors | PASS | Scanner errors normalized (`types.ts describeScannerError`); unit test confirms unknown error → generic copy. |
| 13 | Secrets in Git history | UNKNOWN | History scan not run. |
| 14 | Secrets in frontend JS | PASS | New client code has no secrets (read in full); built bundle not scanned for unrelated keys. |
| 15 | Client-side-only checks | PASS | Client check-digit filter is UX only; server re-validates (`lookup_product_identifier` RPC → INVALID). |
| 16 | Missing input validation | PASS | `acceptDecodedBarcode` + server normalization; `scanner-lib.test.ts`, `product-scan-integration.test.tsx`. |
| 17 | SQL injection | PASS | No SQL added; RPC parameters bound (`actions.ts:45`). |
| 18 | NoSQL injection | N/A | Postgres only; no document store. |
| 19 | XSS | PASS | No `dangerouslySetInnerHTML` in `components/products` or `lib/products` (grep); decoded value rendered as text. |
| 20 | CSRF | PASS | Uses existing Server Action (framework origin checks, unchanged); lookup is read-only. |
| 21 | Insecure file uploads | N/A | No upload; frames are never uploaded (no `fetch`/`toBlob` in scanner code). |
| 22 | Path traversal | N/A | No user input reaches a filesystem path. |
| 23 | SSRF | PASS | Scanner makes no outbound request; provider host allowlist unchanged (`off-base-url.test.ts` passes in full unit run). |
| 24 | Broken password reset | N/A | Feature has no password flow. |
| 25 | Weak session management | UNKNOWN | Whole-app auth, not reassessed. |
| 26 | Weak JWT validation | UNKNOWN | Whole-app, not reassessed. |
| 27 | Permissive CORS | N/A | No HTTP endpoint added. |
| 28 | Missing rate limits | UNKNOWN | Platform limiter not reassessed. Scanner adds client lock + 2-frame stability + in-flight guard (E2E: 1 POST per scan) but is not a limiter. |
| 29 | Unprotected staging | UNKNOWN | Deployment fact not visible. |
| 30 | Default credentials | UNKNOWN | Deployment fact not visible. |
| 31 | Webhook signatures | N/A | Feature receives no webhooks. |
| 32 | Frontend-only payment checks | N/A | No payment logic. |
| 33 | IDOR/BOLA | PASS | No object id accepted from the scanner; lookup business-scoped (see 06). |
| 34 | APIs trusting client roles/IDs | PASS | Permissions from session via `getPermissions` (`actions.ts:141`), not from input. |
| 35 | Sensitive data in logs | PASS | Grep of scanner code: no `console.*`, no logging, no frame/barcode logging. |
| 36 | Source maps/build artifacts | UNKNOWN | Whole-app build config not reassessed. |
| 37 | Vulnerable dependencies | PASS | `pnpm audit --prod`: "No known vulnerabilities found" (2026-09-30). |
| 38 | Malicious packages | PASS | Zero dependencies added; `package.json`/`pnpm-lock.yaml` unchanged (`git diff`). |
| 39 | Prompt injection | N/A | No LLM feature in this change. |
| 40 | AI tools bypassing permissions | N/A | No model-callable tools. |
| 41 | Excess DB privileges | N/A | No DB role/grant change. |
| 42 | Missing audit logs | PASS | Scan + lookup are read-only; no sensitive state change to audit. |
| 43 | Security monitoring/alerts | UNKNOWN | Deployment fact. |
| 44 | Tested backup/restore | UNKNOWN | Deployment fact. |
| 45 | Public internal dashboards | N/A | None added. |
| 46 | Missing security headers | UNKNOWN | No CSP/Permissions-Policy configured in `next.config.ts`; no deployed origin inspected. Scanner needs none. |
| 47 | Unsafe cookie settings | UNKNOWN | Whole-app, not reassessed. |
| 48 | Data in transit/at rest | UNKNOWN | Deployment TLS fact. Scanner itself refuses insecure contexts (`camera.ts getCameraSupportError`, unit-tested). |
| 49 | Poor tenant isolation | PASS | See 06. |
| 50 | Over-trusting AI-generated code | PASS | Diff reviewed; unit, E2E, typecheck, lint, build, audit run; a layout bug found and fixed from screenshots. |
| 51 | Mass assignment | PASS | No write surface added. |
| 52 | Command injection | N/A | No subprocess. |
| 53 | Unsafe deserialization | N/A | Decoder returns plain strings; no untrusted serialized data parsed. |
| 54 | OAuth misconfiguration | N/A | No third-party login. |
| 55 | MFA on privileged accounts | UNKNOWN | Account fact only the owner can confirm. |
| 56 | Account enumeration | N/A | No login/signup surface. |
| 57 | Business-logic abuse | PASS | Eligibility gating stays server-side (`actions.ts:151`); scanner cannot change price/stock. |
| 58 | Race conditions | PASS | Generation counter + lock + requestId (unit-tested: late stream stopped, A→B). |
| 59 | Webhook replay | N/A | No webhooks. |
| 60 | Overpowered CI/CD credentials | UNKNOWN | Whole-app. |
| 61 | Untrusted build actions | UNKNOWN | Whole-app. |
| 62 | Unpinned build dependencies | UNKNOWN | CI pinning not reassessed; lockfile unchanged. |
| 63 | Security checks fail open | PASS | Decoder missing/erroring → `CAMERA_NOT_SUPPORTED`/ERROR, not a bypass; server checks unchanged. |
| 64 | Missing resource limits | PASS | ~8 decodes/s throttle, 2-frame confirm, single camera owner, hidden-tab release, locked after success. |
| 65 | AI info disclosure | N/A | No LLM feature. |
| 66 | Unsafe AI output | N/A | No LLM feature. |
| 67 | Excessive AI agency | N/A | No agent. |
| 68 | Sensitive browser storage | PASS | No `localStorage`/`sessionStorage`/IndexedDB in scanner code (grep). |
| 69 | Open redirects | PASS | Only link is the unchanged same-tenant `View product` href. |
| 70 | GraphQL/WebSocket/realtime | N/A | None used. |

**Totals: PASS 30 · FAIL 0 · UNKNOWN 17 · N/A 23 → 70.**

**Residual risk.** (1) Real-device behavior (iOS Safari unsupported; Android Chrome real `BarcodeDetector`,
autofocus, lighting) is untested — Playwright uses a fake; owner: project owner on a physical phone.
(2) Automated a11y scan not run. (3) No CSP exists app-wide (whole-app item). (4) The 17 UNKNOWNs are
pre-existing whole-app/account facts (same set as 1Q-C), owner: project owner.

**Release decision: PASS WITH FIXES** — zero FAIL, every UNKNOWN has an owner and a non-code path; the
explicit follow-ups are a physical-device smoke test and an axe/Lighthouse pass.

---

## Deferred follow-ups (accepted LOW, Codex-approved; do not reopen 1Q-D)

1. **Physical-device QA before launch** — Android Chrome (real camera + `BarcodeDetector`), iPhone Safari
   (confirm the manual-entry fallback message). If an iOS fallback decoder is added later, test it on a
   physical iPhone.
2. **Automated axe/Lighthouse accessibility scan** before final launch.

Carry into Phase 1P and/or Phase 1R.
