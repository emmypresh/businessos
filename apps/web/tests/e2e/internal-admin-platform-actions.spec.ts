import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser } from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";
import { createOwnerAndBusiness } from "../integration/helpers/inventory";
import { computeTotp } from "../integration/helpers/mfa";
import { E2E_BASE_URL } from "./e2e-target.mjs";

const PASSWORD = "Password1234";
const REASON = "Browser QA verifies this controlled action safely.";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function platformUser(prefix: string, role: "SUPER_ADMIN" | "OPERATIONS" | "BILLING" | "SUPPORT" | "VIEWER") {
  const email = `${prefix}-${Date.now()}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const sql = createTestDbClient();
  try { await sql`insert into public.platform_admins (user_id, role, is_active) values (${user.id}, ${role}, true)`; }
  finally { await sql.end(); }
  return { email };
}

async function elevate(page: Page) {
  await page.goto("/internal/admin");
  await expect(page).toHaveURL(/\/internal\/admin\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("code").innerText()).trim();
  await page.getByLabel("6-digit code").fill(computeTotp(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page).toHaveURL(/\/internal\/admin$/);
}

test.describe("Phase 1O-D controlled actions", () => {
  test("SUPER_ADMIN suspends, reactivates, and extends a real trial through the browser", async ({ page, browser }) => {
    const admin = await platformUser("actions-super", "SUPER_ADMIN");
    const owner = await createOwnerAndBusiness(`actions-target-${Date.now()}`);
    await login(page, admin.email); await elevate(page);
    await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=actions`);
    await expect(page.getByText("Platform Actions", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend business" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Extend trial" })).toBeVisible();

    await page.getByRole("button", { name: "Suspend business" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("actions-target");
    await expect(dialog.getByLabel("Reason")).toBeVisible();
    await dialog.getByLabel("Reason").fill("   ");
    await expect(
      dialog.getByLabel("Reason").evaluate((element) => (element as HTMLTextAreaElement).checkValidity())
    ).resolves.toBe(false);
    await dialog.getByLabel("Reason").fill(REASON);
    await dialog.getByRole("button", { name: "Suspend business" }).click();
    // The server action revalidates the page, so the dialog closes and the
    // refreshed status/history are the rendered success state.
    await expect(page.getByText("suspended", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Platform action history" })).toContainText("Suspended business");

    // A tenant session loses only this business, while platform support keeps visibility.
    const tenantContext = await browser.newContext({ baseURL: E2E_BASE_URL });
    const tenantPage = await tenantContext.newPage();
    await login(tenantPage, owner.email);
    await tenantPage.goto(`/${owner.businessId}`);
    await expect(tenantPage.getByText("Something went wrong loading this business.", { exact: true })).toBeVisible();
    await tenantContext.close();
    await page.getByRole("button", { name: "Reactivate business" }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill(REASON);
    await page.getByRole("dialog").getByRole("button", { name: "Reactivate business" }).click();
    await expect(page.getByText("active", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Platform action history" })).toContainText("Reactivated business");

    const restoredTenantContext = await browser.newContext({ baseURL: E2E_BASE_URL });
    const restoredTenantPage = await restoredTenantContext.newPage();
    await login(restoredTenantPage, owner.email);
    await restoredTenantPage.goto(`/${owner.businessId}`);
    await expect(restoredTenantPage.getByText("Not found")).toHaveCount(0);
    await restoredTenantContext.close();

    await page.getByRole("button", { name: "Extend trial" }).click();
    const trial = page.getByRole("dialog");
    await expect(trial.getByLabel("Days to add")).toBeVisible();
    await expect(trial.getByText("New trial end:")).toBeVisible();
    await trial.getByLabel("Days to add").fill("0");
    await trial.getByLabel("Reason").fill(REASON);
    await expect(
      trial.getByLabel("Days to add").evaluate((element) => (element as HTMLInputElement).checkValidity())
    ).resolves.toBe(false);
    await trial.getByLabel("Days to add").fill("7");
    await trial.getByRole("button", { name: "Extend trial" }).click();
    await expect(trial.getByRole("status")).toContainText("Extended.");
    await trial.getByRole("button", { name: "Close" }).click();
    await page.reload();
    await expect(page.getByRole("table", { name: "Platform action history" })).toContainText("Extended trial");
  });

  test("role UI exposes only its mapped controlled actions", async ({ page }) => {
    const target = await createOwnerAndBusiness(`actions-roles-${Date.now()}`);
    // Phase 1O-D remediation: BILLING holds platform.subscriptions.extend_trial
    // but not platform.businesses.view, so the OLD "?tab=actions" route
    // (gated on businesses.view at the page shell) structurally 404s for it
    // — that IS the bug this remediation fixes. BILLING reaches the same
    // ActionsTab content through the new dedicated
    // /internal/admin/businesses/[businessId]/actions route instead; every
    // other role here already holds businesses.view (1O-A's own matrix) and
    // continues to use the pre-existing support-console tab.
    for (const [role, expected] of [
      ["OPERATIONS", ["Suspend business"]],
      ["BILLING", ["Extend trial"]],
      ["SUPPORT", []], ["VIEWER", []],
    ] as const) {
      const user = await platformUser(`actions-${role.toLowerCase()}`, role);
      await login(page, user.email); await elevate(page);
      const path =
        role === "BILLING"
          ? `/internal/admin/businesses/${target.businessId}/actions`
          : `/internal/admin/businesses/${target.businessId}?tab=actions`;
      await page.goto(path);
      for (const label of ["Suspend business", "Reactivate business", "Extend trial"] as const) {
        await expect(page.getByRole("button", { name: label })).toHaveCount((expected as readonly string[]).includes(label) ? 1 : 0);
      }
      await page.context().clearCookies();
    }
  });

  test("BILLING cannot reach the normal support console, but can reach the dedicated actions route and complete a trial extension", async ({ page }) => {
    const admin = await platformUser("actions-billing-route", "BILLING");
    const owner = await createOwnerAndBusiness(`actions-billing-target-${Date.now()}`);
    await login(page, admin.email);
    await elevate(page);

    // Regression: platform.businesses.view was never granted to BILLING —
    // the normal support console still denies it (404, not a distinguishable
    // "access denied" page, per the platform-admin no-enumeration convention).
    await page.goto(`/internal/admin/businesses/${owner.businessId}`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

    // The dedicated route admits BILLING (it holds
    // platform.subscriptions.extend_trial) and shows only Extend trial —
    // never Suspend/Reactivate, which BILLING has no permission for.
    await page.goto(`/internal/admin/businesses/${owner.businessId}/actions`);
    await expect(page.getByRole("button", { name: "Extend trial" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend business" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reactivate business" })).toHaveCount(0);

    const trial = page.getByRole("dialog");
    await page.getByRole("button", { name: "Extend trial" }).click();
    await expect(trial.getByLabel("Days to add")).toBeVisible();
    await trial.getByLabel("Days to add").fill("5");
    await trial.getByLabel("Reason").fill(REASON);
    await trial.getByRole("button", { name: "Extend trial" }).click();
    await expect(trial.getByRole("status")).toContainText("Extended.");
  });

  test("BILLING's action lookup requires a search and never shows a browseable global list", async ({ page }) => {
    const admin = await platformUser("actions-billing-lookup", "BILLING");
    const target = await createOwnerAndBusiness(`actions-lookup-target-${Date.now()}`);
    await createOwnerAndBusiness(`actions-lookup-unrelated-${Date.now()}`);
    await login(page, admin.email);
    await elevate(page);

    // No browseable global list on first load — must enter a search.
    await page.goto("/internal/admin/actions");
    await expect(page.getByText(/Enter at least \d+ characters/)).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);

    // A literal `%` search must not wildcard-expand into every business.
    await page.getByLabel("Search by business name").fill("%");
    await page.getByLabel("Search by business name").press("Enter");
    await expect(page.getByText(/Enter at least \d+ characters/)).toBeVisible();

    // Searching for the intended business surfaces it and only it.
    await page.getByLabel("Search by business name").fill("actions-lookup-target");
    await page.getByLabel("Search by business name").press("Enter");
    await expect(page.getByRole("link", { name: "Open actions" })).toHaveCount(1);
    await expect(page.getByText("actions-lookup-target", { exact: false })).toBeVisible();
    await expect(page.getByText("actions-lookup-unrelated", { exact: false })).toHaveCount(0);

    // Extend Trial remains usable from the lookup result.
    await page.getByRole("link", { name: "Open actions" }).click();
    await expect(page.getByRole("button", { name: "Extend trial" })).toBeVisible();

    // Normal support console remains denied for BILLING.
    await page.goto(`/internal/admin/businesses/${target.businessId}`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("Platform Actions is responsive, dark-safe, and keyboard-accessible", async ({ page }) => {
    const admin = await platformUser("actions-visual", "SUPER_ADMIN");
    const owner = await createOwnerAndBusiness(`actions-visual-target-${Date.now()}`);
    await login(page, admin.email);
    await elevate(page);

    for (const [width, height] of [
      [390, 844],
      [768, 900],
      [1280, 900],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=actions`);
      await expect(page.getByText("Platform Actions", { exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.screenshot({ path: `qa-1od-actions-${width}.png`, fullPage: true });
    }

    await expect(
      page.getByRole("navigation", { name: "Business support sections" }).getByRole("link", {
        name: "Platform Actions",
        exact: true,
      })
    ).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "Suspend business" }).focus();
    await expect(page.getByRole("button", { name: "Suspend business" })).toBeFocused();
    await page.getByRole("button", { name: "Suspend business" }).press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /Suspend/ })).toBeVisible();
    await expect(dialog.getByLabel("Reason")).toBeVisible();
    await expect(dialog).toContainText("This immediately blocks every tenant member");
    await expect(dialog.evaluate((element) => element.contains(document.activeElement))).resolves.toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=actions`);
      await page.getByRole("button", { name: "Suspend business" }).click();
      await expect(page.getByRole("dialog").getByLabel("Reason")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.screenshot({ path: `qa-1od-suspend-dark-${width}.png`, fullPage: true });
      await page.keyboard.press("Escape");
    }
  });
});
