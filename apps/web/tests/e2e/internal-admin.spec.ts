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
    // Scoped to the heading role (not a bare getByText) — Phase 1O-E gave
    // this page's title a real <h1> (matching the rest of the app's own
    // convention; see components/platform/platform-primitives.tsx), and
    // Next.js's route announcer mirrors an h1's exact text into a second,
    // screen-reader-only element on every navigation, which made the
    // previous bare getByText("Internal Administration") ambiguous
    // (2 matches) the moment a real h1 with that exact text existed.
    await expect(page.getByRole("heading", { name: "Internal Administration" })).toBeVisible();
    await expect(page.getByText("SUPER_ADMIN")).toBeVisible();
  });

  // Phase 1O-E remediation (Codex finding, LOW): the Support page's
  // diagnostic badge previously conveyed severity through color alone,
  // with only the diagnostic code as visible text. Proves the fix in the
  // real browser: a WARNING diagnostic (a business with no active branch)
  // and an INFO diagnostic (a business with a recent WhatsApp failure)
  // both render their severity as visible text, not merely a CSS class.
  test("Support page renders diagnostic severity as visible text, not color alone", async ({ page }) => {
    const suffix = Date.now();
    const email = `internal-support-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    await insertPlatformAdmin(user.id, "SUPER_ADMIN");

    const warningOwnerEmail = `internal-support-warn-${suffix}@example.test`;
    await createConfirmedTestUser(warningOwnerEmail, PASSWORD);
    const warningClient = createUserClient();
    await warningClient.auth.signInWithPassword({ email: warningOwnerEmail, password: PASSWORD });
    const { data: warningBusiness, error: warningError } = await warningClient.rpc("create_business", {
      p_name: `Support Warning Co ${suffix}`,
      p_slug: `support-warn-co-${suffix}`,
    });
    expect(warningError).toBeNull();

    const infoOwnerEmail = `internal-support-info-${suffix}@example.test`;
    const infoOwner = await createConfirmedTestUser(infoOwnerEmail, PASSWORD);
    const infoClient = createUserClient();
    await infoClient.auth.signInWithPassword({ email: infoOwnerEmail, password: PASSWORD });
    const { data: infoBusiness, error: infoError } = await infoClient.rpc("create_business", {
      p_name: `Support Info Co ${suffix}`,
      p_slug: `support-info-co-${suffix}`,
    });
    expect(infoError).toBeNull();

    const sql = createTestDbClient();
    try {
      // Force a deterministic NO_ACTIVE_BRANCH WARNING for the first
      // business. is_default must be false before a branch can leave
      // ACTIVE status (business_branches_check).
      await sql`
        update public.business_branches set is_default = false, status = 'INACTIVE'
        where business_id = ${warningBusiness!.id} and is_default = true
      `;
      // Force a deterministic RECENT_WHATSAPP_FAILURES INFO for the second.
      const [account] = await sql<{ id: string }[]>`
        insert into public.whatsapp_accounts (business_id, status, provider_business_account_id, created_by)
        values (${infoBusiness!.id}, 'CONNECTED', ${`waba-e2e-${suffix}`}, ${infoOwner.id})
        returning id
      `;
      const [number] = await sql<{ id: string }[]>`
        insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, provider_phone_number_id, display_phone_number)
        values (${infoBusiness!.id}, ${account.id}, ${`pn-e2e-${suffix}`}, '+2348012345678')
        returning id
      `;
      const [conversation] = await sql<{ id: string }[]>`
        insert into public.whatsapp_conversations (business_id, whatsapp_phone_number_id, customer_phone_e164, status)
        values (${infoBusiness!.id}, ${number.id}, '+2348099998888', 'OPEN')
        returning id
      `;
      await sql`
        insert into public.whatsapp_messages (
          business_id, conversation_id, direction, message_type, sender_kind, status, failed_at
        ) values (
          ${infoBusiness!.id}, ${conversation.id}, 'OUTBOUND', 'TEXT', 'SYSTEM', 'FAILED', now()
        )
      `;
    } finally {
      await sql.end();
    }

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

    await page.goto("/internal/admin/support");
    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
    // Visible text, not just a CSS class or color — the accessible-name
    // fix under test. `.first()` because repeated local test runs can
    // leave more than one matching diagnostic row across earlier fixture
    // businesses; only presence, not uniqueness, is under test here.
    await expect(page.getByText(/^Warning\s*·\s*NO_ACTIVE_BRANCH$/).first()).toBeVisible();
    await expect(page.getByText(/^Info\s*·\s*RECENT_WHATSAPP_FAILURES$/).first()).toBeVisible();
  });
});
