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

test.describe("cross-tenant product/inventory protection", () => {
  let businessAId: string;
  let productAId: string;
  let emailA: string;
  let emailB: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emailA = `xtenant-a-${suffix}@example.test`;
    emailB = `xtenant-b-${suffix}@example.test`;

    await createConfirmedTestUser(emailA, PASSWORD);
    const clientA = createUserClient();
    await clientA.auth.signInWithPassword({ email: emailA, password: PASSWORD });
    const { data: businessA, error: businessAError } = await clientA.rpc("create_business", {
      p_name: "XTenant A",
      p_slug: `xtenant-a-${suffix}`,
    });
    if (businessAError || !businessA) {
      throw new Error(`Failed to create XTenant A: ${businessAError?.message}`);
    }
    businessAId = businessA.id;
    const { data: product, error: productError } = await clientA.rpc("create_product", {
      p_business_id: businessAId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Tenant A Product",
      p_sku: `xtenant-a-sku-${suffix}`,
    });
    if (productError || !product) {
      throw new Error(`Failed to create Tenant A's product: ${productError?.message}`);
    }
    productAId = product.id;

    await createConfirmedTestUser(emailB, PASSWORD);
    const clientB = createUserClient();
    await clientB.auth.signInWithPassword({ email: emailB, password: PASSWORD });
    const { error: businessBError } = await clientB.rpc("create_business", {
      p_name: "XTenant B",
      p_slug: `xtenant-b-${suffix}`,
    });
    if (businessBError) {
      throw new Error(`Failed to create XTenant B: ${businessBError.message}`);
    }
  });

  test("User B cannot view User A's product", async ({ page }) => {
    await loginAsInBrowser(page, emailB, PASSWORD);
    await page.goto(`/${businessAId}/products/${productAId}`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("User B cannot adjust stock for User A's business route", async ({ page }) => {
    await loginAsInBrowser(page, emailB, PASSWORD);
    await page.goto(`/${businessAId}/inventory/adjust`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("User A can view their own product (sanity check)", async ({ page }) => {
    await loginAsInBrowser(page, emailA, PASSWORD);
    await page.goto(`/${businessAId}/products/${productAId}`);
    await expect(page.getByRole("heading", { name: "Tenant A Product" })).toBeVisible();
  });
});
