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

async function createOwnerBusinessWithProduct(
  prefix: string,
  overrides: { sellingPrice?: number; openingQuantity?: number } = {}
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  const productName = `E2E Sale Product ${suffix}`;
  const { data: product } = await client.rpc("create_product", {
    p_business_id: business!.id,
    p_creation_key: crypto.randomUUID(),
    p_name: productName,
    p_sku: `e2e-sale-${suffix}`,
    p_selling_price: overrides.sellingPrice ?? 1000,
    p_opening_quantity: overrides.openingQuantity ?? 10,
  });
  return { email, businessId: business!.id, productId: product!.id, productName };
}

async function addProductToSale(page: Page, productName: string) {
  await page.getByLabel("Search products").fill(productName);
  const result = page.getByTestId("product-picker-results").getByText(productName, { exact: false });
  await expect(result).toBeVisible();
  await result.click();
}

async function selectBaseUiOption(page: Page, comboboxName: string, optionName: string) {
  await page.getByRole("combobox", { name: comboboxName }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test.describe("sales", () => {
  test("create a walk-in sale and it appears on the sale detail page", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-walkin");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    await expect(page.getByText("Walk-in customer")).toBeVisible();
    // getByText would also match the Next.js route-announcer's live-region
    // copy of the heading text (see tests/e2e/products.spec.ts's own
    // established convention) — scope to the actual heading role instead.
    await expect(page.getByRole("heading", { name: /^SALE-\d{6}$/ })).toBeVisible();
  });

  test("create a sale for a specific customer, and it appears in that customer's sale history", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-customer");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("Sale History Customer");
    await page.getByRole("button", { name: "Create customer" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));
    const customerUrl = page.url();
    const customerId = customerUrl.split("/").pop()!;

    await page.goto(`/${businessId}/sales/new`);
    await selectBaseUiOption(page, "Customer (optional)", "Sale History Customer");
    await addProductToSale(page, productName);
    await page.getByRole("button", { name: /Complete sale/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/customers/${customerId}`);
    await expect(page.getByRole("heading", { name: "Sale history" })).toBeVisible();
    await expect(page.getByText(/^SALE-\d{6}$/)).toBeVisible();
  });

  test("a tracked product's stock is deducted correctly after a sale", async ({ page }) => {
    const { email, businessId, productId, productName } = await createOwnerBusinessWithProduct(
      "e2e-sale-stock",
      { openingQuantity: 10 }
    );
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await page.getByLabel(`Quantity for ${productName}`).fill("4");
    await page.getByRole("button", { name: /Complete sale/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/products/${productId}`);
    await expect(page.getByTestId("stock-summary-card").getByText("6", { exact: true })).toBeVisible();
  });

  test("insufficient stock shows a safe error, not a raw database error", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-insufficient", {
      openingQuantity: 2,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await page.getByLabel(`Quantity for ${productName}`).fill("100");
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page.getByText(/not enough stock/i)).toBeVisible();
    // Still on the new-sale page — no sale was created.
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/new$`));
  });

  test("selecting the same product twice merges into one line, not a duplicate row", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-duplicate", {
      openingQuantity: 20,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await addProductToSale(page, productName);

    const rows = page.getByRole("row").filter({ hasText: productName });
    await expect(rows).toHaveCount(1);
    await expect(page.getByLabel(`Quantity for ${productName}`)).toHaveValue("2");
  });

  test("a quantity with more than 3 decimal places is blocked client-side, and never reaches the server", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-precision", {
      openingQuantity: 20,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await page.getByLabel(`Quantity for ${productName}`).fill("1.2345");

    await expect(page.getByText("Up to 3 decimal places.")).toBeVisible();
  });

  test("an UNPAID sale hides the payment method/amount fields and records zero amount paid", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-unpaid");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await expect(page.getByLabel("Payment method")).toHaveCount(0);
    await expect(page.getByLabel("Amount paid")).toHaveCount(0);
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    // "Unpaid" appears in both the header badge and the payment
    // definition list — scope to the definition list specifically.
    await expect(page.getByRole("definition").filter({ hasText: "Unpaid" })).toBeVisible();
  });

  test("a PAID sale requires a payment method and records the full total as paid", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-paid", {
      sellingPrice: 500,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await selectBaseUiOption(page, "Payment status", "Paid");
    await selectBaseUiOption(page, "Payment method", "Cash");
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    await expect(page.getByRole("definition").filter({ hasText: "Paid" })).toBeVisible();
  });

  test("a PARTIALLY_PAID sale requires an amount paid below the total", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-partial", {
      sellingPrice: 1000,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await selectBaseUiOption(page, "Payment status", "Partially paid");
    await selectBaseUiOption(page, "Payment method", "Cash");

    // An amount equal to the estimated total (1000, from the single
    // quantity-1 line at sellingPrice 1000) is blocked client-side —
    // Codex round 3's remaining finding: this must actually prevent
    // submission, not just show an error. The button is disabled and the
    // page never navigates away from /sales/new.
    await page.getByLabel("Amount paid").fill("1000");
    await expect(page.getByText("Partial payment must be less than the estimated total.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Complete sale/ })).toBeDisabled();

    // Defense-in-depth: even a form.requestSubmit() that bypasses the
    // disabled button entirely (the same technique the double-click
    // idempotency tests already use deliberately) is refused by the
    // form's own onSubmit guard — the page never navigates away.
    await page.getByTestId("sale-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/new$`));

    await page.getByLabel("Amount paid").fill("400");
    await expect(page.getByRole("button", { name: /Complete sale/ })).toBeEnabled();
    await page.getByRole("button", { name: /Complete sale/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    await expect(page.getByRole("definition").filter({ hasText: "Partially paid" })).toBeVisible();
    await expect(page.getByText(/400\.00/)).toBeVisible();
  });

  test("a double-click submission does not create a duplicate sale", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-dup", {
      openingQuantity: 50,
    });
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);

    await page.getByTestId("sale-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });

    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/sales`);
    const rows = page.getByRole("row").filter({ hasText: /^SALE-\d{6}/ });
    await expect(rows).toHaveCount(1);
  });

  test("a product rename after a sale does not alter the old sale detail", async ({ page }) => {
    const { email, businessId, productId, productName } = await createOwnerBusinessWithProduct("e2e-sale-snap-product");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/sales/new`);
    await addProductToSale(page, productName);
    await page.getByRole("button", { name: /Complete sale/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    const saleUrl = page.url();

    await page.goto(`/${businessId}/products/${productId}?edit=1`);
    await page.getByLabel("Name").fill("Renamed After Sale E2E");
    await page.getByRole("button", { name: "Save changes" }).click();

    await page.goto(saleUrl);
    await expect(page.getByText(productName)).toBeVisible();
    await expect(page.getByText("Renamed After Sale E2E")).toHaveCount(0);
  });

  test("a customer edit after a sale does not alter the old sale detail", async ({ page }) => {
    const { email, businessId, productName } = await createOwnerBusinessWithProduct("e2e-sale-snap-customer");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("Pre-Edit Snapshot Customer");
    await page.getByRole("button", { name: "Create customer" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));
    const customerId = page.url().split("/").pop()!;

    await page.goto(`/${businessId}/sales/new`);
    await selectBaseUiOption(page, "Customer (optional)", "Pre-Edit Snapshot Customer");
    await addProductToSale(page, productName);
    await page.getByRole("button", { name: /Complete sale/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/sales/[0-9a-f-]{36}$`));
    const saleUrl = page.url();

    await page.goto(`/${businessId}/customers/${customerId}?edit=1`);
    await page.getByLabel("Name").fill("Post-Edit Snapshot Customer");
    await page.getByRole("button", { name: "Save changes" }).click();

    await page.goto(saleUrl);
    await expect(page.getByText("Pre-Edit Snapshot Customer")).toBeVisible();
    await expect(page.getByText("Post-Edit Snapshot Customer")).toHaveCount(0);
  });
});
