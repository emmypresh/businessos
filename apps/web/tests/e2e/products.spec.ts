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

async function createOwnerBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id };
}

test.describe("products", () => {
  test("create a product without opening stock, then view it", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-prod-basic");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Basic Product");
    await page.getByLabel("SKU", { exact: false }).fill(`basic-${Date.now()}`);
    await page.getByRole("button", { name: "Create product" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { name: "Basic Product" })).toBeVisible();
  });

  test("create a product with opening stock, and the stock summary reflects it", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-prod-opening");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Opening Stock Product");
    await page.getByLabel("SKU", { exact: false }).fill(`opening-${Date.now()}`);
    await page.getByLabel("Opening stock").fill("15");
    await page.getByRole("button", { name: "Create product" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
    // Scoped to the stock summary card specifically — "15" also appears
    // in the recent-history table's balance-after column on this same
    // page, so a bare page-wide text match is ambiguous.
    await expect(
      page.getByTestId("stock-summary-card").getByText("15", { exact: true })
    ).toBeVisible();
  });

  test("a duplicate/double-click submission does not create a duplicate product", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-prod-dup");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/products/new`);
    const sku = `dup-${Date.now()}`;
    await page.getByLabel("Name").fill("Duplicate Click Product");
    await page.getByLabel("SKU", { exact: false }).fill(sku);

    // The SubmitButton correctly disables itself while a submission is
    // pending, so a real double-*click* can't reach the server twice —
    // that disabling IS the first line of defense working as designed.
    // To exercise the idempotency-key backstop itself (the thing that
    // must hold even if that UI-level guard is ever bypassed — e.g. two
    // near-simultaneous requests from a flaky connection's retry), this
    // fires two real, concurrent submissions of the SAME <form> — and
    // therefore the same hidden creationKey field — directly, bypassing
    // the button's disabled state entirely.
    await page.getByTestId("product-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });

    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/products?search=${sku}`);
    const rows = page.getByRole("row").filter({ hasText: sku });
    await expect(rows).toHaveCount(1);
  });

  test("edit a product's mutable fields", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-prod-edit");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Original Name");
    await page.getByLabel("SKU", { exact: false }).fill(`edit-${Date.now()}`);
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Renamed Product");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { name: "Renamed Product" })).toBeVisible();
  });

  test("archiving a zero-stock product succeeds; archiving a stocked product is rejected", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-prod-archive");
    await loginAsInBrowser(page, email, PASSWORD);

    // Zero-stock: no opening quantity given.
    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Zero Stock Product");
    await page.getByLabel("SKU", { exact: false }).fill(`archive-zero-${Date.now()}`);
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));

    await page.getByRole("button", { name: "Archive product" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText("archived", { exact: true })).toBeVisible();

    // Stocked: opening quantity > 0.
    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Stocked Product");
    await page.getByLabel("SKU", { exact: false }).fill(`archive-stocked-${Date.now()}`);
    await page.getByLabel("Opening stock").fill("5");
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));

    await page.getByRole("button", { name: "Archive product" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText(/still has stock recorded/)).toBeVisible();
  });
});
