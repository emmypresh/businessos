import { test, expect } from "@playwright/test";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";
import { createConfirmedTestUser } from "../integration/helpers/admin-client";

test("forgot password -> reset email -> set new password -> login with new password", async ({
  page,
}) => {
  const email = `reset-${Date.now()}@example.test`;
  await createConfirmedTestUser(email, "OldPassword1");

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const resetLink = await getLatestAuthLinkFor(email);
  await page.goto(resetLink);
  // Proves Amendment 3's fix: a freshly-recovery-authenticated session
  // reaching /reset-password is NOT bounced away by proxy's signed-in
  // redirect rule.
  await expect(page).toHaveURL(/\/reset-password$/);

  await page.getByLabel("New password", { exact: true }).fill("NewPassword1");
  await page.getByLabel("Confirm new password").fill("NewPassword1");
  await page.getByRole("button", { name: "Update password" }).click();
  // Amendment 6's chosen behavior: sign the recovery session out and land
  // on a login success state, not silently into the app.
  await expect(page).toHaveURL(/\/login\?reset=success/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("NewPassword1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});
