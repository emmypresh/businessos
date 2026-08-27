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

test.describe("financial overview", () => {
  test("the reports page loads with a default range and no profit/margin language", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-report-loads");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports`);
    await expect(page.getByRole("heading", { name: "Financial overview" })).toBeVisible();
    // "Gross sales"/"Cash collected"/etc. each appear twice on this page
    // (once as a KPI card title, once as a chart comparison-bar label) —
    // scoped to the KPI cards specifically via their stable testids.
    await expect(page.getByTestId("kpi-gross-sales")).toBeVisible();
    await expect(page.getByTestId("kpi-cash-collected")).toBeVisible();
    await expect(page.getByTestId("kpi-outstanding-sales")).toBeVisible();
    await expect(page.getByTestId("kpi-net-cash-flow")).toBeVisible();
    await expect(page.getByText("Net cash flow = cash collected − expenses")).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toMatch(/\bprofit\b|\bmargin\b/);
  });

  test("gross sales, cash collected, expenses, and net cash flow reflect real activity", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-report-kpis");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Report KPI Product ${suffix}`,
      p_sku: `report-kpi-${suffix}`,
      p_selling_price: 5000,
      p_opening_quantity: 5,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 5000,
    });
    const { data: category } = await owner.client
      .from("expense_categories")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("name", "Rent")
      .single();
    await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_category_id: category!.id,
      p_amount: 1200,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports?preset=last_30_days`);

    await expect(page.getByText("NGN 5,000.00").first()).toBeVisible();
    await expect(page.getByText("NGN 1,200.00").first()).toBeVisible();
    await expect(page.getByText("NGN 3,800.00").first()).toBeVisible(); // net cash flow = 5000 - 1200
  });

  test("a reports-only caller (no sales.view, no expenses.view) can still view the aggregate", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-report-only-permission");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-report-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["reports.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports`);
    await expect(page.getByRole("heading", { name: "Financial overview" })).toBeVisible();
    await expect(page.getByTestId("kpi-gross-sales")).toBeVisible();

    // Neither sales nor expenses list routes are reachable for this
    // caller — proving the report renders without needing raw access.
    await page.goto(`/${owner.businessId}/sales`);
    await expect(page.getByText("Not found")).toBeVisible();
    await page.goto(`/${owner.businessId}/expenses`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("expenses.view alone (no reports.view) is denied the reports route", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-report-denied-expenses-view");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-report-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["expenses.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a custom range with an inverted from/to shows a safe inline error, not a crash", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-report-invalid-range");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=custom&dateFrom=2026-08-27&dateTo=2026-08-01`);
    await expect(page.getByText(/start date must be on or before/i)).toBeVisible();
  });

  test("an empty custom range with no activity shows zeros, not an error", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-report-empty-range");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=custom&dateFrom=1999-01-01&dateTo=1999-01-02`);
    await expect(page.getByText("No sales or expense activity in this range.")).toBeVisible();
    await expect(page.getByText("NGN 0.00").first()).toBeVisible();
  });
});
