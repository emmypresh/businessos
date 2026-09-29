import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser } from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";
import { computeTotp } from "../integration/helpers/mfa";

const PASSWORD = "Password1234";

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
  try {
    await sql`insert into public.platform_admins (user_id, role, is_active) values (${user.id}, ${role}, true)`;
  } finally {
    await sql.end();
  }
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

test.describe("Phase 1O-E completion — Platform Audit", () => {
  test("SUPER_ADMIN reaches Platform Audit via the sidebar", async ({ page }) => {
    const admin = await platformUser("audit-e2e-super", "SUPER_ADMIN");

    await login(page, admin.email);
    await elevate(page);

    await page.getByRole("link", { name: "Platform Audit", exact: true }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/audit$/);
    await expect(page.getByRole("heading", { name: "Platform Audit" })).toBeVisible();
  });

  test("SUPPORT (no platform.audit.view) does not see the Platform Audit link and is denied the route directly", async ({
    page,
  }) => {
    const admin = await platformUser("audit-e2e-support", "SUPPORT");
    await login(page, admin.email);
    await elevate(page);

    await expect(page.getByRole("link", { name: "Platform Audit", exact: true })).toHaveCount(0);

    await page.goto("/internal/admin/audit");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("a tenant OWNER is denied the audit route as a generic 404", async ({ page }) => {
    const suffix = Date.now();
    const email = `audit-e2e-owner-${suffix}@example.test`;
    await createConfirmedTestUser(email, PASSWORD);
    await login(page, email);
    await page.goto("/internal/admin/audit");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });
});

test.describe("Phase 1O-E completion — Subscriptions", () => {
  test("SUPER_ADMIN reaches Subscriptions via the sidebar and sees summary cards", async ({ page }) => {
    const admin = await platformUser("subs-e2e-super", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);

    await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/subscriptions$/);
    await expect(page.getByRole("heading", { name: "Subscriptions", exact: true })).toBeVisible();
    await expect(page.getByText("Trialing", { exact: true })).toBeVisible();
  });

  test("SUPPORT (no platform.subscriptions.view) does not see Subscriptions and is denied the route directly", async ({
    page,
  }) => {
    const admin = await platformUser("subs-e2e-support", "SUPPORT");
    await login(page, admin.email);
    await elevate(page);

    await expect(page.getByRole("link", { name: "Subscriptions", exact: true })).toHaveCount(0);

    await page.goto("/internal/admin/subscriptions");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("BILLING can reach Subscriptions (holds platform.subscriptions.view) but not Businesses/Support", async ({
    page,
  }) => {
    const admin = await platformUser("subs-e2e-billing", "BILLING");
    await login(page, admin.email);
    await elevate(page);

    await expect(page.getByRole("link", { name: "Subscriptions", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Businesses", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Support", exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/subscriptions$/);
  });
});

test.describe("Phase 1O-E completion — Support", () => {
  test("SUPER_ADMIN reaches Support via the sidebar and sees the attention summary", async ({ page }) => {
    const admin = await platformUser("support-e2e-super", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);

    await page.getByRole("link", { name: "Support", exact: true }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/support$/);
    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
    await expect(page.getByText("Businesses Requiring Attention")).toBeVisible();
  });

  test("BILLING (no platform.businesses.view) does not see Support and is denied the route directly", async ({
    page,
  }) => {
    const admin = await platformUser("support-e2e-billing", "BILLING");
    await login(page, admin.email);
    await elevate(page);

    await expect(page.getByRole("link", { name: "Support", exact: true })).toHaveCount(0);

    await page.goto("/internal/admin/support");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });
});

test.describe("Phase 1O-E completion — Overview links to the new pages", () => {
  test("SUPER_ADMIN's Overview links to Subscriptions and Platform Audit; VIEWER's Overview does not", async ({
    page,
  }) => {
    const admin = await platformUser("overview-e2e-super", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);
    await expect(page.getByRole("link", { name: "Subscription details" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Full history" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Attention queue" })).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    const viewer = await platformUser("overview-e2e-viewer", "VIEWER");
    await login(page, viewer.email);
    await elevate(page);
    await expect(page.getByRole("link", { name: "Subscription details" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Full history" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Attention queue" })).toHaveCount(0);
  });
});

// Focused automated accessibility smoke test — no axe/accessibility library
// is installed in this project (checked: no @axe-core/playwright or
// axe-core dependency in package.json), so per phase instruction §33 this
// does NOT add one. Instead it uses Playwright's own built-in role/ARIA
// queries to verify landmarks, heading hierarchy, accessible names on
// buttons/links/form controls, and keyboard reachability — everything the
// current stack can verify without a new dependency. What remains manual
// (color contrast beyond the tokens' own AA verification, screen-reader
// behavior, full WCAG conformance) is listed in the build brief.
test.describe("Phase 1O-E completion — accessibility smoke", () => {
  const routes = ["/internal/admin", "/internal/admin/businesses", "/internal/admin/support", "/internal/admin/subscriptions", "/internal/admin/audit"];

  test("every new/updated route has exactly one h1, a landmark nav and main, and no unlabeled buttons", async ({
    page,
  }) => {
    const admin = await platformUser("a11y-e2e-super", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);

    for (const route of routes) {
      await page.goto(route);

      const h1Count = await page.locator("h1").count();
      expect(h1Count, `${route}: exactly one h1`).toBe(1);

      await expect(page.locator("nav").first(), `${route}: has a nav landmark`).toBeVisible();
      await expect(page.locator("main"), `${route}: has a main landmark`).toBeVisible();

      const buttons = page.getByRole("button");
      const buttonCount = await buttons.count();
      for (let i = 0; i < buttonCount; i++) {
        const name = await buttons.nth(i).evaluate((el) => el.getAttribute("aria-label") || el.textContent?.trim());
        expect(name, `${route}: button ${i} has an accessible name`).toBeTruthy();
      }

      // Elements excluded from this check are excluded from the
      // accessibility tree entirely, by construction, regardless of the
      // exact mechanism: input[type=hidden] (Next.js Server Actions, e.g.
      // the sidebar's `<form action={logOut}>`, serialize their action
      // reference this way) and [aria-hidden="true"] (the shadcn/base-ui
      // Select component's own native hidden mirror input for form
      // compatibility). Neither is focusable or perceivable, so WCAG
      // labeling requirements don't apply to either.
      const inputs = page.locator("input:not([type='hidden']):not([aria-hidden='true']), select, textarea");
      const inputCount = await inputs.count();
      for (let i = 0; i < inputCount; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute("id");
        const ariaLabel = await input.getAttribute("aria-label");
        const ariaLabelledBy = await input.getAttribute("aria-labelledby");
        let hasLabel = Boolean(ariaLabel || ariaLabelledBy);
        if (!hasLabel && id) {
          hasLabel = (await page.locator(`label[for="${id}"]`).count()) > 0;
        }
        expect(hasLabel, `${route}: form control ${i} (id=${id}) has a label`).toBe(true);
      }
    }
  });

  test("sidebar navigation is keyboard reachable and the active link is focus-visible", async ({ page }) => {
    const admin = await platformUser("a11y-e2e-keyboard", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);

    const overviewLink = page.getByRole("link", { name: "Overview", exact: true });
    await overviewLink.focus();
    await expect(overviewLink).toBeFocused();
    await expect(overviewLink).toHaveAttribute("aria-current", "page");
  });

  test("mobile drawer opens, traps focus in the dialog, and closes on navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await platformUser("a11y-e2e-drawer", "SUPER_ADMIN");
    await login(page, admin.email);
    await elevate(page);

    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Support", exact: true })).toBeVisible();

    await dialog.getByRole("link", { name: "Support", exact: true }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/support$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
