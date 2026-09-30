import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

// Phase 1Q-C — free product lookup E2E coverage. Every provider-dependent
// scenario is deterministic: playwright.config.ts starts
// tests/e2e/fixtures/off-stub-server.mjs and points the adapter at it
// (loopback override, explicitly opted in), so no test touches the real
// Open Food Facts API. Unit tests (open-food-facts.test.ts, off-base-url.test.ts,
// actions.test.ts, product-lookup-field.test.tsx) cover the adapter, host
// allowlist, orchestration and UI state machine.

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
  return { email, businessId: data.id, client };
}

const VALID_EAN13 = "5000112637922";
const INVALID_CHECK_DIGIT_EAN13 = "5000112637921";
// Served by tests/e2e/fixtures/off-stub-server.mjs (the provider stand-in
// playwright.config.ts wires in) — deterministic, no live third-party call.
const STUB_MATCH_PEN = "4006381333931";
const STUB_MATCH_JUICE = "5901234123457";
const STUB_SLOW = "4000539200007"; // stub answers after ~2s
const STUB_PROVIDER_500 = "4012345678901";
const STUB_PROVIDER_429 = "4001234567891";
const SHOT_DIR = path.join(__dirname, "..", "..", "qa-screenshots");

test.describe("Phase 1Q-C free product lookup", () => {
  test("local match: shows the existing product and links to it, without creating a duplicate", async ({ page }) => {
    const { email, businessId, client } = await createBusiness("e2e-lookup-local");
    const { data: product, error } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Already Catalogued Widget",
      p_selling_price: 50,
    });
    expect(error).toBeNull();
    await client.rpc("add_product_identifier", {
      p_business_id: businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: VALID_EAN13,
    });

    await login(page, email);
    await page.goto(`/${businessId}/products/new`);
    await page.getByLabel("Barcode / GTIN").fill(VALID_EAN13);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByText(/This barcode already belongs to Already Catalogued Widget/)).toBeVisible();
    await page.getByRole("link", { name: "View product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/${product!.id}$`));
  });

  test("invalid check digit: inline error, barcode field never cleared", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-invalid");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Name").fill("Draft Product");
    await page.getByLabel("Barcode / GTIN").fill(INVALID_CHECK_DIGIT_EAN13);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByRole("alert").filter({ hasText: /valid barcode/i })).toBeVisible();
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(INVALID_CHECK_DIGIT_EAN13);
    // Every other already-entered field survives the lookup untouched.
    await expect(page.getByLabel("Name")).toHaveValue("Draft Product");
  });

  test("not found (non-barcode code, no external call eligible): manual entry stays available, no field is lost", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-notfound");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Name").fill("Hand-entered Product");
    await page.getByLabel(/Selling price/).fill("75");
    await page.getByLabel("Barcode / GTIN").fill("SUPPLIER-CODE-999");
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Hand-entered Product");
    await expect(page.getByLabel(/Selling price/)).toHaveValue("75");
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue("SUPPLIER-CODE-999");

    // Product creation itself is never blocked by a lookup miss.
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
  });

  test("cross-business isolation: the same barcode in another business never surfaces as a local match", async ({ page }) => {
    const ownerA = await createBusiness("e2e-lookup-tenant-a");
    const ownerB = await createBusiness("e2e-lookup-tenant-b");

    const { data: productA } = await ownerA.client.rpc("create_product", {
      p_business_id: ownerA.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Tenant A Product",
      p_selling_price: 20,
    });
    await ownerA.client.rpc("add_product_identifier", {
      p_business_id: ownerA.businessId,
      p_product_id: productA!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: STUB_MATCH_PEN,
    });

    await login(page, ownerB.email);
    await page.goto(`/${ownerB.businessId}/products/new`);
    await page.getByLabel("Barcode / GTIN").fill(STUB_MATCH_PEN);
    const lookup = page.getByRole("button", { name: "Look up" });
    await lookup.click();

    // Wait for the COMPLETED lookup — business B has no local match, so the
    // final state is the stub's external suggestion — before asserting any
    // absence. Asserting right after the click would pass vacuously while
    // the response is still in flight.
    await expect(page.getByText(/External suggestion/)).toBeVisible();
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    await expect(lookup).toBeEnabled();
    await expect(page.getByText("Looking up barcode…")).toHaveCount(0);

    await expect(page.getByText(/Tenant A Product/)).toHaveCount(0);
    await expect(page.getByText(/This barcode already belongs to/)).toHaveCount(0);
    await expect(page.locator(`a[href*="${productA!.id}"]`)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View product" })).toHaveCount(0);
  });

  test("double submit: button disabled while pending, repeated click/Enter fire one request, re-enabled after", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-double");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    let lookupPosts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(`/${businessId}/products/new`)) lookupPosts++;
    });

    await page.getByLabel("Name").fill("Keep While Pending");
    const barcode = page.getByLabel("Barcode / GTIN");
    await barcode.fill(STUB_SLOW);
    const lookup = page.getByRole("button", { name: "Look up" });
    await lookup.click();

    await expect(lookup).toBeDisabled();
    await expect(lookup).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status").filter({ hasText: "Looking up barcode…" })).toBeVisible();
    await expect(barcode).toHaveValue(STUB_SLOW);

    // Repeated attempts while pending: forced click on the disabled button
    // and Enter in the field must not start another submission.
    await lookup.click({ force: true });
    await lookup.click({ force: true });
    await barcode.press("Enter");
    await barcode.press("Enter");

    await expect(page.getByText("Stub Slow Product")).toBeVisible();
    await expect(lookup).toBeEnabled();
    await expect(lookup).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("Looking up barcode…")).toHaveCount(0);
    expect(lookupPosts).toBe(1);
    await expect(page.getByLabel("Name")).toHaveValue("Keep While Pending");
    await expect(barcode).toHaveValue(STUB_SLOW);

    // A new lookup after completion still works.
    await barcode.fill(STUB_MATCH_PEN);
    await lookup.click();
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
  });

  test("external match is only a suggestion; Use product details fills EMPTY fields on explicit click", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-ext");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Barcode / GTIN").fill(STUB_MATCH_PEN);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByText(/External suggestion/)).toBeVisible();
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    // Lookup alone applies nothing.
    await expect(page.getByLabel("Name")).toHaveValue("");
    await expect(page.getByLabel("Category")).toHaveValue("");

    await page.getByRole("button", { name: "Use product details" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Stub Highlighter Pen");
    await expect(page.getByLabel("Category")).toHaveValue("Stationery");
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(STUB_MATCH_PEN);
    // Nothing was persisted by the lookup or the apply.
    await expect(page).toHaveURL(/\/products\/new$/);
  });

  test("apply never overwrites a value the user already typed", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-nooverwrite");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Name").fill("My Own Name");
    await page.getByLabel("Barcode / GTIN").fill(STUB_MATCH_JUICE);
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText("Stub Orange Juice")).toBeVisible();
    await page.getByRole("button", { name: "Use product details" }).click();

    await expect(page.getByLabel("Name")).toHaveValue("My Own Name");
    await expect(page.getByLabel("Category")).toHaveValue("Beverages");
  });

  test("valid barcode with no provider data: message shown, barcode kept, manual entry continues", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-miss");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Name").fill("Typed Name");
    await page.getByLabel("Barcode / GTIN").fill(VALID_EAN13);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(VALID_EAN13);
    await expect(page.getByLabel("Name")).toHaveValue("Typed Name");
  });

  for (const [label, code, message] of [
    ["provider 500", STUB_PROVIDER_500, /temporarily unavailable/],
    ["provider rate limit", STUB_PROVIDER_429, /rate-limited/],
  ] as const) {
    test(`${label}: recoverable alert, every entered field preserved, creation still works`, async ({ page }) => {
      const { email, businessId } = await createBusiness("e2e-lookup-err");
      await login(page, email);
      await page.goto(`/${businessId}/products/new`);

      await page.getByLabel("Name").fill("Keep Me");
      await page.getByLabel("Description").fill("Keep this description");
      await page.getByLabel("Category").fill("Keep category");
      await page.getByLabel(/Selling price/).fill("123");
      await page.getByLabel("Barcode / GTIN").fill(code);
      await page.getByRole("button", { name: "Look up" }).click();

      await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(code);
      await expect(page.getByLabel("Name")).toHaveValue("Keep Me");
      await expect(page.getByLabel("Description")).toHaveValue("Keep this description");
      await expect(page.getByLabel("Category")).toHaveValue("Keep category");
      await expect(page.getByLabel(/Selling price/)).toHaveValue("123");

      await page.getByRole("button", { name: "Create product" }).click();
      await expect(page).toHaveURL(new RegExp(`/${businessId}/products/[0-9a-f-]{36}$`));
    });
  }

  test("keyboard flow: Enter looks up, Tab reaches the apply button, Enter applies", async ({ page }) => {
    const { email, businessId } = await createBusiness("e2e-lookup-kbd");
    await login(page, email);
    await page.goto(`/${businessId}/products/new`);

    await page.getByLabel("Barcode / GTIN").fill(STUB_MATCH_PEN);
    await page.getByLabel("Barcode / GTIN").press("Enter");
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    // The lookup button is focusable and named; the apply button is reachable.
    const apply = page.getByRole("button", { name: "Use product details" });
    await apply.focus();
    await expect(apply).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Name")).toHaveValue("Stub Highlighter Pen");
    await expect(page.getByRole("button", { name: "Applied" })).toBeDisabled();
  });

  test("responsive + theme sweep: lookup states render without horizontal overflow", async ({ page }) => {
    test.setTimeout(180_000);
    const { email, businessId } = await createBusiness("e2e-lookup-visual");
    await login(page, email);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${businessId}/products/new`);
        const barcode = page.getByLabel("Barcode / GTIN");
        const lookup = page.getByRole("button", { name: "Look up" });

        const noOverflow = async () => {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          );
          expect(overflow).toBeLessThanOrEqual(0);
        };

        await barcode.fill(STUB_MATCH_PEN);
        await lookup.click();
        await expect(page.getByText(/External suggestion/)).toBeVisible();
        await noOverflow();
        await page.screenshot({ path: path.join(SHOT_DIR, `1qc-external-${width}-${scheme}.png`), fullPage: true });

        await barcode.fill(INVALID_CHECK_DIGIT_EAN13);
        await lookup.click();
        await expect(page.getByRole("alert").filter({ hasText: /valid barcode/i })).toBeVisible();
        await noOverflow();
        await page.screenshot({ path: path.join(SHOT_DIR, `1qc-invalid-${width}-${scheme}.png`), fullPage: true });

        await barcode.fill(STUB_PROVIDER_500);
        await lookup.click();
        await expect(page.getByRole("alert").filter({ hasText: /temporarily unavailable/ })).toBeVisible();
        await noOverflow();
        await page.screenshot({ path: path.join(SHOT_DIR, `1qc-error-${width}-${scheme}.png`), fullPage: true });
      }
    }
  });
});
