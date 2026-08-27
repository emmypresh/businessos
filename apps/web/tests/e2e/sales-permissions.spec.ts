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

test.describe("sale role permissions", () => {
  let businessId: string;
  let ownerEmail: string;
  let salesEmail: string;
  let accountantEmail: string;
  let inventoryEmail: string;

  test.beforeAll(async () => {
    const suffix = Date.now();
    ownerEmail = `sale-perm-owner-${suffix}@example.test`;
    salesEmail = `sale-perm-sales-${suffix}@example.test`;
    accountantEmail = `sale-perm-accountant-${suffix}@example.test`;
    inventoryEmail = `sale-perm-inventory-${suffix}@example.test`;

    await createConfirmedTestUser(ownerEmail, PASSWORD);
    const ownerClient = createUserClient();
    await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
    const { data: business } = await ownerClient.rpc("create_business", {
      p_name: "Sale Perm Business",
      p_slug: `sale-perm-${suffix}`,
    });
    businessId = business!.id;
    await ownerClient.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Sale Perm Product",
      p_sku: `sale-perm-sku-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 50,
    });

    const salesUser = await createConfirmedTestUser(salesEmail, PASSWORD);
    await addMemberWithRole(businessId, salesUser.id, "SALES");
    const accountantUser = await createConfirmedTestUser(accountantEmail, PASSWORD);
    await addMemberWithRole(businessId, accountantUser.id, "ACCOUNTANT");
    const inventoryUser = await createConfirmedTestUser(inventoryEmail, PASSWORD);
    await addMemberWithRole(businessId, inventoryUser.id, "INVENTORY");
  });

  test("SALES can create a sale", async ({ page }) => {
    await loginAsInBrowser(page, salesEmail, PASSWORD);
    await page.goto(`/${businessId}/sales/new`);
    await page.getByLabel("Search products").fill("Sale Perm Product");
    const result = page.getByTestId("product-picker-results").getByText("Sale Perm Product", { exact: false });
    await expect(result).toBeVisible();
    await result.click();
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
  });

  test("ACCOUNTANT can view sales but cannot create one", async ({ page }) => {
    await loginAsInBrowser(page, accountantEmail, PASSWORD);
    await page.goto(`/${businessId}/sales`);
    await expect(page.getByRole("heading", { name: "Sales" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New sale" })).toHaveCount(0);

    await page.goto(`/${businessId}/sales/new`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("INVENTORY cannot access sales or customers at all", async ({ page }) => {
    await loginAsInBrowser(page, inventoryEmail, PASSWORD);
    await page.goto(`/${businessId}/sales`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${businessId}/customers`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a location rename after a sale does not alter the old sale detail", async ({ page }) => {
    await loginAsInBrowser(page, ownerEmail, PASSWORD);
    await page.goto(`/${businessId}/sales/new`);
    await page.getByLabel("Search products").fill("Sale Perm Product");
    const result = page.getByTestId("product-picker-results").getByText("Sale Perm Product", { exact: false });
    await expect(result).toBeVisible();
    await result.click();
    await page.getByRole("button", { name: /Complete sale/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    await expect(page.getByText("Main Store")).toBeVisible();
  });
});

test.describe("cross-tenant customer/sale protection", () => {
  test("cross-tenant customer and sale routes 404", async ({ page }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `xtenant-cs-a-${suffix}@example.test`;
    const emailB = `xtenant-cs-b-${suffix}@example.test`;

    await createConfirmedTestUser(emailA, PASSWORD);
    const clientA = createUserClient();
    await clientA.auth.signInWithPassword({ email: emailA, password: PASSWORD });
    const { data: businessA } = await clientA.rpc("create_business", {
      p_name: "XTenant CS A",
      p_slug: `xtenant-cs-a-${suffix}`,
    });
    const { data: customerA } = await clientA.rpc("create_customer", {
      p_business_id: businessA!.id,
      p_creation_key: crypto.randomUUID(),
      p_name: "Tenant A Customer",
    });
    const { data: productA } = await clientA.rpc("create_product", {
      p_business_id: businessA!.id,
      p_creation_key: crypto.randomUUID(),
      p_name: "Tenant A Sale Product",
      p_sku: `xtenant-cs-sku-${suffix}`,
      p_opening_quantity: 5,
    });
    const { data: saleA } = await clientA.rpc("create_sale", {
      p_business_id: businessA!.id,
      p_creation_key: crypto.randomUUID(),
      p_items: [{ product_id: productA!.id, quantity: 1 }],
    });

    await createConfirmedTestUser(emailB, PASSWORD);
    const clientB = createUserClient();
    await clientB.auth.signInWithPassword({ email: emailB, password: PASSWORD });
    await clientB.rpc("create_business", { p_name: "XTenant CS B", p_slug: `xtenant-cs-b-${suffix}` });

    await loginAsInBrowser(page, emailB, PASSWORD);

    await page.goto(`/${businessA!.id}/customers/${customerA}`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${businessA!.id}/sales/${saleA}`);
    await expect(page.getByText("Not found")).toBeVisible();
  });
});
