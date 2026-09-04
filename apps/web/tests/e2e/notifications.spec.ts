import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions } from "../integration/helpers/inventory";

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function createOwnerAndBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, userId: user.id, businessId: business!.id as string, client };
}

async function raiseExpenseNotification(owner: Awaited<ReturnType<typeof createOwnerAndBusiness>>) {
  const { data: category } = await owner.client
    .from("expense_categories")
    .insert({ business_id: owner.businessId, name: `E2E Category ${Date.now()}` })
    .select("id")
    .single();
  await owner.client.rpc("create_expense", {
    p_business_id: owner.businessId,
    p_creation_key: crypto.randomUUID(),
    p_category_id: category!.id as string,
    p_amount: 42,
    p_payment_method: "CASH",
    p_incurred_at: new Date().toISOString(),
  });
}

test.describe("Phase 1K notifications", () => {
  test("A: the bell renders, shows an unread badge, and opens a dropdown with a real notification", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-bell");
    await raiseExpenseNotification(owner);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}`);

    const trigger = page.getByTestId("notification-bell-trigger").last();
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId("notification-unread-badge").last()).toBeVisible();

    await trigger.click();
    await expect(page.getByTestId("notification-bell-sheet")).toBeVisible();
    await expect(page.getByText("Expense posted")).toBeVisible();
  });

  test("B: the empty state renders when a business has no notifications yet", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-empty");

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}`);

    const trigger = page.getByTestId("notification-bell-trigger").last();
    await expect(page.getByTestId("notification-unread-badge")).toHaveCount(0);
    await trigger.click();
    await expect(page.getByText("No notifications yet.")).toBeVisible();
  });

  test("C: the full notification page lists real notifications, and clicking one marks it read", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-page");
    await raiseExpenseNotification(owner);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/notifications`);

    const row = page.getByTestId("notification-row").first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-unread", "true");

    await row.getByText("Expense posted").click();
    await expect(page.getByTestId("notification-detail-sheet")).toBeVisible();
    // openDetail's own mark-read call is fire-and-forget (a background
    // Server Action call, not awaited by the click handler itself) — the
    // client-side optimistic update is instant, but the underlying write
    // needs a moment to actually land before a reload can observe it
    // server-side. Waiting for the network to settle (rather than a
    // fixed sleep) is what makes this deterministic.
    await page.waitForLoadState("networkidle");

    await page.reload();
    await expect(page.getByTestId("notification-row").first()).toHaveAttribute("data-unread", "false");
  });

  test("D: mark all read clears every unread row on the full page", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-mark-all");
    await raiseExpenseNotification(owner);
    await raiseExpenseNotification(owner);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/notifications`);
    await expect(page.getByTestId("notification-row").first()).toBeVisible();

    await page.getByTestId("mark-all-read").click();
    await page.waitForLoadState("networkidle");
    await page.reload();

    const rows = page.getByTestId("notification-row");
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toHaveAttribute("data-unread", "false");
    }
  });

  test("E: a preference toggle persists across reload, and suppresses a subsequent matching notification", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-preferences");

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/notifications/preferences`);

    const toggle = page.getByTestId("notification-preference-expense.posted");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("notification-preference-expense.posted")).not.toBeChecked();

    // Now raise a real expense.posted event — the owner opted out, so no
    // new notification should reach them.
    await raiseExpenseNotification(owner);
    await page.goto(`/${owner.businessId}/notifications`);
    await expect(page.getByText("No notifications yet.")).toBeVisible();
  });

  test("F: a caller without a recipient row sees an empty inbox, never another member's notifications", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-recipient-isolation");
    await raiseExpenseNotification(owner);
    const viewerRole = await createRoleWithPermissions(["sales.view"]);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const viewerEmail = `e2e-notif-recipient-isolation-${suffix}@example.test`;
    const viewerUser = await createConfirmedTestUser(viewerEmail, PASSWORD);
    await addMemberWithRole(owner.businessId, viewerUser.id, viewerRole);

    await loginAsInBrowser(page, viewerEmail, PASSWORD);
    await page.goto(`/${owner.businessId}/notifications`);
    await expect(page.getByText("No notifications yet.")).toBeVisible();
    await expect(page.getByText("Expense posted")).toHaveCount(0);
  });

  test("G: an outsider (not a member of the business) gets a genuine 404 on the notifications page", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-notif-outsider-a");
    const outsider = await createOwnerAndBusiness("e2e-notif-outsider-b");
    void outsider;

    await loginAsInBrowser(page, outsider.email, PASSWORD);
    await page.goto(`/${owner.businessId}/notifications`);
    await expect(page.getByText(/404|not found/i)).toBeVisible();
  });

  for (const width of [375, 768, 1440]) {
    test(`H: the notification feed is usable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await createOwnerAndBusiness(`e2e-notif-width-${width}`);
      await raiseExpenseNotification(owner);

      await loginAsInBrowser(page, owner.email, PASSWORD);
      await page.goto(`/${owner.businessId}/notifications`);
      await expect(page.getByTestId("notification-row").first()).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }
});
