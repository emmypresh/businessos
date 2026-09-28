import { test, expect } from "@playwright/test";
import {
  createConfirmedTestUser,
  createUserClient,
} from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";
import { addMemberWithRole } from "../integration/helpers/inventory";
import { computeTotp } from "../integration/helpers/mfa";

// Phase 1O-A. Proves the full browser-facing path, not just the server-side
// authorization functions already covered by
// tests/integration/platform-admin-security.test.ts: a real platform admin
// reaches the internal shell, a real tenant OWNER/ADMIN is denied with the
// same generic 404 cross-tenant-access.spec.ts already asserts for tenant
// routes, and an anonymous visitor is redirected to /login rather than ever
// seeing internal-admin content.

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

test.describe("/internal/admin authorization", () => {
  test("anonymous visitor is redirected to /login, never sees internal-admin content", async ({ page }) => {
    await page.goto("/internal/admin");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Internal Administration")).not.toBeVisible();
  });

  test("a tenant OWNER with no platform_admins row is denied as a generic 404", async ({ page }) => {
    const suffix = Date.now();
    const email = `internal-owner-${suffix}@example.test`;
    await createConfirmedTestUser(email, PASSWORD);
    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: PASSWORD });
    const { error } = await client.rpc("create_business", {
      p_name: "Owner Co",
      p_slug: `owner-co-${suffix}`,
    });
    expect(error).toBeNull();

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto("/internal/admin");
    await expect(page.getByText("Not found")).toBeVisible();
    await expect(
      page.getByText("This page doesn't exist, or you don't have access to it.")
    ).toBeVisible();
  });

  test("a tenant ADMIN with no platform_admins row is denied as a generic 404", async ({ page }) => {
    const suffix = Date.now();
    const ownerEmail = `internal-owner2-${suffix}@example.test`;
    const adminEmail = `internal-admin-${suffix}@example.test`;
    await createConfirmedTestUser(ownerEmail, PASSWORD);
    const ownerClient = createUserClient();
    await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: PASSWORD });
    const { data: business, error } = await ownerClient.rpc("create_business", {
      p_name: "Admin Co",
      p_slug: `admin-co-${suffix}`,
    });
    expect(error).toBeNull();

    const adminUser = await createConfirmedTestUser(adminEmail, PASSWORD);
    await addMemberWithRole(business!.id, adminUser.id, "ADMIN");

    await loginAsInBrowser(page, adminEmail, PASSWORD);
    await page.goto("/internal/admin");
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("an active platform SUPER_ADMIN at AAL1 is redirected to the MFA challenge, never sees the console", async ({ page }) => {
    const suffix = Date.now();
    const email = `internal-super-aal1-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    await insertPlatformAdmin(user.id, "SUPER_ADMIN");

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto("/internal/admin");
    await expect(page).toHaveURL(/\/internal\/admin\/mfa$/);
    await expect(page.getByText("Internal Administration")).not.toBeVisible();
    await expect(page.getByText("Verify it's you")).toBeVisible();
  });

  test("a tenant OWNER visiting the MFA challenge route directly is denied as a generic 404, never sees enrollment UI", async ({ page }) => {
    const suffix = Date.now();
    const email = `internal-mfa-owner-${suffix}@example.test`;
    await createConfirmedTestUser(email, PASSWORD);
    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password: PASSWORD });
    const { error } = await client.rpc("create_business", {
      p_name: "Owner Co",
      p_slug: `mfa-owner-co-${suffix}`,
    });
    expect(error).toBeNull();

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto("/internal/admin/mfa");
    await expect(page.getByText("Not found")).toBeVisible();
    await expect(page.getByText("Set up authenticator app")).not.toBeVisible();
  });

  test("an active platform SUPER_ADMIN who enrolls and verifies a real TOTP factor reaches AAL2 and the internal shell", async ({ page }) => {
    const suffix = Date.now();
    const email = `internal-super-aal2-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    await insertPlatformAdmin(user.id, "SUPER_ADMIN");

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto("/internal/admin");
    await expect(page).toHaveURL(/\/internal\/admin\/mfa$/);

    await page.getByRole("button", { name: "Set up authenticator app" }).click();
    await expect(page.getByAltText("Authenticator app QR code")).toBeVisible();

    const secret = (await page.locator("code").innerText()).trim();
    const code = computeTotp(secret);

    await page.getByLabel("6-digit code").fill(code);
    await page.getByRole("button", { name: "Verify and enable" }).click();

    await expect(page).toHaveURL(/\/internal\/admin$/);
    await expect(page.getByText("Internal Administration")).toBeVisible();
    await expect(page.getByText("SUPER_ADMIN")).toBeVisible();
  });
});
