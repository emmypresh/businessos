import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

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
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id as string, client };
}

test.describe("branches", () => {
  test("OWNER views the branch list, sees the auto-created default branch", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-view");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches`);
    await expect(page.getByRole("heading", { name: "Branches" })).toBeVisible();
    await expect(page.getByText("Main Branch")).toBeVisible();
    await expect(page.getByText("Default")).toBeVisible();
  });

  test("creates a branch and it appears in the list", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-create");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches/new`);
    await page.getByLabel("Branch name").fill("Lekki Branch");
    await page.getByLabel("Code (optional)").fill("LEK");
    await page.getByRole("button", { name: "Create branch" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/branches/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { name: "Lekki Branch" })).toBeVisible();

    await page.goto(`/${businessId}/branches`);
    await expect(page.getByText("Lekki Branch")).toBeVisible();
  });

  test("edits a branch — the change is reflected on the detail page", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-edit");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches/new`);
    await page.getByLabel("Branch name").fill("Original Name");
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/branches/[0-9a-f-]{36}$`));

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Branch name").fill("Renamed Branch");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { name: "Renamed Branch" })).toBeVisible();
  });

  // Codex adversarial review, application-layer round 2, Low 4 / Low
  // 10.J: city/state/addressLine1/addressLine2 previously had no
  // aria-invalid, no aria-describedby, and no visible error text at all
  // — an overlong value was silently invisible. Proves the fix for city
  // specifically (BRANCH_ADDRESS_MAX_LENGTH is 200 characters).
  test("an overlong city shows a visible, field-scoped validation error, not a silent failure", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-field-error");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches/new`);
    await page.getByLabel("Branch name").fill("Overlong City Branch");
    await page.getByLabel("City").fill("L".repeat(201));
    await page.getByRole("button", { name: "Create branch" }).click();

    await expect(page.getByRole("alert").filter({ hasText: /city/i })).toBeVisible();
    // Never actually created.
    await expect(page).toHaveURL(new RegExp(`/${businessId}/branches/new$`));
  });

  test("sets a new default branch", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-default");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches/new`);
    await page.getByLabel("Branch name").fill("Candidate Default");
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/branches/[0-9a-f-]{36}$`));

    await page.getByRole("button", { name: "Set as default" }).click();
    await page.getByRole("button", { name: "Set as default", exact: true }).click();

    // The trigger only renders for a non-default ACTIVE branch — once
    // this branch IS the default, it disappears (a more precise signal
    // than the "Default" badge text, which also appears in dialog titles
    // and the button label itself).
    await expect(page.getByRole("button", { name: "Set as default" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  });

  test("deactivating the default branch is blocked with actionable guidance — no raw database error is ever shown", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-deactivate-default");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches`);
    await page.getByRole("link", { name: "Main Branch" }).click();
    await expect(page.getByText(/set another active branch as default before deactivating/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

    // No raw Postgres error text anywhere on the page.
    await expect(page.getByText(/relation|constraint|sqlstate|private\./i)).toHaveCount(0);
  });

  test("deactivates a non-default branch, then reactivates it", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-deactivate-reactivate");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches/new`);
    await page.getByLabel("Branch name").fill("Cycle Branch");
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/branches/[0-9a-f-]{36}$`));

    await page.getByRole("button", { name: "Deactivate" }).click();
    await page.getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(page.getByText("Inactive")).toBeVisible();

    await page.getByRole("button", { name: "Reactivate" }).click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
  });

  test("branches.view alone cannot see the New branch action or manage buttons", async ({ page }) => {
    const { businessId, client } = await createOwnerAndBusiness("e2e-branch-perm-owner");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const viewEmail = `e2e-branch-perm-view-${suffix}@example.test`;
    // VIEWER is seeded with branches.view but not branches.manage per the
    // approved permission matrix — invited through the app's own real
    // invitation flow rather than a direct-SQL shortcut.
    const { data: defaultBranch } = await client.from("business_branches").select("id").eq("business_id", businessId).eq("is_default", true).single();
    const { data: invId } = await client.rpc("create_business_invitation", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_email: viewEmail,
      p_role: "VIEWER",
      p_branch_ids: [defaultBranch!.id],
      p_primary_branch_id: defaultBranch!.id,
    });
    await createConfirmedTestUser(viewEmail, PASSWORD);
    const viewerClient = createUserClient();
    await viewerClient.auth.signInWithPassword({ email: viewEmail, password: PASSWORD });
    await viewerClient.rpc("accept_business_invitation", { p_invitation_id: invId as string });

    await loginAsInBrowser(page, viewEmail, PASSWORD);
    await page.goto(`/${businessId}/branches`);
    await expect(page.getByRole("link", { name: "New branch" })).toHaveCount(0);
    await page.getByRole("link", { name: "Main Branch" }).click();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  });

  // Codex adversarial review, application-layer round 3, Low 3: the
  // PREVIOUS version of this test claimed "list and detail" in its title
  // but only ever visited the list — the branch detail route's own mobile
  // responsiveness was never actually exercised. Now genuinely visits
  // both, matching staff.spec.ts's own "mobile: staff list and detail"
  // test exactly.
  test("mobile: branches list and detail are usable without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { email, businessId, client } = await createOwnerAndBusiness("e2e-branch-mobile");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/branches`);
    await expect(page.getByRole("heading", { name: "Branches" })).toBeVisible();
    let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // The sidebar collapses into a drawer trigger on mobile.
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("link", { name: "Staff" })).toBeVisible();

    const { data: defaultBranch } = await client
      .from("business_branches")
      .select("id")
      .eq("business_id", businessId)
      .eq("is_default", true)
      .single();
    await page.goto(`/${businessId}/branches/${defaultBranch!.id}`);
    await expect(page.getByRole("heading", { name: "Main Branch" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  // Codex adversarial review, application-layer round 3, Low 1: the
  // existing malformed-id coverage (lib/branches/dal.ts's own tests)
  // proves getBranch never reaches Postgres and calls Next's notFound()
  // — but that alone doesn't prove the DOCUMENT response is actually a
  // 404. This is real route-level coverage: it reads the Response
  // page.goto() itself returns (never just the rendered page text),
  // which is the only way to see the actual HTTP status a browser or
  // crawler would observe.
  test("a malformed branch id in the URL is a genuine HTTP 404, not a soft 200", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-branch-malformed");
    await loginAsInBrowser(page, email, PASSWORD);

    const response = await page.goto(`/${businessId}/branches/not-a-uuid`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

    // The edit route reaches the identical getBranch guard and must be
    // just as real a 404, not merely the detail route.
    const editResponse = await page.goto(`/${businessId}/branches/not-a-uuid/edit`);
    expect(editResponse?.status()).toBe(404);
  });
});
