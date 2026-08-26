import { test, expect } from "@playwright/test";
import {
  createConfirmedTestUser,
  createUserClient,
} from "../integration/helpers/admin-client";

/**
 * The full tenant-isolation matrix, not just one direction: User A -> B's
 * business, User B -> A's business, and a random UUID that isn't a real
 * business at all — all three must produce the exact same externally
 * visible 404, so a user probing another tenant's businessId (or just
 * guessing UUIDs) can never distinguish "doesn't exist" from "exists but
 * you're not a member."
 */

async function loginAsInBrowser(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  // Wait for the login redirect to actually complete before navigating
  // away again — otherwise a later page.goto() can race the in-flight
  // Server Action redirect and cancel it.
  await expect(page).not.toHaveURL(/\/login/);
}

async function expectDeniedAsGenericNotFound(page: import("@playwright/test").Page, businessId: string) {
  await page.goto(`/${businessId}`);
  // Next's notFound() renders the not-found UI without changing the URL.
  await expect(page.getByText("Not found")).toBeVisible();
  await expect(
    page.getByText("This page doesn't exist, or you don't have access to it.")
  ).toBeVisible();
}

test.describe("cross-tenant route protection: full matrix", () => {
  const password = "Password1234";
  let businessAId: string;
  let businessBId: string;
  let emailA: string;
  let emailB: string;

  test.beforeAll(async () => {
    const suffix = Date.now();
    emailA = `tenant-a-${suffix}@example.test`;
    emailB = `tenant-b-${suffix}@example.test`;

    await createConfirmedTestUser(emailA, password);
    const clientA = createUserClient();
    await clientA.auth.signInWithPassword({ email: emailA, password });
    const { data: businessA, error: errorA } = await clientA.rpc("create_business", {
      p_name: "Tenant A",
      p_slug: `tenant-a-${suffix}`,
    });
    if (errorA || !businessA) throw new Error(`Failed to create Tenant A: ${errorA?.message}`);
    businessAId = businessA.id;

    await createConfirmedTestUser(emailB, password);
    const clientB = createUserClient();
    await clientB.auth.signInWithPassword({ email: emailB, password });
    const { data: businessB, error: errorB } = await clientB.rpc("create_business", {
      p_name: "Tenant B",
      p_slug: `tenant-b-${suffix}`,
    });
    if (errorB || !businessB) throw new Error(`Failed to create Tenant B: ${errorB?.message}`);
    businessBId = businessB.id;
  });

  test("User A -> Business B's route: denied (generic 404)", async ({ page }) => {
    await loginAsInBrowser(page, emailA, password);
    await expectDeniedAsGenericNotFound(page, businessBId);
  });

  test("User B -> Business A's route: denied (generic 404)", async ({ page }) => {
    await loginAsInBrowser(page, emailB, password);
    await expectDeniedAsGenericNotFound(page, businessAId);
  });

  test("authenticated user -> a random, nonexistent businessId: same generic 404 (no disclosure)", async ({ page }) => {
    await loginAsInBrowser(page, emailA, password);
    await expectDeniedAsGenericNotFound(page, "ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  test("User A -> Business A's route: allowed (sanity check the matrix isn't just denying everything)", async ({ page }) => {
    await loginAsInBrowser(page, emailA, password);
    await page.goto(`/${businessAId}`);
    await expect(page.getByRole("heading", { name: "Welcome to Tenant A" })).toBeVisible();
  });

  // The denial tests above only prove A can't reach B's route and B can't
  // reach A's — on their own that's also consistent with a broken policy
  // that denies everyone everything. This closes that gap from B's side
  // specifically (A's own-business access is covered by the test above):
  // B must be able to reach its own business, not just be blocked from A's.
  test("User B -> Business B's route: allowed (sanity check the matrix isn't just denying everything)", async ({ page }) => {
    await loginAsInBrowser(page, emailB, password);
    await page.goto(`/${businessBId}`);
    await expect(page.getByRole("heading", { name: "Welcome to Tenant B" })).toBeVisible();
  });
});
