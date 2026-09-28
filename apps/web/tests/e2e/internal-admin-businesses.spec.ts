import { test, expect } from "@playwright/test";
import {
  createConfirmedTestUser,
  createUserClient,
} from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";
import { addMemberWithRole } from "../integration/helpers/inventory";
import { computeTotp } from "../integration/helpers/mfa";

// Phase 1O-B. Proves the full browser-facing path for the read-only
// business directory, not just the server-side RPC authorization already
// covered by tests/integration/platform-business-directory.test.ts: a
// real platform admin reaches the directory, searches it, opens a
// business's detail view, and a tenant OWNER/ADMIN is denied exactly like
// every other /internal/admin route (tests/e2e/internal-admin.spec.ts).

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function insertPlatformAdmin(userId: string, role: string) {
  const sql = createTestDbClient();
  try {
    await sql`
      insert into public.platform_admins (user_id, role, is_active)
      values (${userId}, ${role}, true)
    `;
  } finally {
    await sql.end();
  }
}

async function elevateBrowserToAal2(page: import("@playwright/test").Page) {
  await page.goto("/internal/admin");
  await expect(page).toHaveURL(/\/internal\/admin\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  await expect(page.getByAltText("Authenticator app QR code")).toBeVisible();
  const secret = (await page.locator("code").innerText()).trim();
  const code = computeTotp(secret);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page).toHaveURL(/\/internal\/admin$/);
}

test.describe("/internal/admin/businesses", () => {
  test("an authorized platform admin opens the directory, searches, and opens a business's detail view", async ({
    page,
  }) => {
    const suffix = Date.now();
    const adminEmail = `dir-e2e-admin-${suffix}@example.test`;
    const admin = await createConfirmedTestUser(adminEmail, PASSWORD);
    await insertPlatformAdmin(admin.id, "SUPER_ADMIN");

    const ownerEmail = `dir-e2e-owner-${suffix}@example.test`;
    await createConfirmedTestUser(ownerEmail, PASSWORD);
    const ownerClient = createUserClient();
    await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
    const uniqueName = `E2E Directory Target ${suffix}`;
    const { error } = await ownerClient.rpc("create_business", {
      p_name: uniqueName,
      p_slug: `e2e-directory-target-${suffix}`,
    });
    expect(error).toBeNull();

    await loginAsInBrowser(page, adminEmail, PASSWORD);
    await elevateBrowserToAal2(page);

    await page.getByRole("link", { name: "Businesses" }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/businesses$/);
    await expect(page.getByRole("heading", { name: "Businesses" })).toBeVisible();

    await page.getByLabel("Search businesses by name or slug").fill(uniqueName);
    await expect(page.getByRole("link", { name: uniqueName })).toBeVisible();

    await page.getByRole("link", { name: uniqueName }).click();
    await expect(page).toHaveURL(/\/internal\/admin\/businesses\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: uniqueName })).toBeVisible();

    const overviewCard = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "Overview" }),
    });
    await expect(overviewCard.getByText(ownerEmail)).toBeVisible();
  });

  test("a tenant OWNER is denied the directory as a generic 404", async ({ page }) => {
    const suffix = Date.now();
    const email = `dir-e2e-tenant-owner-${suffix}@example.test`;
    await createConfirmedTestUser(email, PASSWORD);
    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: PASSWORD });
    const { error } = await client.rpc("create_business", {
      p_name: "Denied Owner Co",
      p_slug: `dir-e2e-denied-owner-${suffix}`,
    });
    expect(error).toBeNull();

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto("/internal/admin/businesses");
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a tenant ADMIN is denied the directory as a generic 404", async ({ page }) => {
    const suffix = Date.now();
    const ownerEmail = `dir-e2e-tenant-admin-owner-${suffix}@example.test`;
    const adminEmail = `dir-e2e-tenant-admin-${suffix}@example.test`;
    await createConfirmedTestUser(ownerEmail, PASSWORD);
    const ownerClient = createUserClient();
    await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
    const { data: business, error } = await ownerClient.rpc("create_business", {
      p_name: "Denied Admin Co",
      p_slug: `dir-e2e-denied-admin-${suffix}`,
    });
    expect(error).toBeNull();

    const adminUser = await createConfirmedTestUser(adminEmail, PASSWORD);
    await addMemberWithRole(business!.id, adminUser.id, "ADMIN");

    await loginAsInBrowser(page, adminEmail, PASSWORD);
    await page.goto("/internal/admin/businesses");
    await expect(page.getByText("Not found")).toBeVisible();
  });
});
