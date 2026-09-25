import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { setBusinessCountryCurrencyForTest } from "../integration/helpers/inventory";

// Phase 1N-C3 visual QA — fresh screenshots (never reused stale ones) for
// the two new reports at every required width, dark mode at 390/1440, and
// at least NG/GH/US currency, per the approved plan §46. Mirrors
// phase-1q-0d-visual-qa.spec.ts's own qa-screenshots/ output convention.
const PASSWORD = "Password1234";
const SHOT_DIR = path.join(process.cwd(), "qa-screenshots");
const WIDTHS = [390, 768, 1280, 1440];

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function seedBusiness(prefix: string, countryCode: string, currencyCode: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", { p_name: prefix, p_slug: `${prefix}-${suffix}` });
  const businessId = business!.id as string;
  await setBusinessCountryCurrencyForTest(businessId, countryCode, currencyCode);

  const { data: product } = await client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_name: `QA Product ${suffix}`,
    p_sku: `qa-${suffix}`,
    p_selling_price: 3000,
    p_opening_quantity: 25,
  });
  const { data: customerId } = await client.rpc("create_customer", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_name: `QA Customer ${suffix}`,
  });
  await client.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_customer_id: customerId ?? undefined,
    p_items: [{ product_id: product!.id, quantity: 2 }],
    p_payment_status: "PAID",
    p_payment_method: "CASH",
    p_amount_paid: 6000,
  });

  return { email, businessId };
}

const COUNTRIES: { code: string; currency: string }[] = [
  { code: "NG", currency: "NGN" },
  { code: "GH", currency: "GHS" },
  { code: "US", currency: "USD" },
];

for (const { code, currency } of COUNTRIES) {
  test(`customer + inventory reports render correctly for ${code}/${currency} across all required widths`, async ({ page }) => {
    const { email, businessId } = await seedBusiness(`e2e-visual-${code.toLowerCase()}`, code, currency);
    await loginAsInBrowser(page, email, PASSWORD);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });

      await page.goto(`/${businessId}/reports/customers?preset=last_30_days`);
      await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, `1n-c3-${code.toLowerCase()}-customers-${width}.png`), fullPage: true });

      await page.goto(`/${businessId}/reports/inventory?preset=last_30_days`);
      await expect(page.getByRole("heading", { name: "Inventory", level: 1 })).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, `1n-c3-${code.toLowerCase()}-inventory-${width}.png`), fullPage: true });
    }
  });
}

test("customer + inventory reports render correctly in dark mode at 390 and 1440", async ({ page }) => {
  const { email, businessId } = await seedBusiness("e2e-visual-dark", "NG", "NGN");
  await page.emulateMedia({ colorScheme: "dark" });
  await loginAsInBrowser(page, email, PASSWORD);

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto(`/${businessId}/reports/customers?preset=last_30_days`);
    await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, `1n-c3-dark-customers-${width}.png`), fullPage: true });

    await page.goto(`/${businessId}/reports/inventory?preset=last_30_days`);
    await expect(page.getByRole("heading", { name: "Inventory", level: 1 })).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, `1n-c3-dark-inventory-${width}.png`), fullPage: true });
  }
});
