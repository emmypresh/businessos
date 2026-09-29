import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

const PASSWORD = "Password1234";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function createBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data, error } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
    p_category_code: "GENERAL_TRADING",
  });
  if (error || !data) throw error ?? new Error("Business creation failed");
  return { email, businessId: data.id };
}

async function chooseManualSku(page: Page) {
  await page.getByRole("radio", { name: "I'll enter my own" }).check();
  await expect(page.getByLabel("SKU", { exact: true })).toBeVisible();
}

async function createManualProduct(page: Page, businessId: string, name: string, sku: string) {
  await page.goto(`/${businessId}/products/new`);
  await page.getByLabel("Name").fill(name);
  await chooseManualSku(page);
  await page.getByLabel("SKU", { exact: true }).fill(sku);
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
  return page.url();
}

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

test.describe("Phase 1Q-B product SKU and identifiers", () => {
  test("tracked auto SKU, edit stability, canonicalization, and invalid-edit preservation", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-sku-auto");
    await login(page, email);

    await page.goto(`/${businessId}/products/new`);
    await expect(page.getByRole("radio", { name: "Auto-generate" })).toBeChecked();
    await expect(page.getByText("A SKU will be generated automatically when this product is created.")).toBeVisible();
    await page.getByLabel("Name").fill("Auto SKU Product");
    await page.getByLabel("Description").fill("kept on failed SKU edit");
    await page.getByLabel(/Selling price/).fill("42");
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
    const initialSku = (await page.locator("h1 + p").textContent())?.trim();
    expect(initialSku).toMatch(/^[A-Z0-9_-]+(?:-[A-Z0-9_-]+)*$/);

    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByLabel("SKU", { exact: true })).toHaveValue(initialSku!);
    await page.getByLabel("Name").fill("Auto SKU Renamed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Auto SKU Renamed" })).toBeVisible();
    await expect(page.locator("h1 + p")).toHaveText(initialSku!);

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("SKU", { exact: true }).fill("  canon  sku ");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("h1 + p")).toHaveText("CANON-SKU");

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("SKU", { exact: true }).fill("!!!");
    await page.getByLabel("Description").fill("still present after invalid SKU");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter a valid SKU (letters, numbers, - and _ only).", { exact: true })).toBeVisible();
    await expect(page.getByLabel("SKU", { exact: true })).toHaveValue("!!!");
    await expect(page.getByLabel("Description")).toHaveValue("still present after invalid SKU");
  });

  test("manual duplicate SKU displays an inline error without losing entered product fields", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-sku-duplicate");
    await login(page, email);
    await createManualProduct(page, businessId, "Existing Manual SKU", "duplicate-manual");

    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Name").fill("Duplicate Manual Candidate");
    await page.getByLabel("Description").fill("This description must remain");
    await chooseManualSku(page);
    await page.getByLabel("SKU", { exact: true }).fill("duplicate-manual");
    await page.getByLabel("Category").fill("Retail stock");
    await page.getByLabel(/Selling price/).fill("19.95");
    await page.getByLabel("Opening stock").fill("0");
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page.getByText("This SKU is already in use.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Duplicate Manual Candidate");
    await expect(page.getByLabel("Description")).toHaveValue("This description must remain");
    await expect(page.getByLabel("SKU", { exact: true })).toHaveValue("duplicate-manual");
    await expect(page.getByLabel("Category")).toHaveValue("Retail stock");
    await expect(page.getByLabel(/Selling price/)).toHaveValue("19.95");
  });

  test("identifier add, invalid and duplicate recovery, and removal persist through reload", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-identifiers");
    await login(page, email);
    await createManualProduct(page, businessId, "Identifier Product", "identifier-product");

    // The type control and code field are independently labelled and form
    // a usable keyboard sequence rather than relying on pointer-only UI.
    await page.getByLabel("Code").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByLabel("Type")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Code")).toBeFocused();

    await page.getByLabel("Code").fill("1234567890123");
    await page.getByRole("button", { name: "Add identifier" }).click();
    await expect(page.getByText(/check digit doesn't match/)).toBeVisible();
    await expect(page.getByLabel("Code")).toHaveValue("1234567890123");

    const identifier = "4006381333931";
    await page.getByLabel("Code").fill(identifier);
    await page.getByRole("button", { name: "Add identifier" }).click();
    await expect(page.getByText(identifier, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(identifier, { exact: true })).toBeVisible();

    await page.getByLabel("Code").fill(identifier);
    await page.getByRole("button", { name: "Add identifier" }).click();
    await expect(page.getByText("This code is already assigned to a product in this business.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Code")).toHaveValue(identifier);
    await page.getByRole("button", { name: "Remove identifier" }).click();
    await expect(page.getByText(identifier, { exact: true })).toBeHidden();
    await page.reload();
    await expect(page.getByText(identifier, { exact: true })).toBeHidden();
  });

  test("service SKU copy, responsive layout, theme, and accessible controls", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-service-sku");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);
    await page.getByRole("radio", { name: "Auto-generate" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "I'll enter my own" })).toBeChecked();
    await page.getByRole("radio", { name: "Auto-generate" }).check();
    await expect(page.getByRole("radio", { name: "Auto-generate" })).toBeChecked();
    await page.getByLabel("Track inventory for this product").uncheck();
    await expect(page.getByText("SKU is optional for service items")).toBeVisible();
    await expect(page.getByText("A SKU will be generated automatically when this product is created.")).toBeHidden();
    await expect(page.getByLabel("SKU", { exact: true })).toBeHidden();
    await page.getByLabel("Name").fill("Service Without SKU");
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
    await expect(page.locator("h1 + p")).toHaveCount(0);

    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByLabel("SKU", { exact: true })).toBeVisible();
    await expect(page.getByLabel("SKU", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("SKU", { exact: true })).toHaveAttribute("id", "sku");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Service Without SKU" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove identifier" })).toHaveCount(0);

    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoPageOverflow(page);
      await page.screenshot({ path: `qa-screenshots/phase-1qb-product-detail-light-${width}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoPageOverflow(page);
    await page.screenshot({ path: "qa-screenshots/phase-1qb-product-detail-dark-390.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNoPageOverflow(page);
    await page.screenshot({ path: "qa-screenshots/phase-1qb-product-detail-dark-1440.png", fullPage: true });
  });
});
