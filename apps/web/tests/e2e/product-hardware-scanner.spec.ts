import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

// Phase 1Q-E — keyboard-wedge (USB / Bluetooth HID) barcode scanner E2E.
//
// No physical scanner: a scan is simulated with Playwright's real keyboard
// (trusted key events that really insert characters), typed with ~0 ms gaps
// to emulate scanner speed and with 120 ms gaps to emulate a human. This
// exercises the real detector, the real snapshot/restore field protection and
// the real 1Q-C server action. It is NOT physical-hardware certification.

const PASSWORD = "Password1234";
const VALID_EAN13 = "5000112637922";
const VALID_EAN8 = "96385074";
const STUB_MATCH_PEN = "4006381333931";
const INVALID_EAN13 = "5000112637921";
const SHOT_DIR = path.join(__dirname, "..", "..", "qa-screenshots");

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
  return { email, businessId: data.id as string, client };
}

async function openNewProduct(page: Page, prefix: string) {
  const biz = await createBusiness(prefix);
  await login(page, biz.email);
  await page.goto(`/${biz.businessId}/products/new`);
  await expect(page.getByLabel("Barcode / GTIN")).toBeVisible();
  return biz;
}

/** Scanner-speed burst: digits then Enter, no artificial delay. */
async function hardwareScan(page: Page, code: string, terminator: "Enter" | "Tab" = "Enter") {
  await page.keyboard.type(code, { delay: 0 });
  await page.keyboard.press(terminator);
}

function countLookupPosts(page: Page, businessId: string) {
  const state = { n: 0 };
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(`/${businessId}/products/new`)) state.n++;
  });
  return state;
}

const nameField = (page: Page) => page.getByLabel("Name", { exact: true });
const barcodeField = (page: Page) => page.getByLabel("Barcode / GTIN");

test.describe("Phase 1Q-E hardware barcode scanner", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("A+C: fast scan while Product Name is focused fills the barcode, runs lookup, never touches the name", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-name");
    const posts = countLookupPosts(page, businessId);
    await nameField(page).fill("Coca-Cola 50cl");
    await page.getByLabel(/Selling price/).fill("235000");
    await nameField(page).focus();

    await hardwareScan(page, VALID_EAN13);

    await expect(barcodeField(page)).toHaveValue(VALID_EAN13);
    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(page.getByText("Barcode scanned.")).toBeVisible();
    await expect(nameField(page)).toHaveValue("Coca-Cola 50cl");
    await expect(page.getByLabel(/Selling price/)).toHaveValue("235000");
    await expect(page).toHaveURL(/\/products\/new$/); // Enter did not submit the form
    expect(posts.n).toBe(1);
  });

  test("scan with the barcode field focused and Tab suffix", async ({ page }) => {
    await openNewProduct(page, "e2e-hw-tab");
    await barcodeField(page).focus();
    await hardwareScan(page, VALID_EAN8, "Tab");
    await expect(barcodeField(page)).toHaveValue(VALID_EAN8);
    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(barcodeField(page)).toBeFocused(); // Tab was consumed only because a scan was confirmed
  });

  test("B: slow human typing is not classified as a scan", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-slow");
    const posts = countLookupPosts(page, businessId);
    await nameField(page).fill("Hand typed");
    await nameField(page).focus();
    await page.keyboard.type("5000112637922", { delay: 120 });
    await expect(nameField(page)).toHaveValue("Hand typed5000112637922");
    await expect(page.getByText("Barcode scanned.")).toHaveCount(0);
    expect(posts.n).toBe(0);
    // Manual path is unchanged: type in the barcode field, use Look up.
    await barcodeField(page).fill(VALID_EAN13);
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText(/No product information found/)).toBeVisible();
    expect(posts.n).toBe(1);
  });

  test("G: scanning a barcode that belongs to an existing product shows the local match", async ({ page }) => {
    const { businessId, client } = await openNewProduct(page, "e2e-hw-local");
    const { data: product } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Hardware Local Widget",
      p_selling_price: 50,
    });
    await client.rpc("add_product_identifier", {
      p_business_id: businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: VALID_EAN13,
    });
    await page.reload();
    await nameField(page).fill("Typed Before Scan");
    await nameField(page).focus();
    await hardwareScan(page, VALID_EAN13);
    await expect(page.getByText(/This barcode already belongs to Hardware Local Widget/)).toBeVisible();
    await expect(page.getByRole("link", { name: "View product" })).toHaveAttribute(
      "href",
      `/${businessId}/products/${product!.id}`
    );
    await expect(nameField(page)).toHaveValue("Typed Before Scan");
  });

  test("H: external suggestion is shown; applying it is an explicit click", async ({ page }) => {
    await openNewProduct(page, "e2e-hw-ext");
    await barcodeField(page).focus();
    await hardwareScan(page, STUB_MATCH_PEN);
    await expect(page.getByText(/External suggestion/)).toBeVisible();
    await expect(nameField(page)).toHaveValue("");
    await page.getByRole("button", { name: "Use product details" }).click();
    await expect(nameField(page)).toHaveValue("Stub Highlighter Pen");
  });

  test("I+form preservation: not found keeps the barcode and every typed field", async ({ page }) => {
    await openNewProduct(page, "e2e-hw-miss");
    await nameField(page).fill("Samsung A15");
    await page.getByLabel(/Selling price/).fill("235000");
    await page.getByLabel("Description").fill("Customer requested black version");
    await page.getByLabel("Description").focus();
    await hardwareScan(page, VALID_EAN13);
    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(barcodeField(page)).toHaveValue(VALID_EAN13);
    await expect(nameField(page)).toHaveValue("Samsung A15");
    await expect(page.getByLabel(/Selling price/)).toHaveValue("235000");
    await expect(page.getByLabel("Description")).toHaveValue("Customer requested black version");
  });

  test("F: invalid check digit never reaches the provider; notice shown; form preserved", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-invalid");
    const posts = countLookupPosts(page, businessId);
    await nameField(page).fill("Keep Me");
    await nameField(page).focus();
    await hardwareScan(page, INVALID_EAN13);
    await expect(page.getByRole("alert").filter({ hasText: /isn.t a valid product barcode/ })).toBeVisible();
    await expect(barcodeField(page)).toHaveValue(INVALID_EAN13);
    await expect(nameField(page)).toHaveValue("Keep Me");
    await page.waitForTimeout(500);
    expect(posts.n).toBe(0);
  });

  test("D: the same scan repeated quickly produces one request", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-dup");
    const posts = countLookupPosts(page, businessId);
    await nameField(page).focus();
    await hardwareScan(page, VALID_EAN13);
    await hardwareScan(page, VALID_EAN13);
    await hardwareScan(page, VALID_EAN13);
    await expect(page.getByText(/No product information found/)).toBeVisible();
    await page.waitForTimeout(500);
    expect(posts.n).toBe(1);
    await expect(nameField(page)).toHaveValue("");
  });

  test("E: scan B while A is pending — B wins, A cannot overwrite it", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-replace");
    let first = true;
    await page.route(`**/${businessId}/products/new`, async (route) => {
      if (route.request().method() === "POST" && first) {
        first = false;
        await new Promise((r) => setTimeout(r, 2500)); // hold A's lookup open
      }
      await route.continue();
    });
    await nameField(page).focus();
    await hardwareScan(page, VALID_EAN13); // A (held)
    await hardwareScan(page, STUB_MATCH_PEN); // B
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    await expect(barcodeField(page)).toHaveValue(STUB_MATCH_PEN);
    await page.waitForTimeout(3000); // A's (not-found) response lands late
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    await expect(page.getByText(/No product information found/)).toHaveCount(0);
    await expect(barcodeField(page)).toHaveValue(STUB_MATCH_PEN);
  });

  test("sensitive/unrelated fields: a burst typed into a password field or global inputs is not captured", async ({ page }) => {
    await openNewProduct(page, "e2e-hw-sensitive");
    // Inject a password field into the product form (the real form has none).
    await page.evaluate(() => {
      const form = document.querySelector("form")!;
      const pw = document.createElement("input");
      pw.type = "password";
      pw.setAttribute("aria-label", "Injected password");
      form.appendChild(pw);
    });
    const pw = page.getByLabel("Injected password");
    await pw.focus();
    await hardwareScan(page, VALID_EAN13);
    await expect(pw).toHaveValue(VALID_EAN13);
    await expect(barcodeField(page)).toHaveValue("");
    // Enter in a password field keeps its native behavior (form submit, which
    // fails validation) — the point is that nothing was captured as a scan.
    await page.waitForTimeout(500);
    await expect(page.getByText("Barcode scanned.")).toHaveCount(0);
    await expect(page.getByText(/No product information found|External suggestion/)).toHaveCount(0);
  });

  test("Enter elsewhere on the page is unaffected (normal Enter in a text field, no scan)", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-hw-enter");
    const posts = countLookupPosts(page, businessId);
    await nameField(page).fill("Enter test");
    await nameField(page).focus();
    await page.keyboard.press("Enter"); // native Enter → form submit path, not a lookup
    await page.waitForTimeout(400);
    await expect(page.getByText("Barcode scanned.")).toHaveCount(0);
    expect(posts.n).toBeLessThanOrEqual(1); // a native create-submit (which fails validation) is the only possible POST
  });

  test("J: the camera scanner still works after the hardware detector was added", async ({ page }) => {
    await page.addInitScript(() => {
      let codes: { rawValue: string; format: string }[] = [];
      (window as unknown as { __setScan: (c: typeof codes) => void }).__setScan = (c) => {
        codes = c;
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        canvas.getContext("2d")!.fillRect(0, 0, 640, 480);
        return canvas.captureStream(10);
      };
      class FakeDetector {
        static async getSupportedFormats() {
          return ["ean_13", "ean_8", "upc_a"];
        }
        async detect() {
          return codes;
        }
      }
      (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
    });
    await openNewProduct(page, "e2e-hw-camera");
    await page.getByRole("button", { name: "Scan barcode with camera" }).click();
    await expect(page.getByRole("dialog", { name: "Scan barcode" })).toBeVisible();
    // While the camera dialog is open the keyboard detector is detached.
    await page.evaluate((c) => (window as unknown as { __setScan: (x: unknown) => void }).__setScan(c), [
      { rawValue: STUB_MATCH_PEN, format: "ean_13" },
    ]);
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    // Hardware scanning still works afterwards.
    await barcodeField(page).focus();
    await hardwareScan(page, VALID_EAN13);
    await expect(barcodeField(page)).toHaveValue(VALID_EAN13);
    await expect(page.getByText(/No product information found/)).toBeVisible();
  });

  test("responsive + theme sweep: help note and lookup row fit without overflow (390/430/768/1280/1440, light & dark)", async ({ page }) => {
    await openNewProduct(page, "e2e-hw-responsive");
    const sizes = [
      { name: "390", width: 390, height: 844 },
      { name: "430", width: 430, height: 932 },
      { name: "768", width: 768, height: 1024 },
      { name: "1280", width: 1280, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ];
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const s of sizes) {
        await page.setViewportSize({ width: s.width, height: s.height });
        const help = page.getByText(/Most USB and Bluetooth barcode scanners work automatically/);
        await help.scrollIntoViewIfNeeded();
        await expect(help).toBeVisible();
        await expect(page.getByRole("button", { name: "Look up" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Scan barcode with camera" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: path.join(SHOT_DIR, `1q-e-lookup-${s.name}-${scheme}.png`) });
      }
    }
  });
});
