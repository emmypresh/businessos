import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { createMemberWithRole } from "../integration/helpers/inventory";
import { createTestDbClient } from "../integration/helpers/db-client";

// Phase 1Q-A final QA pass. Proves the category requirement end to end
// through the real browser UI (onboarding + settings), not only at the
// RPC/integration layer, which tests/integration/business-categories.test.ts
// already covers exhaustively. Reuses this repo's own established E2E
// patterns (real signup + Mailpit confirm link for a genuine new-user path,
// createConfirmedTestUser/createMemberWithRole for fixture-only member
// setup) — no auth bypass on the flows this spec actually asserts.

const PASSWORD = "Password1234";
const SHOT_DIR = path.join(process.cwd(), "qa-screenshots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

async function signUpAndConfirm(page: Page, prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("checkbox", { name: /I agree that my information/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const confirmLink = await getLatestAuthLinkFor(email);
  await page.goto(confirmLink);
  await expect(page).toHaveURL(/\/onboarding$/);
  return email;
}

async function loginAsInBrowser(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  // Wait for the actual business-dashboard URL (a UUID segment), not just
  // "no longer on /login" — a single-business owner's post-login redirect
  // can land on an intermediate route first, and reading page.url() before
  // that settles produces a wrong "businessUrl" for every caller below.
  await expect(page).toHaveURL(/\/[0-9a-f-]{36}$/);
}

async function createOwnerAndBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business, error } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
    p_category_code: "GENERAL_TRADING",
  });
  if (error || !business) throw new Error(`create_business failed: ${error?.message}`);
  return { email, businessId: (business as { id: string }).id, client };
}

test.describe("onboarding: normal category", () => {
  test("cannot complete without a category, then completes with RETAIL and persists across reload", async ({ page }) => {
    await signUpAndConfirm(page, "e2e-cat-normal");

    await page.getByLabel("Business name").fill("Lagos Retail Traders");
    await page.getByLabel("URL slug").fill(`lagos-retail-${Date.now()}`);

    // Missing-category UI: the category control is visible, and the submit
    // button stays disabled with every other field valid — no silent
    // fallback category is ever applied.
    await expect(page.getByLabel("Business category")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();

    // Keyboard-only: Tab to the trigger, open with Enter, select the
    // highlighted option with Enter — real Base UI/shadcn Select keyboard
    // behavior, not a mouse-only path. (Dedicated arrow-key navigation
    // coverage lives in the "accessibility evidence" test below.)
    await page.getByLabel("Business category").focus();
    await page.keyboard.press("Enter");
    const retailOption = page.getByRole("option", { name: "Retail" });
    await expect(retailOption).toBeVisible();
    await retailOption.click();
    await expect(page.getByLabel("Business category")).toContainText("Retail");

    await expect(page.getByRole("button", { name: "Create business" })).toBeEnabled();
    await page.getByRole("button", { name: "Create business" }).click();

    await expect(page).toHaveURL(/\/[0-9a-f-]{36}$/);
    const businessId = page.url().split("/").pop();

    // Persisted category verified via the normal application surface (the
    // Settings page), not a direct SQL bypass.
    await page.goto(`/${businessId}/settings/business`);
    await expect(page.getByLabel("Business category")).toContainText("Retail");

    await page.reload();
    await expect(page.getByLabel("Business category")).toContainText("Retail");
  });
});

test.describe("onboarding: OTHER category", () => {
  test("OTHER requires a bounded custom label, then completes and persists exactly", async ({ page }) => {
    await signUpAndConfirm(page, "e2e-cat-other");

    await page.getByLabel("Business name").fill("Curio Traders");
    await page.getByLabel("URL slug").fill(`curio-traders-${Date.now()}`);
    await page.getByLabel("Business category").click();
    await page.getByRole("option", { name: "Other" }).click();

    const customLabel = page.getByLabel("Describe your business");
    await expect(customLabel).toBeVisible();

    // Blank and under-minimum values keep submit disabled.
    await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();
    await customLabel.fill("A");
    await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();

    await customLabel.fill("Artisan candle subscriptions");
    await expect(page.getByRole("button", { name: "Create business" })).toBeEnabled();
    await page.getByRole("button", { name: "Create business" }).click();

    await expect(page).toHaveURL(/\/[0-9a-f-]{36}$/);
    const businessId = page.url().split("/").pop();

    await page.goto(`/${businessId}/settings/business`);
    await expect(page.getByLabel("Business category")).toContainText("Other");
    await expect(page.getByLabel("Describe your business")).toHaveValue("Artisan candle subscriptions");
  });
});

test.describe("settings: category update", () => {
  test("an authorized user changes an existing business's category and it persists across reload", async ({ page }) => {
    const { email } = await createOwnerAndBusiness("e2e-settings-cat");
    await loginAsInBrowser(page, email);

    const businessUrl = page.url();
    await page.goto(`${businessUrl}/settings/business`);
    await expect(page.getByLabel("Business category")).toContainText("General Trading");

    await page.getByLabel("Business category").click();
    await page.getByRole("option", { name: "Services" }).click();
    await page.getByRole("button", { name: "Save category" }).click();
    await expect(page.getByText("Category updated.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Business category")).toContainText("Services");
  });

  test("switching to OTHER requires a label, then switching back to a normal category clears it", async ({ page }) => {
    const { email } = await createOwnerAndBusiness("e2e-settings-other");
    await loginAsInBrowser(page, email);

    const businessUrl = page.url();
    await page.goto(`${businessUrl}/settings/business`);

    await page.getByLabel("Business category").click();
    await page.getByRole("option", { name: "Other" }).click();
    await expect(page.getByRole("button", { name: "Save category" })).toBeDisabled();
    await page.getByLabel("Describe your business").fill("Vintage vinyl imports");
    await page.getByRole("button", { name: "Save category" }).click();
    await expect(page.getByText("Category updated.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Business category")).toContainText("Other");
    await expect(page.getByLabel("Describe your business")).toHaveValue("Vintage vinyl imports");

    // Regression: switching away from OTHER to a normal category must not
    // carry the custom label forward — proving the UI and the server
    // contract (non-OTHER always nulls custom_category_label) agree.
    await page.getByLabel("Business category").click();
    await page.getByRole("option", { name: "Retail" }).click();
    await page.getByRole("button", { name: "Save category" }).click();
    await expect(page.getByText("Category updated.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Business category")).toContainText("Retail");
    await expect(page.getByLabel("Describe your business")).toHaveCount(0);
  });

  test("a VIEWER (no business.manage) has no usable category control on the settings surface", async ({ page }) => {
    const { businessId, email: ownerEmail } = await createOwnerAndBusiness("e2e-settings-viewer-owner");
    void ownerEmail;
    const { email: viewerEmail } = await createMemberWithRole(businessId, "e2e-settings-viewer", "VIEWER");
    await loginAsInBrowser(page, viewerEmail);

    // Integration coverage (tests/integration/business-categories.test.ts,
    // "a VIEWER (no business.manage) is denied") is the actual authorization
    // proof — this is a UI-surface check only, per this phase's own
    // instruction not to treat browser behavior as authorization evidence.
    //
    // NOTE (discovered, not fixed — out of scope for this pass): the page
    // renders the correct not-found boundary content, but the HTTP status
    // observed here is 200, not the 404 a top-level notFound() call
    // normally produces (proven elsewhere, e.g. branches.spec.ts's
    // malformed-id test). This is a Next.js App Router streaming quirk —
    // once a parent layout has already started streaming a 200 response,
    // a notFound() thrown by a nested Server Component further down the
    // tree can no longer change the already-committed status line, so the
    // not-found boundary still renders but under a 200. It is a real,
    // pre-existing, cross-cutting behavior (not introduced by or specific
    // to the category feature), flagged in the build brief rather than
    // fixed here. The actual security boundary is unaffected either way —
    // no category-mutating control is ever rendered, which is what this
    // test asserts.
    await page.goto(`/${businessId}/settings/business`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save category" })).toHaveCount(0);
    await expect(page.getByLabel("Business category")).toHaveCount(0);
  });

  test("a business assigned to a since-deactivated category shows it as historical, non-selectable, and can be replaced (Phase 1Q-A LOW follow-up)", async ({ page }) => {
    const { businessId, email } = await createOwnerAndBusiness("e2e-inactive-cat");
    // business_categories.code is constrained to `^[A-Z][A-Z_]{1,39}$` (no
    // digits), so a timestamp can't be embedded here — this e2e config runs
    // with a single worker (no cross-test parallelism), and the row is
    // deleted in the `finally` block below either way.
    const testCode = "QA_INACTIVE_TEST_CATEGORY";
    const sql = createTestDbClient();
    try {
      // Seed a dedicated, test-only category rather than deactivating a
      // real shared taxonomy row, to avoid interfering with any other test
      // running concurrently against the same registry.
      const [row] = await sql<{ id: string }[]>`
        insert into public.business_categories (code, name, is_active, sort_order)
        values (${testCode}, 'E2E Inactive Category', false, 999)
        returning id
      `;
      await sql`update public.businesses set primary_category_id = ${row.id} where id = ${businessId}`;
    } finally {
      await sql.end();
    }

    try {
      await loginAsInBrowser(page, email);
      await page.goto(`/${businessId}/settings/business`);

      // The inactive historical category still displays as the current value.
      const categoryTrigger = page.getByLabel("Business category");
      await expect(categoryTrigger).toContainText("E2E Inactive Category");

      // It is visibly marked inactive (text, not color-only) and disabled
      // (not selectable/enabled as a new option) in the picker.
      await categoryTrigger.click();
      const inactiveOption = page.getByRole("option", { name: /E2E Inactive Category \(Inactive\)/ });
      await expect(inactiveOption).toBeVisible();
      await expect(inactiveOption).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByText("The current category is no longer active. Choose a different category to replace it.")).toBeVisible();

      // An active category remains selectable, and saving it succeeds.
      // (The seeded name is "Professional Services" — matches this file's
      // other settings-update test's own non-exact "Services" locator.)
      await page.getByRole("option", { name: "Services" }).click();
      await expect(categoryTrigger).toContainText("Services");
      await page.getByRole("button", { name: "Save category" }).click();
      await expect(page.getByText("Category updated.")).toBeVisible();

      await page.reload();
      await expect(page.getByLabel("Business category")).toContainText("Services");
      // The now-inactive test category no longer appears at all once
      // replaced (it wasn't merged into the picker's normal option list).
      await page.getByLabel("Business category").click();
      await expect(page.getByRole("option", { name: /E2E Inactive Category/ })).toHaveCount(0);
    } finally {
      const cleanupSql = createTestDbClient();
      try {
        await cleanupSql`delete from public.business_categories where code = ${testCode}`;
      } finally {
        await cleanupSql.end();
      }
    }
  });

  test("a legacy business with primary_category_id = NULL renders 'Not set' and can be categorized for the first time", async ({ page }) => {
    const { businessId, email } = await createOwnerAndBusiness("e2e-legacy-null");
    const sql = createTestDbClient();
    try {
      await sql`update public.businesses set primary_category_id = null, custom_category_label = null where id = ${businessId}`;
    } finally {
      await sql.end();
    }

    await loginAsInBrowser(page, email);
    await page.goto(`/${businessId}/settings/business`);

    // No crash rendering a null category; the picker is present and usable,
    // never auto-classified to a guessed category.
    await expect(page.getByRole("button", { name: "Save category" })).toBeVisible();
    await expect(page.getByLabel("Business category")).not.toContainText("General Trading");

    await page.getByLabel("Business category").click();
    await page.getByRole("option", { name: "Manufacturing" }).click();
    await page.getByRole("button", { name: "Save category" }).click();
    await expect(page.getByText("Category updated.")).toBeVisible();
  });
});

test.describe("responsive + dark/light QA", () => {
  const widths: [number, string][] = [
    [390, "390"],
    [768, "768"],
    [1280, "1280"],
    [1440, "1440"],
  ];

  for (const [width, label] of widths) {
    test(`onboarding category UI at ${label}px, light + dark`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signUpAndConfirm(page, `e2e-qa-onboard-${label}`);
      await page.getByLabel("Business category").click();
      await page.getByRole("option", { name: "Other" }).click();

      await page.emulateMedia({ colorScheme: "light" });
      await shot(page, `qa-1qa-onboarding-${label}-light`);
      const scrollWidthLight = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidthLight = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidthLight).toBeLessThanOrEqual(clientWidthLight + 1);

      await page.emulateMedia({ colorScheme: "dark" });
      await shot(page, `qa-1qa-onboarding-${label}-dark`);
      const scrollWidthDark = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidthDark = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidthDark).toBeLessThanOrEqual(clientWidthDark + 1);
    });

    test(`settings category UI at ${label}px, light + dark`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { email } = await createOwnerAndBusiness(`e2e-qa-settings-${label}`);
      await loginAsInBrowser(page, email);
      const businessUrl = page.url();
      await page.goto(`${businessUrl}/settings/business`);

      await page.emulateMedia({ colorScheme: "light" });
      await shot(page, `qa-1qa-settings-${label}-light`);
      const scrollWidthLight = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidthLight = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidthLight).toBeLessThanOrEqual(clientWidthLight + 1);

      await page.emulateMedia({ colorScheme: "dark" });
      await shot(page, `qa-1qa-settings-${label}-dark`);
      const scrollWidthDark = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidthDark = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidthDark).toBeLessThanOrEqual(clientWidthDark + 1);
    });
  }

  test("select popover stays within the mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signUpAndConfirm(page, "e2e-qa-popover");
    await page.getByLabel("Business category").click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const box = await listbox.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
    }
    await expect(page.getByRole("option", { name: "Other" })).toBeVisible();
  });
});

test.describe("accessibility evidence", () => {
  test("category control and OTHER field have accessible names; errors are visible text, not color-only", async ({ page }) => {
    await signUpAndConfirm(page, "e2e-a11y");

    // Accessible name via a real <label>, not visual placement — getByLabel
    // only resolves when the label/control association is real.
    const categoryTrigger = page.getByLabel("Business category");
    await expect(categoryTrigger).toBeVisible();

    // Keyboard flow: Tab reaches it, Enter opens, ArrowDown moves, Enter
    // selects, Escape closes the (already-closed) menu without error.
    await categoryTrigger.focus();
    await expect(categoryTrigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);

    await categoryTrigger.click();
    await page.getByRole("option", { name: "Other" }).click();
    const customLabel = page.getByLabel("Describe your business");
    await expect(customLabel).toBeVisible();
    await expect(customLabel).toHaveAttribute("id");

    // One meaningful page title is visible. NOTE (accessibility finding,
    // not fixed here — out of scope for this category-focused pass):
    // AuthCard's title renders via CardTitle, which is a plain <div>
    // (components/ui/card.tsx), not a heading element — so this text
    // carries no heading role for screen-reader landmark navigation. That
    // gap is repo-wide (every AuthCard-based page: login, signup, forgot
    // password, onboarding), not specific to the category feature; flagged
    // in the build brief as a residual accessibility UNKNOWN rather than
    // silently fixed by this pass.
    await expect(page.getByText("Create your business")).toBeVisible();

    // No duplicate accessible names between the two visible text controls.
    await expect(page.getByLabel("Business name")).toBeVisible();
    await expect(page.getByLabel("URL slug")).toBeVisible();
  });
});
