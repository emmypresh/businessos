import { test, expect } from "@playwright/test";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";
import { createConfirmedTestUser } from "../integration/helpers/admin-client";

// These prove the "cannot bypass" property at the level an attacker
// actually has: navigating straight to /reset-password and submitting,
// without ever going through the forgot-password email flow. The page
// itself renders the form regardless (Task 7's design never gated
// rendering on a grant) — the Server Action is the real boundary, and
// these confirm it holds even when reached directly, not just that the
// UI happens to hide a link to get there.

test("an ordinary logged-in session cannot use /reset-password to change its password", async ({ page }) => {
  const email = `bypass-ordinary-${Date.now()}@example.test`;
  const oldPassword = "Password1234";
  await createConfirmedTestUser(email, oldPassword);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // Direct navigation — no recovery email, no grant was ever issued for
  // this session.
  await page.goto("/reset-password");
  await page.getByLabel("New password", { exact: true }).fill("AttackerChosen1");
  await page.getByLabel("Confirm new password").fill("AttackerChosen1");
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(
    page.getByText("This link has expired or was already used.")
  ).toBeVisible();

  // Conclusive proof, not just an error string: the old password still
  // works and the "attacker-chosen" one does not.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test("a signup-confirmation session cannot use /reset-password to change its password", async ({ page }) => {
  const email = `bypass-signup-${Date.now()}@example.test`;
  const password = "Password1234";

  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const confirmLink = await getLatestAuthLinkFor(email);
  await page.goto(confirmLink);
  await expect(page).toHaveURL(/\/onboarding$/);

  // The signup-confirmation flow never calls issue_recovery_grant — this
  // session has claims.amr "otp" (same as a real recovery session would),
  // which is exactly the case the grant mechanism exists to cover.
  await page.goto("/reset-password");
  await page.getByLabel("New password", { exact: true }).fill("AttackerChosen1");
  await page.getByLabel("Confirm new password").fill("AttackerChosen1");
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(
    page.getByText("This link has expired or was already used.")
  ).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});
