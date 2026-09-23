import { test, expect } from "@playwright/test";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";

// Phase 1Q-0B-0B remediation E2E. Proves, through the real browser UI, that
// the non-NGN activation gate is visible and enforced end to end (not only
// at the RPC/Server Action layers, which the integration suite already
// covers exhaustively), and that the readable currency-name presentation
// (section 15 of the remediation spec) actually renders.
test("onboarding: Nigeria succeeds; Ghana, UK, and US are blocked with the activation-gate copy visible", async ({ page }) => {
  const email = `e2e-country-${Date.now()}@example.test`;
  const password = "Password1234";

  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox", { name: /I agree that my information/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const confirmLink = await getLatestAuthLinkFor(email);
  await page.goto(confirmLink);
  await expect(page).toHaveURL(/\/onboarding$/);

  // Ghana: selectable, shows the readable currency name+symbol, and the
  // Ghanaian Cedi's default timezone, but creation is blocked.
  await page.getByLabel("Business name").fill("Accra Traders");
  await page.getByLabel("URL slug").fill(`accra-${Date.now()}`);
  await page.getByLabel("Country").click();
  await page.getByRole("option", { name: "Ghana (GH)" }).click();
  await expect(page.getByText("Ghanaian Cedi (GH₵)")).toBeVisible();
  await expect(page.getByLabel("Timezone")).toContainText("Accra");
  await expect(page.getByText(/Support for\s+Ghana is being completed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();

  // United Kingdom: British Pound (£), Europe/London, blocked.
  await page.getByLabel("Country").click();
  await page.getByRole("option", { name: "United Kingdom (GB)" }).click();
  await expect(page.getByText("British Pound (£)")).toBeVisible();
  await expect(page.getByLabel("Timezone")).toContainText("London");
  await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();

  // United States: US Dollar ($), a timezone CHOICE (not just New York),
  // blocked.
  await page.getByLabel("Country").click();
  await page.getByRole("option", { name: "United States (US)" }).click();
  await expect(page.getByText("US Dollar ($)")).toBeVisible();
  await page.getByLabel("Timezone").click();
  await expect(page.getByRole("option", { name: "Central Time (Chicago)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Create business" })).toBeDisabled();

  // Nigeria: Nigerian Naira (₦), Africa/Lagos, succeeds.
  await page.getByLabel("Country").click();
  await page.getByRole("option", { name: "Nigeria (NG)" }).click();
  await expect(page.getByText("Nigerian Naira (₦)")).toBeVisible();
  await expect(page.getByLabel("Timezone")).toContainText("Lagos");
  await expect(page.getByRole("button", { name: "Create business" })).toBeEnabled();
  await page.getByRole("button", { name: "Create business" }).click();

  await expect(page).toHaveURL(/\/[0-9a-f-]{36}$/);
  // ArchitectUI dashboard restyle (pre-existing, unrelated WIP) replaced
  // the old "Welcome to {name}" <h1> with a page header whose title is
  // just the business name — see components/dashboard/management-overview.tsx.
  await expect(page.getByRole("heading", { name: "Accra Traders", exact: true })).toBeVisible();
});

test("business settings: country/currency are read-only, timezone is labelled and editable, invalid timezone rejected", async ({ page }) => {
  const email = `e2e-settings-${Date.now()}@example.test`;
  const password = "Password1234";

  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox", { name: /I agree that my information/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const confirmLink = await getLatestAuthLinkFor(email);
  await page.goto(confirmLink);
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByLabel("Business name").fill("Lagos Direct Co");
  await page.getByLabel("URL slug").fill(`lagos-direct-${Date.now()}`);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page).toHaveURL(/\/[0-9a-f-]{36}$/);
  const businessUrl = page.url();
  const businessId = businessUrl.split("/").pop();

  await page.goto(`/${businessId}/settings/business`);
  await expect(page.getByText("Nigeria (NG)")).toBeVisible();
  await expect(page.getByText("Nigerian Naira (₦) (NGN)")).toBeVisible();

  // The timezone Select has a real accessible name via its associated
  // <Label>, not just visual proximity — getByLabel only succeeds when the
  // label/control association is real.
  const timezoneTrigger = page.getByLabel("Business timezone");
  await expect(timezoneTrigger).toBeVisible();
  await expect(timezoneTrigger).toContainText("Lagos");

  await timezoneTrigger.click();
  await page.getByRole("option", { name: "Lagos (WAT)" }).click();
  await page.getByRole("button", { name: "Save timezone" }).click();
  await expect(page.getByText("Timezone updated.")).toBeVisible();
});
