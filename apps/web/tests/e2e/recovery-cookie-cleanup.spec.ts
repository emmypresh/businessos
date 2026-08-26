import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getLatestAuthLinkFor } from "./fixtures/mailpit";
import {
  createConfirmedTestUser,
  createUserClient,
} from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";

/**
 * Hygiene coverage for the recovery-grant cookie, NOT an authorization
 * change — the security boundary is (and remains) the single-use,
 * session-bound row in private.password_recovery_grants, enforced
 * server-side by consume_recovery_grant. These tests only prove that a
 * cookie the app has already rejected (or already consumed, or already
 * signed out of) does not linger in the browser afterward, since a
 * stale/rejected id sitting in a cookie jar serves no purpose but
 * confusion. See lib/auth/recovery-grant.ts's clearRecoveryGrantCookie.
 */

// Must match lib/auth/recovery-grant.ts's RECOVERY_GRANT_COOKIE exactly —
// duplicated here rather than imported because Playwright's test runner
// doesn't resolve this project's "@/*" tsconfig path alias (only the
// Next.js build does), the same reason every other e2e spec in this
// directory reaches shared helpers via relative imports instead.
const RECOVERY_GRANT_COOKIE = "sb-recovery-grant";

async function loginAsInBrowser(
  page: import("@playwright/test").Page,
  email: string,
  password: string
) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function getRecoveryGrantCookie(page: import("@playwright/test").Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === RECOVERY_GRANT_COOKIE);
}

async function addRecoveryGrantCookie(
  page: import("@playwright/test").Page,
  value: string
) {
  // Explicit domain+path (not the `url` shorthand) so this matches the
  // exact attributes the app itself issues the cookie with — the same
  // path clearRecoveryGrantCookie's deletion targets.
  await page.context().addCookies([
    {
      name: RECOVERY_GRANT_COOKIE,
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function submitResetPasswordExpectingDenial(
  page: import("@playwright/test").Page
) {
  await page.goto("/reset-password");
  await page.getByLabel("New password", { exact: true }).fill("AttackerChosen1");
  await page.getByLabel("Confirm new password").fill("AttackerChosen1");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByText("This link has expired or was already used.")
  ).toBeVisible();
}

test.describe("recovery-grant cookie cleanup", () => {
  test("fabricated cookie: denied, and the cookie is removed", async ({ page }) => {
    const email = `cookie-fab-${Date.now()}@example.test`;
    const password = "Password1234";
    await createConfirmedTestUser(email, password);
    await loginAsInBrowser(page, email, password);

    // A grant id that was never issued by /auth/confirm — no matching row
    // exists at all.
    await addRecoveryGrantCookie(page, randomUUID());

    await submitResetPasswordExpectingDenial(page);
    expect(await getRecoveryGrantCookie(page)).toBeUndefined();
  });

  test("expired grant: denied, and the cookie is removed", async ({ page }) => {
    const email = `cookie-exp-${Date.now()}@example.test`;
    const password = "Password1234";
    const user = await createConfirmedTestUser(email, password);
    await loginAsInBrowser(page, email, password);

    const sql = createTestDbClient();
    const grantId = randomUUID();
    try {
      await sql`
        insert into private.password_recovery_grants
          (id, user_id, session_id, created_at, expires_at)
        values (
          ${grantId}, ${user.id}, ${randomUUID()},
          now() - interval '20 minutes', now() - interval '10 minutes'
        )
      `;
    } finally {
      await sql.end();
    }

    await addRecoveryGrantCookie(page, grantId);
    await submitResetPasswordExpectingDenial(page);
    expect(await getRecoveryGrantCookie(page)).toBeUndefined();
  });

  test("already-consumed grant: denied, and the cookie is removed", async ({ page }) => {
    const email = `cookie-consumed-${Date.now()}@example.test`;
    const password = "Password1234";
    const user = await createConfirmedTestUser(email, password);
    await loginAsInBrowser(page, email, password);

    const sql = createTestDbClient();
    const grantId = randomUUID();
    try {
      await sql`
        insert into private.password_recovery_grants
          (id, user_id, session_id, consumed_at)
        values (${grantId}, ${user.id}, ${randomUUID()}, now())
      `;
    } finally {
      await sql.end();
    }

    await addRecoveryGrantCookie(page, grantId);
    await submitResetPasswordExpectingDenial(page);
    expect(await getRecoveryGrantCookie(page)).toBeUndefined();
  });

  test("successful reset: the cookie is removed", async ({ page }) => {
    const email = `cookie-success-${Date.now()}@example.test`;
    await createConfirmedTestUser(email, "OldPassword1");

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetLink = await getLatestAuthLinkFor(email);
    await page.goto(resetLink);
    await expect(page).toHaveURL(/\/reset-password$/);
    // Sanity check the premise: /auth/confirm really did issue a grant
    // cookie for this session before we assert its removal below.
    expect(await getRecoveryGrantCookie(page)).toBeDefined();

    await page.getByLabel("New password", { exact: true }).fill("NewPassword1");
    await page.getByLabel("Confirm new password").fill("NewPassword1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=success/);

    expect(await getRecoveryGrantCookie(page)).toBeUndefined();
  });

  test("logout: the cookie is removed", async ({ page }) => {
    const suffix = Date.now();
    const email = `cookie-logout-${suffix}@example.test`;
    const password = "Password1234";
    await createConfirmedTestUser(email, password);

    // Give this user a business up front (via a server-side client, not
    // the browser) purely so the dashboard shell — and its real "Log out"
    // button/Server Action — is reachable; a brand-new user with no
    // business never sees that button.
    const client = createUserClient();
    await client.auth.signInWithPassword({ email, password });
    const { data: business, error } = await client.rpc("create_business", {
      p_name: "Cookie Logout Co",
      p_slug: `cookie-logout-${suffix}`,
    });
    if (error || !business) {
      throw new Error(`Failed to create business: ${error?.message}`);
    }

    await loginAsInBrowser(page, email, password);
    await page.goto(`/${business.id}`);
    await expect(
      page.getByRole("heading", { name: "Welcome to Cookie Logout Co" })
    ).toBeVisible();

    // Doesn't matter that this id was never issued — logOut() must clear
    // whatever recovery cookie is present unconditionally, not only a
    // cookie it has separately validated.
    await addRecoveryGrantCookie(page, randomUUID());
    expect(await getRecoveryGrantCookie(page)).toBeDefined();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);

    expect(await getRecoveryGrantCookie(page)).toBeUndefined();
  });
});
