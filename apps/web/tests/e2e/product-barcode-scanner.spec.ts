import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

// Phase 1Q-D — mobile camera barcode scanner E2E. No real camera: a
// Playwright init script (test-only, injected per page; nothing ships in the
// app bundle) replaces navigator.mediaDevices.getUserMedia with a canvas
// stream whose tracks count stop() calls, and installs a fake BarcodeDetector
// that returns whatever the test sets via window.__setScan(). Lookup itself
// goes through the real 1Q-C server action + the off-stub provider.

const PASSWORD = "Password1234";
const VALID_EAN13 = "5000112637922";
const STUB_MATCH_PEN = "4006381333931";
const SHOT_DIR = path.join(__dirname, "..", "..", "qa-screenshots");

async function installFakeCamera(page: Page, opts: { deny?: boolean; noDetector?: boolean } = {}) {
  await page.addInitScript((o) => {
    const cam = { opened: 0, stopped: 0, live: 0 };
    (window as unknown as { __cam: typeof cam }).__cam = cam;
    let codes: { rawValue: string; format: string }[] = [];
    (window as unknown as { __setScan: (c: typeof codes) => void }).__setScan = (c) => {
      codes = c;
    };
    navigator.mediaDevices.getUserMedia = async () => {
      if (o.deny) throw new DOMException("denied", "NotAllowedError");
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#335";
      ctx.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(10);
      cam.opened++;
      cam.live++;
      for (const track of stream.getTracks()) {
        const original = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (!stopped) {
            stopped = true;
            cam.stopped++;
            cam.live--;
          }
          original();
        };
      }
      return stream;
    };
    if (!o.noDetector) {
      class FakeDetector {
        static async getSupportedFormats() {
          return ["ean_13", "ean_8", "upc_a", "qr_code"];
        }
        async detect() {
          return codes;
        }
      }
      (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
    } else {
      delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
    }
  }, opts);
}

const setScan = (page: Page, codes: { rawValue: string; format: string }[]) =>
  page.evaluate((c) => (window as unknown as { __setScan: (x: typeof c) => void }).__setScan(c), codes);
const cam = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cam: { opened: number; stopped: number; live: number } }).__cam);

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

async function openNewProduct(page: Page, prefix: string, opts?: Parameters<typeof installFakeCamera>[1]) {
  await installFakeCamera(page, opts);
  const biz = await createBusiness(prefix);
  await login(page, biz.email);
  await page.goto(`/${biz.businessId}/products/new`);
  return biz;
}

const scanButton = (page: Page) => page.getByRole("button", { name: "Scan barcode with camera" });

test.describe("Phase 1Q-D camera barcode scanner", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("A+G: opens scanner with live preview, close stops the camera and returns focus to Scan", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-open");
    await scanButton(page).click();

    const dialog = page.getByRole("dialog", { name: "Scan barcode" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Point the camera at the barcode.")).toBeVisible();
    await expect(dialog.getByTestId("scanner-preview")).toBeVisible();
    expect((await cam(page)).live).toBe(1);

    // No horizontal overflow at 390.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.screenshot({ path: path.join(SHOT_DIR, "1q-d-scanner-390-light.png") });
    await dialog.getByRole("button", { name: "Close scanner" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await cam(page)).live).toBe(0);
    expect((await cam(page)).stopped).toBe(1);
    await expect(scanButton(page)).toBeFocused();
  });

  test("Escape closes the scanner and releases the camera", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-esc");
    await scanButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect.poll(async () => (await cam(page)).live).toBe(0);
  });

  test("B+H: valid scan of a local product runs the lookup once, keeps typed fields, releases the camera", async ({ page }) => {
    const { businessId, client } = await openNewProduct(page, "e2e-scan-local");
    const { data: product } = await client.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Scanned Local Widget",
      p_selling_price: 50,
    });
    await client.rpc("add_product_identifier", {
      p_business_id: businessId,
      p_product_id: product!.id,
      p_identifier_type: "EAN_13",
      p_identifier_value: VALID_EAN13,
    });
    await page.reload();

    let lookupPosts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(`/${businessId}/products/new`)) lookupPosts++;
    });

    await page.getByLabel("Name").fill("Typed Before Scan");
    await page.getByLabel(/Selling price/).fill("75");
    await scanButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // The detector reports the same code on every frame (duplicate detections).
    await setScan(page, [{ rawValue: VALID_EAN13, format: "ean_13" }]);

    await expect(page.getByText(/This barcode already belongs to Scanned Local Widget/)).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(VALID_EAN13);
    await expect(page.getByLabel("Name")).toHaveValue("Typed Before Scan");
    await expect(page.getByLabel(/Selling price/)).toHaveValue("75");
    await expect(page.getByRole("link", { name: "View product" })).toHaveAttribute(
      "href",
      `/${businessId}/products/${product!.id}`
    );
    await expect.poll(async () => (await cam(page)).live).toBe(0);
    // F: repeated identical detections produced exactly one lookup.
    expect(lookupPosts).toBe(1);
  });

  test("C: external candidate is a suggestion; applying is an explicit click", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-ext");
    await scanButton(page).click();
    await setScan(page, [{ rawValue: STUB_MATCH_PEN, format: "ean_13" }]);

    await expect(page.getByText(/External suggestion/)).toBeVisible();
    await expect(page.getByText("Stub Highlighter Pen")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("");
    await page.getByRole("button", { name: "Use product details" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Stub Highlighter Pen");
    await expect(page).toHaveURL(/\/products\/new$/);
    await page.screenshot({ path: path.join(SHOT_DIR, "1q-d-external-390-light.png") });
  });

  test("D: not found keeps the scanned barcode and manual entry continues", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-miss");
    await page.getByLabel("Name").fill("Hand Typed");
    await scanButton(page).click();
    await setScan(page, [{ rawValue: VALID_EAN13, format: "ean_13" }]);

    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(page.getByLabel("Barcode / GTIN")).toHaveValue(VALID_EAN13);
    await expect(page.getByLabel("Name")).toHaveValue("Hand Typed");
    await page.getByLabel("Name").fill("Hand Typed Edited");
    await expect(page.getByLabel("Name")).toHaveValue("Hand Typed Edited");
  });

  test("invalid check digit and QR codes are ignored; no lookup, scanner stays usable", async ({ page }) => {
    const { businessId } = await openNewProduct(page, "e2e-scan-invalid");
    let lookupPosts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(`/${businessId}/products/new`)) lookupPosts++;
    });
    await scanButton(page).click();
    await setScan(page, [{ rawValue: "5000112637921", format: "ean_13" }]);
    await expect(page.getByText(/doesn't look like a valid product barcode/)).toBeVisible();
    await setScan(page, [{ rawValue: "https://example.com", format: "qr_code" }]);
    await page.waitForTimeout(700);
    expect(lookupPosts).toBe(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter barcode manually" })).toBeVisible();
  });

  test("E: permission denied shows a clear message, keeps the form, manual entry works", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-deny", { deny: true });
    await page.getByLabel("Name").fill("Keep Me");
    await scanButton(page).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Camera access was blocked.");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOT_DIR, "1q-d-denied-390-light.png") });
    await dialog.getByRole("button", { name: "Enter barcode manually" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel("Barcode / GTIN")).toBeFocused();
    await page.getByLabel("Barcode / GTIN").fill(VALID_EAN13);
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText(/No product information found/)).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Keep Me");
  });

  test("unsupported browser (no BarcodeDetector): manual-entry message, no camera opened", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-unsupported", { noDetector: true });
    await scanButton(page).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Camera scanning is not supported on this browser. Enter the barcode manually."
    );
    expect((await cam(page)).opened).toBe(0);
  });

  test("viewport sweep: dark mode, tablet, desktop and landscape keep controls reachable without overflow", async ({ page }) => {
    await openNewProduct(page, "e2e-scan-responsive");
    const sizes = [
      { name: "390", width: 390, height: 844 },
      { name: "430", width: 430, height: 932 },
      { name: "768", width: 768, height: 1024 },
      { name: "1280", width: 1280, height: 800 },
      { name: "1440", width: 1440, height: 900 },
      { name: "landscape-844x390", width: 844, height: 390 },
    ];
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const s of sizes) {
        await page.setViewportSize({ width: s.width, height: s.height });
        await scanButton(page).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("Point the camera at the barcode.")).toBeVisible();
        const close = dialog.getByRole("button", { name: "Close scanner" });
        await close.scrollIntoViewIfNeeded();
        await expect(close).toBeInViewport();
        const box = (await close.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOT_DIR, `1q-d-scanner-${s.name}-${scheme}.png`) });
        await close.click();
        await expect(dialog).toBeHidden();
        await expect.poll(async () => (await cam(page)).live).toBe(0);
      }
    }
  });
});
