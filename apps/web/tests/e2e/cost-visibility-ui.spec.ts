import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole } from "../integration/helpers/inventory";

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe("cost visibility in the UI", () => {
  let businessId: string;
  let productId: string;
  let ownerEmail: string;
  let salesEmail: string;

  test.beforeAll(async () => {
    const suffix = Date.now();
    ownerEmail = `cost-ui-owner-${suffix}@example.test`;
    salesEmail = `cost-ui-sales-${suffix}@example.test`;

    await createConfirmedTestUser(ownerEmail, PASSWORD);
    const ownerClient = createUserClient();
    await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
    const { data: business } = await ownerClient.rpc("create_business", {
      p_name: "Cost UI Business",
      p_slug: `cost-ui-${suffix}`,
    });
    businessId = business!.id;
    const { data: product } = await ownerClient.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Cost UI Product",
      p_sku: `cost-ui-sku-${suffix}`,
      p_cost_price: 1234.56,
      p_selling_price: 2000,
    });
    productId = product!.id;

    const salesUser = await createConfirmedTestUser(salesEmail, PASSWORD);
    await addMemberWithRole(businessId, salesUser.id, "SALES");
  });

  test("SALES cannot see cost anywhere on the product detail page", async ({ page }) => {
    await loginAsInBrowser(page, salesEmail, PASSWORD);
    await page.goto(`/${businessId}/products/${productId}`);
    await expect(page.getByRole("heading", { name: "Cost UI Product" })).toBeVisible();
    await expect(page.getByText("Cost price")).toHaveCount(0);
    await expect(page.getByText("1234.56")).toHaveCount(0);
  });

  test("OWNER can see cost on the product detail page", async ({ page }) => {
    await loginAsInBrowser(page, ownerEmail, PASSWORD);
    await page.goto(`/${businessId}/products/${productId}`);
    await expect(page.getByText("Cost price")).toBeVisible();
    await expect(page.getByText(/1234\.56/)).toBeVisible();
  });

  test("SALES cannot see a cost field when editing (the field is not rendered at all)", async ({ page }) => {
    await loginAsInBrowser(page, salesEmail, PASSWORD);
    // SALES lacks products.manage too, so the edit route itself 404s —
    // this also confirms products.manage, not just inventory.view_cost,
    // gates the edit surface.
    await page.goto(`/${businessId}/products/${productId}?edit=1`);
    await expect(page.getByText("Cost UI Product")).toBeVisible(); // falls back to the read view, not a form
    await expect(page.getByLabel("Cost price")).toHaveCount(0);
  });
});
