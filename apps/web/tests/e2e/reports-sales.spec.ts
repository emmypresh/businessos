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
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id as string, client };
}

test.describe("Sales & Revenue detailed report (Phase 1N-C2)", () => {
  test("requires reports.view — denied caller sees Not found, not the report", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-sales-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-sales-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["sales.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/sales`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a reports.view-only caller can load the report", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-sales-reports-only");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-sales-reports-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["reports.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/sales`);
    await expect(page.getByRole("heading", { name: "Sales & Revenue", level: 1 })).toBeVisible();
    await expect(page.getByTestId("kpi-sales-revenue")).toBeVisible();
  });

  test("the workspace Sales & Revenue link is active and preserves the active range", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-link-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=last_7_days`);
    const link = page.getByRole("link", { name: /Sales & Revenue/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/reports/sales\\?preset=last_7_days`));
    await expect(page.getByRole("heading", { name: "Sales & Revenue", level: 1 })).toBeVisible();
  });

  test("preserves a custom dateFrom/dateTo range when navigating from the workspace", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-custom-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=custom&dateFrom=2026-08-01&dateTo=2026-08-10`);
    await page.getByRole("link", { name: /Sales & Revenue/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${businessId}/reports/sales\\?preset=custom&dateFrom=2026-08-01&dateTo=2026-08-10`)
    );
  });

  test("Back to Reports preserves the current range", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-back-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/sales?preset=last_7_days`);
    await page.getByRole("link", { name: "Back to Reports" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/reports\\?preset=last_7_days`));
    await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  });

  test("Customers and Inventory are now real links (Phase 1N-C3); Branches stays a non-interactive Coming soon category", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-coming-soon");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports`);
    const categories = page.getByLabel("More reports");
    for (const name of ["Customers", "Inventory"]) {
      await expect(categories.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }
    await expect(categories.getByText("Branches", { exact: true })).toBeVisible();
    await expect(categories.getByRole("link", { name: "Branches" })).toHaveCount(0);
    await expect(categories.getByText("Coming soon")).toHaveCount(1);
  });

  test("zero activity in the selected period shows a truthful zero state, not an error", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-zero");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/sales?preset=custom&dateFrom=1999-01-01&dateTo=1999-01-02`);
    await expect(page.getByText("No completed sales were recorded in this period.").first()).toBeVisible();
    await expect(page.getByTestId("kpi-sales-revenue")).toContainText("0.00");
    await expect(page.getByTestId("kpi-completed-sales")).toContainText("0");
  });

  test("an invalid custom range shows a safe inline error, not a crash", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-invalid-range");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/sales?preset=custom&dateFrom=2026-08-27&dateTo=2026-08-01`);
    await expect(page.getByText(/start date must be on or before/i)).toBeVisible();
  });

  test("a pending custom range (no dates yet) prompts for a range, with no crash", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-pending-range");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/sales?preset=custom`);
    await expect(page.getByText("Choose a start and end date to see the report.")).toBeVisible();
  });

  test("revenue, completed sales, and AOV reflect real completed-sale activity, with no profit language", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-sales-kpis");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Sales Report Product ${suffix}`,
      p_sku: `sales-report-${suffix}`,
      p_selling_price: 4000,
      p_opening_quantity: 5,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 4000,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/sales?preset=last_30_days`);

    await expect(page.getByTestId("kpi-sales-revenue")).toContainText("₦4,000.00");
    await expect(page.getByTestId("kpi-completed-sales")).toContainText("1");
    await expect(page.getByTestId("kpi-average-order-value")).toContainText("₦4,000.00");

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toMatch(/\bprofit\b|\bincome\b|\bearnings\b|\bnet sales\b/);
  });

  test("the daily breakdown table has semantic headers and chronological rows", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-sales-table");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/sales?preset=last_7_days`);
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Date" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Revenue" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Completed sales" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Average order value" })).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(8); // header + 7 daily rows
  });
});
