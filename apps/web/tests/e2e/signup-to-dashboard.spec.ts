import { test, expect } from "@playwright/test";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";
import { E2E_BASE_URL_PATTERN } from "./e2e-target.mjs";

test("signup -> verify -> login -> create business -> dashboard -> logout", async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.test`;
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

  await page.getByLabel("Business name").fill("Acme Hardware");
  await page.getByLabel("URL slug").fill(`acme-${Date.now()}`);
  await page.getByRole("button", { name: "Create business" }).click();

  // The origin is derived from E2E_BASE_URL (tests/e2e/e2e-target.mjs),
  // not hardcoded — this assertion must hold under any E2E_PORT, not just
  // the default 3100 (see e2e-target.mjs for why the port is overridable).
  // The path/business-id shape (`[0-9a-f-]{36}`) is unchanged — only the
  // origin became configurable.
  await expect(page).toHaveURL(new RegExp(`^${E2E_BASE_URL_PATTERN}/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { name: "Welcome to Acme Hardware" })).toBeVisible();
  await expect(page.getByText("OWNER", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("cell", { name: "OWNER" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login/);
});
