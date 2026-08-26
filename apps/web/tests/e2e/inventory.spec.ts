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

async function createOwnerBusinessWithProduct(prefix: string, opts: { opening?: number; lowStockThreshold?: number } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", { p_name: prefix, p_slug: `${prefix}-${suffix}` });
  const { data: location } = await client
    .from("inventory_locations")
    .select("id")
    .eq("business_id", business!.id)
    .eq("is_default", true)
    .single();
  const { data: product } = await client.rpc("create_product", {
    p_business_id: business!.id,
    p_creation_key: crypto.randomUUID(),
    p_name: `${prefix} Product`,
    p_sku: `${prefix}-sku-${suffix}`,
    p_low_stock_threshold: opts.lowStockThreshold,
    p_opening_quantity: opts.opening,
    p_opening_location_id: opts.opening ? location!.id : undefined,
  });
  return { email, businessId: business!.id, productId: product!.id, productName: product!.name };
}

test.describe("inventory", () => {
  test("increase stock via the adjustment form, overview and history reflect it", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-inv-increase", { opening: 5 });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/inventory/adjust`);
    await page.getByLabel("Product").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("radio", { name: "Increase stock" }).click();
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Reason").fill("Restock delivery");
    await page.getByRole("button", { name: "Record adjustment" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/inventory\\?adjusted=1$`));
    await expect(page.getByRole("cell", { name: "15", exact: true })).toBeVisible();

    await page.goto(`/${businessId}/inventory/history`);
    await expect(page.getByText("Stock increase")).toBeVisible();
    await expect(page.getByText("Restock delivery")).toBeVisible();
  });

  test("decrease stock succeeds when sufficient, and insufficient stock is rejected with a clear message", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-inv-decrease", { opening: 3 });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/inventory/adjust`);
    await page.getByLabel("Product").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("radio", { name: "Decrease stock" }).click();
    await page.getByLabel("Quantity").fill("1");
    await page.getByLabel("Reason").fill("Sold");
    await page.getByRole("button", { name: "Record adjustment" }).click();
    // Anchored to the redirect's own target — a plain `/inventory`
    // pattern also matches the current /inventory/adjust URL as a
    // substring and would not actually wait for the redirect.
    await expect(page).toHaveURL(new RegExp(`/${businessId}/inventory\\?adjusted=1$`));

    // Now attempt to over-deduct: 2 remain, request 10.
    await page.goto(`/${businessId}/inventory/adjust`);
    await page.getByLabel("Product").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("radio", { name: "Decrease stock" }).click();
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Reason").fill("Too much");
    await page.getByRole("button", { name: "Record adjustment" }).click();

    await expect(page.getByText("Not enough stock available")).toBeVisible();
  });

  test("low-stock state appears once the threshold is crossed", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-inv-lowstock", {
      opening: 10,
      lowStockThreshold: 5,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/inventory`);
    await expect(page.getByText("In stock")).toBeVisible();

    await page.goto(`/${businessId}/inventory/adjust`);
    await page.getByLabel("Product").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("radio", { name: "Decrease stock" }).click();
    await page.getByLabel("Quantity").fill("6");
    await page.getByLabel("Reason").fill("Big sale");
    await page.getByRole("button", { name: "Record adjustment" }).click();
    // Wait for the Server Action's own redirect to complete before
    // navigating again — a page.goto() issued while it's still in flight
    // races and cancels it (see loginAsInBrowser's own comment on this
    // exact pitfall elsewhere in this test suite), which would leave the
    // adjustment un-applied and make this assertion fail for the wrong
    // reason. Anchored precisely to the redirect's own target
    // (?adjusted=1) — a plain `/inventory` pattern would also match the
    // CURRENT /inventory/adjust URL as a substring and not actually wait
    // for anything.
    await expect(page).toHaveURL(new RegExp(`/${businessId}/inventory\\?adjusted=1$`));

    await page.goto(`/${businessId}/inventory`);
    await expect(page.getByText("Low stock")).toBeVisible();
  });
});
