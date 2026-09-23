import { test } from "@playwright/test";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";

// Phase 1Q-0B-0B visual QA (section 23 of the remediation spec). Not
// assertions — this spec exists purely to capture screenshots of the
// onboarding activation-gate state and the Business Settings page at the
// required breakpoints/color-schemes for manual review. Run with
// `npx playwright test tests/e2e/business-country-visual-qa.spec.ts`.
const VIEWPORTS = [
  { name: "390-light", width: 390, height: 844, colorScheme: "light" as const },
  { name: "768-light", width: 768, height: 1024, colorScheme: "light" as const },
  { name: "1440-light", width: 1440, height: 900, colorScheme: "light" as const },
  { name: "1440-dark", width: 1440, height: 900, colorScheme: "dark" as const },
];

for (const vp of VIEWPORTS) {
  test(`onboarding activation gate — ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.emulateMedia({ colorScheme: vp.colorScheme });

    const email = `e2e-visual-${vp.name}-${Date.now()}@example.test`;
    const password = "Password1234";
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("checkbox", { name: /I agree that my information/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    const confirmLink = await getLatestAuthLinkFor(email);
    await page.goto(confirmLink);

    await page.getByLabel("Business name").fill("Visual QA Co");
    await page.getByLabel("URL slug").fill(`visual-qa-${vp.name}-${Date.now()}`);
    await page.getByLabel("Country").click();
    await page.getByRole("option", { name: "Ghana (GH)" }).click();

    await page.screenshot({
      path: `test-results/visual-qa/onboarding-${vp.name}.png`,
      fullPage: true,
    });
  });

  test(`business settings — ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.emulateMedia({ colorScheme: vp.colorScheme });

    const email = `e2e-visual-settings-${vp.name}-${Date.now()}@example.test`;
    const password = "Password1234";
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("checkbox", { name: /I agree that my information/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    const confirmLink = await getLatestAuthLinkFor(email);
    await page.goto(confirmLink);

    await page.getByLabel("Business name").fill("Visual Settings Co");
    await page.getByLabel("URL slug").fill(`visual-settings-${vp.name}-${Date.now()}`);
    await page.getByRole("button", { name: "Create business" }).click();
    await page.waitForURL(/\/[0-9a-f-]{36}$/);
    const businessId = page.url().split("/").pop();

    await page.goto(`/${businessId}/settings/business`);
    await page.screenshot({
      path: `test-results/visual-qa/settings-business-${vp.name}.png`,
      fullPage: true,
    });
  });
}
