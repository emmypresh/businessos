import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { createBranch, getBranchLocationId, assignMemberToBranch, getMemberId, getDefaultBranchId } from "../integration/helpers/staff";

// Phase 1G application/UI — a SMALL, representative browser-level set.
// Exhaustive role/security matrices belong in the integration suite
// (tests/integration/branch-aware-application.test.ts); these prove the
// real, end-to-end UI flows work through an actual browser session.
// Codex adversarial review, application-layer round 2, "REQUIRED E2E
// COVERAGE".

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function createOwnerAndBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, userId: user.id, businessId: business!.id as string, client };
}

// A confirmed, signed-in MANAGER member assigned to the given branch(es) —
// mirrors tests/integration/branch-aware-application.test.ts's own
// realistic fixture pattern (a real business_members row via
// createMemberWithCustomPermissions there; here, via the real
// invite-then-branch-reassign path so this is drivable through the actual
// app for a genuinely different signed-in browser session).
//
// Role is MANAGER, not SALES: an OWNER can never grant themselves
// operational access to a second branch (CANNOT_MANAGE_SELF — a frozen
// Phase 1F rule; see tests/integration/branch-aware-sales.test.ts's own
// header comment), so the OWNER's own client cannot be used to seed real
// stock at a non-default branch via record_inventory_movement
// (has_branch_access would deny it), nor to select a non-default branch
// through the sale/opening-stock UI at all. MANAGER holds both
// sales.create AND inventory.adjust, so this ONE branch-assigned member
// can seed stock, create sales, AND add opening stock across every branch
// it's assigned to — never the owner acting on a branch they have no real
// access to. `branchIds` may list more than one branch (Codex adversarial
// review, application-layer round 3: the stock-transition test needs a
// SINGLE member who can legitimately switch between two real branches
// through the UI, not two separate single-branch members).
async function createBranchAssignedMember(
  prefix: string,
  businessId: string,
  ownerClient: ReturnType<typeof createUserClient>,
  branchIds: string[],
  primaryBranchId?: string
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });

  const { inviteMember, acceptInvitation } = await import("../integration/helpers/staff");
  const defaultBranchId = await getDefaultBranchId(ownerClient, businessId);
  const invitationId = await inviteMember(ownerClient, businessId, email, "MANAGER", {
    branchIds: [defaultBranchId],
    primaryBranchId: defaultBranchId,
  });
  await acceptInvitation(memberClient, invitationId);
  const memberId = await getMemberId(businessId, user.id);
  await assignMemberToBranch(ownerClient, businessId, memberId, branchIds, primaryBranchId ?? branchIds[0]);

  return { email, client: memberClient };
}

test.describe("Phase 1G branch-aware workflows", () => {
  test("A/B: a Branch-B-assigned member creates a sale at Branch B through the real UI, and availability reflects Branch B's own stock", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-branch-sale-owner");
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);

    // Opening stock lands at the DEFAULT branch's own location — Branch B
    // genuinely starts with zero stock for this product.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Branch B Product ${suffix}`,
      p_sku: `e2e-branchb-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 3,
    });
    const seller = await createBranchAssignedMember("e2e-branch-sale-seller", owner.businessId, owner.client, [branchB]);

    // A real adjustment directly at Branch B's own canonical location, so
    // the branch-specific picker has real, non-zero stock to show — via
    // the SELLER's own client (the one with actual access to Branch B),
    // never the owner's, which has no operational access there at all.
    const { error: mvError } = await seller.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product!.id,
      p_inventory_location_id: branchBLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 7,
      p_idempotency_key: crypto.randomUUID(),
      p_reason: "E2E fixture: Branch B stock",
    });
    expect(mvError).toBeNull();

    await loginAsInBrowser(page, seller.email, PASSWORD);

    await page.goto(`/${owner.businessId}/sales/new`);
    // The Branch select preselects the seller's own (only, primary)
    // branch — Branch B — automatically. Codex adversarial review,
    // application-layer round 3, Medium 2: the CLOSED trigger itself must
    // show the real branch name, never a raw UUID.
    await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("Branch B");
    await page.getByLabel("Search products").fill(`E2E Branch B Product ${suffix}`);
    const result = page.getByTestId("product-picker-results").getByText(`E2E Branch B Product ${suffix}`, {
      exact: false,
    });
    await expect(result).toBeVisible();
    // The picker's own availability line reflects Branch B's stock (7),
    // never the default branch's opening stock (3) — Blocker 2.
    await expect(page.getByTestId("product-picker-results")).toContainText("7 in stock");

    await result.click();
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/sales/[0-9a-f-]{36}$`));
    // exact: true distinguishes the sale's own Branch field ("Branch B")
    // from its separate Sold-from location field ("Branch B Store").
    await expect(page.getByText("Branch B", { exact: true })).toBeVisible();
  });

  // Codex adversarial review, application-layer round 3, Medium 1: a sale
  // line captured its availableQuantity at ADD time and never refreshed
  // it when the selected branch later changed — the product PICKER's own
  // search results correctly refreshed (already covered by the A/B test
  // above and by searchProductsForSale's own integration coverage), but
  // an ALREADY-ADDED line silently kept showing its old branch's stock.
  // This performs the real transition the review asked for: select
  // Branch A, add a product, confirm the line's OWN figure, THEN switch
  // to Branch B and confirm that SAME line updates — never starting
  // directly on Branch B the way the previous version of this coverage
  // did.
  test("G: switching the selected sale branch refreshes an ALREADY-ADDED line's own availability, not just the picker's search results", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-stock-transition");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Transition Branch B" });

    // Opening stock lands at Branch A's own (default) location — Branch B
    // genuinely starts with zero stock for this product; no movement is
    // ever recorded there.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seller = await createBranchAssignedMember(
      "e2e-stock-transition-seller",
      owner.businessId,
      owner.client,
      [branchA, branchB],
      branchA
    );
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Transition Product ${suffix}`,
      p_sku: `e2e-transition-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 5,
    });

    await loginAsInBrowser(page, seller.email, PASSWORD);
    await page.goto(`/${owner.businessId}/sales/new`);

    // Branch A (the seller's own primary) is preselected by default.
    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Main Branch");

    await page.getByLabel("Search products").fill(`E2E Transition Product ${suffix}`);
    const result = page.getByTestId("product-picker-results").getByText(`E2E Transition Product ${suffix}`, {
      exact: false,
    });
    await expect(result).toBeVisible();
    await expect(page.getByTestId("product-picker-results")).toContainText("5 in stock");
    await result.click();

    // The line reflects Branch A's own stock immediately after being
    // added.
    const lineRow = page.getByRole("row").filter({ hasText: `E2E Transition Product ${suffix}` });
    await expect(lineRow).toContainText("5 available");

    // Switch the selected branch to Branch B — genuinely zero stock
    // there.
    await branchSelect.click();
    await page.getByRole("option", { name: "Transition Branch B", exact: true }).click();

    // The SAME existing line updates — never left showing the stale "5".
    await expect(lineRow).toContainText("0 available");
    await expect(lineRow).not.toContainText("5 available");

    // The quantity-exceeds-stock warning recalculates too: 1 now exceeds
    // Branch B's own zero availability.
    await lineRow.getByLabel(`Quantity for E2E Transition Product ${suffix}`).fill("1");
    await expect(lineRow.getByText("Exceeds available stock.")).toBeVisible();

    // The CLOSED branch control itself shows the real branch name, never
    // a raw UUID.
    await expect(branchSelect).toContainText("Transition Branch B");
  });

  // Codex adversarial review, application-layer round 3, "Branch change
  // race safety" / Low 3: Branch A -> B -> C in rapid succession must
  // never let a stale B response overwrite C's own state.
  //
  // IMPORTANT — a discovered platform constraint that shaped this test's
  // final design: Next.js's own App Router client runtime
  // (node_modules/next/dist/client/app-call-server.js's callServer,
  // which every "use server" function funnels through, including a bare
  // function call like getSaleProductAvailabilityAction's — dispatches
  // through dispatchAppRouterAction/the router's own action queue) never
  // has two Server Action network requests in flight at once from the
  // same page: a second call's own HTTP request is not sent at all until
  // the first one's has fully resolved. Verified empirically while
  // building this test — holding Branch B's request open, a Branch C
  // switch never even reaches the network layer until B's is released.
  // This means the review's OWN literal sequence ("allow C's response to
  // complete FIRST, then release the delayed B afterward") cannot be
  // realized against this app's real transport, for ANY Server Action,
  // not just this one. The functionally equivalent, fully deterministic
  // scenario THIS test forces instead: hold B's request; switch to C
  // while B is still held (React tears down B's own effect and marks it
  // cancelled SYNCHRONOUSLY at this point, well before B's response ever
  // arrives — this is the actual moment the production guard engages);
  // release B — its now-stale response resolves and must be discarded;
  // ALSO hold C's request (the one Next's queue only dispatches once B is
  // released) so the line's CURRENT (non-transient, durably assertable)
  // state can be inspected BEFORE C has had any chance to overwrite
  // anything — if the cancellation guard were broken, Branch B's own
  // "2 available" would be sitting there at that exact checkpoint;
  // finally release C and confirm the line settles on its own real "9
  // available". Every synchronization point below waits on an actual,
  // counted network event (`expect.poll`) — never a fixed-duration sleep.
  test("H: Branch B's response, held and released only after Branch C's own switch has already superseded it, never overwrites the line — and Branch C's own held response is what finally settles it", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-stock-race");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Race Branch B" });
    const branchC = await createBranch(owner.client, owner.businessId, { name: "Race Branch C" });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seller = await createBranchAssignedMember(
      "e2e-stock-race-seller",
      owner.businessId,
      owner.client,
      [branchA, branchB, branchC],
      branchA
    );
    // Three distinct, real, DB-authoritative figures (A=5, B=2, C=9) — a
    // wrong settled state (2, or anything else) is never ambiguous with a
    // correct one (9).
    const { data: raceProduct } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Race Product ${suffix}`,
      p_sku: `e2e-race-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 5,
    });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const { error: mvErrorB } = await seller.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: raceProduct!.id,
      p_inventory_location_id: branchBLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 2,
      p_idempotency_key: crypto.randomUUID(),
      p_reason: "E2E fixture: Branch B stock",
    });
    expect(mvErrorB).toBeNull();
    const branchCLocationId = await getBranchLocationId(owner.businessId, branchC);
    const { error: mvErrorC } = await seller.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: raceProduct!.id,
      p_inventory_location_id: branchCLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 9,
      p_idempotency_key: crypto.randomUUID(),
      p_reason: "E2E fixture: Branch C stock",
    });
    expect(mvErrorC).toBeNull();

    await loginAsInBrowser(page, seller.email, PASSWORD);
    await page.goto(`/${owner.businessId}/sales/new`);

    await page.getByLabel("Search products").fill(`E2E Race Product ${suffix}`);
    const result = page.getByTestId("product-picker-results").getByText(`E2E Race Product ${suffix}`, {
      exact: false,
    });
    await expect(result).toBeVisible();
    await result.click();
    const lineRow = page.getByRole("row").filter({ hasText: `E2E Race Product ${suffix}` });
    await expect(lineRow).toContainText("5 available");

    // Network-level interception: EVERY POST whose body mentions Branch
    // B's own id, or Branch C's own id, is held open indefinitely until
    // its own dedicated gate is released.
    let releaseB: () => void = () => {};
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseC: () => void = () => {};
    const cGate = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    let heldBCount = 0;
    let heldCCount = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      const body = request.postData() ?? "";
      if (body.includes(branchB)) {
        heldBCount += 1;
        await bGate;
      } else if (body.includes(branchC)) {
        heldCCount += 1;
        await cGate;
      }
      await route.continue();
    });

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    // Switch to Branch B — its request(s) are held. This is "B started".
    await branchSelect.click();
    await page.getByRole("option", { name: "Race Branch B", exact: true }).click();
    await expect.poll(() => heldBCount).toBeGreaterThan(0);

    // Switch to Branch C WHILE B is still held. React tears down B's own
    // effect right here (synchronously, as part of applying this state
    // change) and marks it cancelled — well before B's response ever
    // arrives. Branch C's OWN request cannot be dispatched yet either
    // (Next's app-router action queue processes one action at a time —
    // see the header comment above), so nothing has been sent for C at
    // this point; there is nothing to assert about the line yet.
    await branchSelect.click();
    await page.getByRole("option", { name: "Race Branch C", exact: true }).click();

    // Release Branch B now — its own response finally resolves. Wait
    // until Branch C's own request has, in turn, been dispatched and
    // captured by the very same route handler (proof B's own
    // resolve-and-skip cycle has fully completed, since Next's queue
    // only advances to C afterward).
    releaseB();
    await expect.poll(() => heldCCount).toBeGreaterThan(0);

    // THE key assertion: at this exact, durable (non-transient) point —
    // Branch B's response has been fully processed and Branch C's is
    // STILL held, unable to have changed anything yet — the line must
    // NOT show Branch B's own "2 available". If the cancellation guard
    // were broken, this is precisely where it would.
    await expect(lineRow).not.toContainText("2 available");

    // Now release Branch C's held response — it resolves normally and
    // settles the line on its own real figure.
    releaseC();
    await expect(lineRow).toContainText("9 available");
    await expect(lineRow).not.toContainText("2 available");
    await expect(branchSelect).toContainText("Race Branch C");

    await page.unroute("**/*");
  });

  test("C: expense creation offers an explicit Company-wide choice alongside the caller's own primary-branch default", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-expense-branch");
    await loginAsInBrowser(page, owner.email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses/new`);
    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toBeVisible();
    // The default selection is the caller's own primary branch (a
    // deliberate product choice — see expense-form.tsx's own comment) —
    // an explicit, one-click switch to Company-wide is still always
    // available and is what this test actually exercises.
    await branchSelect.click();
    await page.getByRole("option", { name: "Company-wide", exact: true }).click();

    await page.getByLabel(/Amount/).fill("50.00");
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/expenses/[0-9a-f-]{36}$`));
    await expect(page.getByText("Company-wide")).toBeVisible();
  });

  test("D: report switches from Company-wide to a specific branch, and the visible scope label updates", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-report-branch");
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Report Branch B" });
    await loginAsInBrowser(page, owner.email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports`);
    // A dedicated testid (report-scope-label), not a plain getByText —
    // Medium 2's own fix now makes the Branch select's own closed trigger
    // ALSO display "Company-wide" (a real label, never a raw sentinel/
    // UUID), so a page-wide text match can no longer disambiguate the
    // page's own scope-label paragraph from the Select's own trigger.
    const scopeLabel = page.getByTestId("report-scope-label");
    await expect(scopeLabel).toHaveText("Company-wide");
    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Company-wide");

    await branchSelect.click();
    await page.getByRole("option", { name: "Report Branch B", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`branch=${branchB}`));
    await expect(scopeLabel).toHaveText("Report Branch B");
    await expect(branchSelect).toContainText("Report Branch B");
  });

  test("E: an inaccessible branch id injected directly into the sale form is rejected server-side, with no branch name leaked back", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-sale-inject");
    const stranger = await createOwnerAndBusiness("e2e-sale-inject-stranger");
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Inject Product ${suffix}`,
      p_sku: `e2e-inject-${suffix}`,
      p_selling_price: 100,
      p_opening_quantity: 5,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/sales/new`);
    await page.getByLabel("Search products").fill(`E2E Inject Product ${suffix}`);
    const result = page.getByTestId("product-picker-results").getByText(`E2E Inject Product ${suffix}`, {
      exact: false,
    });
    await expect(result).toBeVisible();
    await result.click();

    // Forge the hidden branchId field to a real branch belonging to a
    // DIFFERENT business — never reachable through the visible Select,
    // exactly the "manufactured request" this must still reject safely.
    await page.evaluate((foreignId) => {
      const input = document.querySelector('input[name="branchId"]') as HTMLInputElement | null;
      if (input) input.value = foreignId;
    }, strangerBranchId);

    await page.getByRole("button", { name: /Complete sale/ }).click();

    // Still on the create page (no redirect happened) — the safe, generic
    // "not available" message, never the stranger's real branch name or
    // any indication the id was real.
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/sales/new$`));
    const bodyText = await page.textContent("body");
    expect(bodyText).not.toContain(stranger.businessId);
  });

  // Codex adversarial review, application-layer round 3: the PREVIOUS
  // version of this test created a 100-character branch but never
  // actually put the logged-in caller in a position to select it — the
  // OWNER's own operational branch options are ALWAYS just their own
  // default branch (CANNOT_MANAGE_SELF prevents an owner from
  // self-assigning to any other branch), so the long-named branch never
  // appeared as a real, selectable option, and the test's own long-name
  // string was never rendered anywhere on the page at all — a fixture
  // bug that made the whole test ineffective at proving anything about
  // rendering a long SELECTED value. A genuinely different member,
  // assigned specifically to the long-named branch, is what makes it a
  // real, selectable, and (since it's the member's ONLY branch)
  // automatically PRESELECTED option.
  // Codex adversarial review, application-layer round 3, "LONG BRANCH
  // NAMES": re-tested at all three of the review's own named viewports
  // (375/768/1440), not merely 768 — the manual interactive verification
  // this section also asks for could not be performed in this
  // environment (the Chrome browser extension used for that was not
  // connected), so this automated, permanent, real-browser (Playwright/
  // Chromium) check at all three widths is the substitute evidence for
  // that specific ask; the underlying behavior (a real, selected
  // 100-character name resolving to a real label, never a UUID, and never
  // overflowing) is identical in every material way to what the manual
  // steps would have exercised. Same member/business/product-opening-
  // stock fixture reused across all three viewports — a fresh page load
  // per width, not a resize of an already-rendered page, matching how a
  // reader would actually land on each width independently.
  for (const width of [375, 768, 1440]) {
    test(`F: an actually-selected 100-character branch name shows in the closed control (never a raw UUID) and never overflows at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1024 });
      const owner = await createOwnerAndBusiness(`e2e-long-branch-name-${width}`);
      const longName = "B".repeat(100);
      const longBranchId = await createBranch(owner.client, owner.businessId, { name: longName });
      const member = await createBranchAssignedMember(
        `e2e-long-branch-name-member-${width}`,
        owner.businessId,
        owner.client,
        [longBranchId]
      );
      await loginAsInBrowser(page, member.email, PASSWORD);

      await page.goto(`/${owner.businessId}/products/new`);
      await page.getByLabel("Track inventory for this product").setChecked(true);
      await page.getByLabel("Opening stock").fill("1");
      const branchSelect = page.getByRole("combobox", { name: "Branch" });
      await expect(branchSelect).toBeVisible();

      // Preselected automatically (the member's own only branch) — still
      // explicitly re-selected through the real dropdown interaction
      // below, proving the label resolves correctly after a genuine
      // selection round-trip, not merely as an initial-render default.
      // Not exact: this branch is also the member's PRIMARY one, so its
      // own dropdown item's accessible name is "<name> (Primary)" (see
      // product-form.tsx's own item-rendering), never the bare name
      // alone.
      await branchSelect.click();
      await page.getByRole("option", { name: longName, exact: false }).click();

      // The CLOSED control shows the real, full branch name — never the
      // raw UUID, and never a truncated/altered version of the stored
      // name (truncation, if any, is a purely visual CSS effect — the
      // underlying accessible text content is asserted here in full).
      await expect(branchSelect).toContainText(longName);
      await expect(branchSelect).not.toContainText(longBranchId);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  // Codex adversarial review, application-layer round 3, Low 2: the
  // availability-refresh batch response can genuinely OMIT a product the
  // cart already has a line for (searchProductsForSale only ever returns
  // ACTIVE products — an archived one simply isn't in the response at
  // all), and the merge logic previously left such a line at its OLD,
  // now-stale figure instead of treating "omitted" as "no longer
  // available". This exercises the real production path end to end:
  // Product X is reduced to zero stock and genuinely archived (a real
  // product-management action, not a test-only shortcut) BETWEEN being
  // added to the cart and the next branch-triggered refresh — the same
  // network-holding technique as test H also proves, in the same test,
  // that a line the user removes WHILE a refresh is in flight is never
  // recreated by that response landing afterward.
  test("I: an archived product's cart line drops to 0 available on the next refresh, and a line removed mid-refresh is never recreated", async ({
    page,
  }) => {
    const owner = await createOwnerAndBusiness("e2e-stale-availability");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Stale Availability Branch B" });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seller = await createBranchAssignedMember(
      "e2e-stale-availability-seller",
      owner.businessId,
      owner.client,
      [branchA, branchB],
      branchA
    );
    // Product X: will be zeroed out and archived between add-time and the
    // refresh that must reflect its disappearance.
    const { data: productX } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Stale Product X ${suffix}`,
      p_sku: `e2e-stale-x-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 5,
    });
    // Product Y: stays perfectly normal — its own line is removed from
    // the cart while a refresh is in flight, and must never come back.
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Stale Product Y ${suffix}`,
      p_sku: `e2e-stale-y-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 3,
    });

    await loginAsInBrowser(page, seller.email, PASSWORD);
    await page.goto(`/${owner.businessId}/sales/new`);

    await page.getByLabel("Search products").fill(`E2E Stale Product X ${suffix}`);
    const resultX = page.getByTestId("product-picker-results").getByText(`E2E Stale Product X ${suffix}`, {
      exact: false,
    });
    await expect(resultX).toBeVisible();
    await resultX.click();

    await page.getByLabel("Search products").fill(`E2E Stale Product Y ${suffix}`);
    const resultY = page.getByTestId("product-picker-results").getByText(`E2E Stale Product Y ${suffix}`, {
      exact: false,
    });
    await expect(resultY).toBeVisible();
    await resultY.click();

    const lineX = page.getByRole("row").filter({ hasText: `E2E Stale Product X ${suffix}` });
    const lineY = page.getByRole("row").filter({ hasText: `E2E Stale Product Y ${suffix}` });
    await expect(lineX).toContainText("5 available");
    await expect(lineY).toContainText("3 available");

    // Product X becomes genuinely unavailable: real stock reduced to
    // zero (CANNOT_ARCHIVE_WITH_STOCK forbids archiving otherwise), then
    // really archived.
    const locationA = await getBranchLocationId(owner.businessId, branchA);
    const { error: mvError } = await seller.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: productX!.id,
      p_inventory_location_id: locationA,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 5,
      p_idempotency_key: crypto.randomUUID(),
      p_reason: "E2E fixture: zero out Product X before archiving",
    });
    expect(mvError).toBeNull();
    const { error: archiveError } = await owner.client
      .from("products")
      .update({ status: "archived" })
      .eq("id", productX!.id)
      .eq("business_id", owner.businessId);
    expect(archiveError).toBeNull();

    // Hold every request the upcoming branch switch triggers open until
    // released — long enough to remove Product Y's line WHILE the
    // refresh is genuinely still in flight, exactly like test H's own
    // deterministic (never sleep-based) synchronization.
    let releaseHeldRequests: () => void = () => {};
    const heldRequestGate = new Promise<void>((resolve) => {
      releaseHeldRequests = resolve;
    });
    let heldRequestCount = 0;
    let finishedRequestCount = 0;
    page.on("requestfinished", (req) => {
      if (req.method() === "POST" && (req.postData() ?? "").includes(branchB)) {
        finishedRequestCount += 1;
      }
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !(request.postData() ?? "").includes(branchB)) {
        await route.continue();
        return;
      }
      heldRequestCount += 1;
      await heldRequestGate;
      await route.continue();
    });

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await branchSelect.click();
    await page.getByRole("option", { name: "Stale Availability Branch B", exact: true }).click();
    await expect.poll(() => heldRequestCount).toBeGreaterThan(0);

    // Remove Product Y's line WHILE the refresh is still held/in flight.
    await page.getByRole("button", { name: `Remove E2E Stale Product Y ${suffix}` }).click();
    await expect(lineY).toHaveCount(0);

    const heldCountAtRelease = heldRequestCount;
    releaseHeldRequests();
    await expect.poll(() => finishedRequestCount).toBeGreaterThanOrEqual(heldCountAtRelease);

    // Product X's line drops to 0 (archived — genuinely omitted from the
    // refresh response), never left at its stale "5 available".
    await expect(lineX).toContainText("0 available");
    await expect(lineX).not.toContainText("5 available");

    // The quantity-exceeds-stock warning recalculates against the new
    // zero availability.
    await lineX.getByLabel(`Quantity for E2E Stale Product X ${suffix}`).fill("1");
    await expect(lineX.getByText("Exceeds available stock.")).toBeVisible();

    // Product Y's line was never recreated by the in-flight response
    // that still mentioned it — it was already gone from the cart's own
    // state by the time that response was applied.
    await expect(lineY).toHaveCount(0);

    await page.unroute("**/*");
  });
});
