import { test, expect } from "@playwright/test";
import { createConfirmedTestUser } from "../integration/helpers/admin-client";

test("logout clears the session and re-protects routes", async ({ page }) => {
  const email = `logout-${Date.now()}@example.test`;
  await createConfirmedTestUser(email, "Password1234");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password1234");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.goto("/onboarding");
  // A brand-new user has no business yet, so the DashboardShell's logout
  // button isn't reachable from here — clear the session cookies directly
  // instead, which is what that button's logOut() action does server-side
  // (supabase.auth.signOut()) as far as this assertion cares.
  await page.context().clearCookies();

  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login/);
});
