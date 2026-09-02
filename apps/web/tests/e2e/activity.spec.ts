import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions } from "../integration/helpers/inventory";

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

test.describe("Phase 1J activity feed", () => {
  test("A: an OWNER sees real, seeded activity from a real sale, and can open the detail sheet", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-basic");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Activity Product ${suffix}`,
      p_sku: `e2e-activity-${suffix}`,
      p_selling_price: 1500,
      p_opening_quantity: 10,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_items: [{ product_id: product!.id, quantity: 2 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/activity`);
    await expect(page.getByText("Sale created")).toBeVisible();

    await page.getByTestId("activity-row").first().click();
    const sheet = page.getByTestId("activity-detail-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Commerce")).toBeVisible();
  });

  test("B: category and search filters narrow the feed correctly", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-filters");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Activity Customer ${suffix}`,
    });
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Activity Product ${suffix}`,
      p_sku: `e2e-activity-filter-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/activity`);
    await expect(page.getByText("Sale created")).toBeVisible();
    await expect(page.getByText("Customer created")).toBeVisible();

    await page.getByLabel("Category").click();
    await page.getByRole("option", { name: "Customer" }).click();
    await expect(page.getByText("Customer created")).toBeVisible();
    await expect(page.getByText("Sale created")).toHaveCount(0);

    await page.getByLabel("Category").click();
    await page.getByRole("option", { name: "All categories" }).click();
    await page.getByPlaceholder("Search by action, resource, or person").fill(`E2E Activity Customer ${suffix}`);
    await expect(page.getByText("Customer created")).toBeVisible();
    await expect(page.getByText("Sale created")).toHaveCount(0);
  });

  test("C: a caller without audit.view is denied the Activity route, and the nav link is hidden", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const viewerRole = await createRoleWithPermissions(["sales.view"]);
    const viewerEmail = `e2e-activity-denied-${suffix}@example.test`;
    const viewerUser = await createConfirmedTestUser(viewerEmail, PASSWORD);
    await addMemberWithRole(owner.businessId, viewerUser.id, viewerRole);

    await loginAsInBrowser(page, viewerEmail, PASSWORD);
    await page.goto(`/${owner.businessId}`);
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: "Activity" })).toHaveCount(0);

    await page.goto(`/${owner.businessId}/activity`);
    await expect(page.getByText(/404|not found/i)).toBeVisible();
  });

  test("D: a custom audit.view-only role (no staff.view, no branches.view) gets a complete Activity experience, including branch filter names", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-custom-role");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await owner.client.rpc("create_business_branch", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Activity Branch ${suffix}`,
    });

    const auditRole = await createRoleWithPermissions(["audit.view"]);
    const auditEmail = `e2e-activity-custom-${suffix}@example.test`;
    const auditUser = await createConfirmedTestUser(auditEmail, PASSWORD);
    await addMemberWithRole(owner.businessId, auditUser.id, auditRole);

    await loginAsInBrowser(page, auditEmail, PASSWORD);
    await page.goto(`/${owner.businessId}/activity`);
    await expect(page.getByText("Branch created")).toBeVisible();

    await page.getByLabel("Branch").click();
    await expect(page.getByRole("option", { name: `E2E Activity Branch ${suffix}` })).toBeVisible();
  });

  test("E: the dashboard sidebar links to Activity under Organization", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-nav");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}`);
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: "Activity" })).toBeVisible();
  });

  for (const width of [375, 768, 1440]) {
    test(`F: the activity feed is usable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await createOwnerAndBusiness(`e2e-activity-width-${width}`);
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await owner.client.rpc("create_customer", {
        p_business_id: owner.businessId,
        p_creation_key: crypto.randomUUID(),
        p_name: `E2E Width Activity Customer With An Unusually Long Descriptive Name ${suffix}`,
      });

      await loginAsInBrowser(page, owner.email, PASSWORD);
      await page.goto(`/${owner.businessId}/activity`);
      await expect(page.getByText("Customer created")).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  test("G: the empty state is shown when no activity has been recorded, without implying data was lost", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-activity-empty");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/activity`);
    await expect(page.getByText("No activity has been recorded yet.")).toBeVisible();
  });
});
