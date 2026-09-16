import { test, expect, type Page } from "@playwright/test";
import { deleteTestUser } from "../integration/helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, createRoleWithPermissions, createMemberWithCustomPermissions, randomUuid } from "../integration/helpers/inventory";
import { createTestDbClient } from "../integration/helpers/db-client";

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function setupConnectedAccount(businessId: string, ownerUserId: string) {
  const sql = createTestDbClient();
  try {
    const [account] = await sql<{ upsert_meta_whatsapp_account: string }[]>`
      select public.upsert_meta_whatsapp_account(
        p_business_id => ${businessId}::uuid,
        p_provider_business_account_id => ${`waba-${randomUuid()}`},
        p_status => 'CONNECTED',
        p_actor_user_id => ${ownerUserId}::uuid,
        p_created_by => ${ownerUserId}::uuid
      ) as upsert_meta_whatsapp_account
    `;
    const accountId = account.upsert_meta_whatsapp_account;
    const [number] = await sql<{ upsert_meta_whatsapp_phone_number: string }[]>`
      select public.upsert_meta_whatsapp_phone_number(
        p_business_id => ${businessId}::uuid,
        p_whatsapp_account_id => ${accountId}::uuid,
        p_provider_phone_number_id => ${`pn-${randomUuid()}`},
        p_display_phone_number => '+15550001111'
      ) as upsert_meta_whatsapp_phone_number
    `;
    return { accountId, numberId: number.upsert_meta_whatsapp_phone_number as string };
  } finally {
    await sql.end();
  }
}

async function createOpenConversation(businessId: string, numberId: string, phone: string, windowHoursFromNow: number | null) {
  const sql = createTestDbClient();
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into public.whatsapp_conversations (business_id, customer_id, whatsapp_phone_number_id, customer_phone_e164, status, customer_service_window_ends_at)
      values (
        ${businessId}, null, ${numberId}, ${phone}, 'OPEN',
        ${windowHoursFromNow === null ? null : sql`now() + make_interval(hours => ${windowHoursFromNow})`}
      )
      returning id
    `;
    return row.id as string;
  } finally {
    await sql.end();
  }
}

let cleanupUserIds: string[] = [];
test.afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function makeOwnerWithBusiness(prefix: string) {
  const owner = await createOwnerAndBusiness(prefix);
  cleanupUserIds.push(owner.userId);
  return owner;
}

test.describe("Phase 1M WhatsApp inbox — remediation coverage", () => {
  test("A/K: a caller without whatsapp.view cannot reach the inbox route", async ({ page }) => {
    const owner = await makeOwnerWithBusiness("e2e-wa-noview");
    const roleName = await createRoleWithPermissions([]); // no whatsapp.view
    const member = await createMemberWithRole(owner.businessId, "e2e-wa-noview", roleName);
    cleanupUserIds.push(member.userId);

    await loginAsInBrowser(page, member.email);
    await page.goto(`/${owner.businessId}/whatsapp`);
    // requirePermissionOrNotFound renders Next's own not-found boundary —
    // the inbox heading must never appear for this caller.
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "WhatsApp inbox" })).toHaveCount(0);
  });

  test("B: a view-only member (whatsapp.view, no whatsapp.send) can read the inbox but cannot send", async ({ page }) => {
    const owner = await makeOwnerWithBusiness("e2e-wa-viewonly");
    const { accountId, numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    await createOpenConversation(owner.businessId, numberId, "+15559990001", 1);

    const member = await createMemberWithCustomPermissions(owner.businessId, "e2e-wa-viewonly", ["whatsapp.view"]);
    cleanupUserIds.push(member.userId);

    await loginAsInBrowser(page, member.email);
    await page.goto(`/${owner.businessId}/whatsapp`);
    await expect(page.getByRole("heading", { name: "WhatsApp inbox" })).toBeVisible();
    await page.getByText("+15559990001").first().click();
    await expect(page.getByText(/don.t have permission to send/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /send message/i })).toBeDisabled();
    void accountId;
  });

  test("C: conversation list to thread to mobile Back returns to the list (WAI-005)", async ({ page }) => {
    const owner = await makeOwnerWithBusiness("e2e-wa-mobile");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    await createOpenConversation(owner.businessId, numberId, "+15559990002", 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsInBrowser(page, owner.email);
    await page.goto(`/${owner.businessId}/whatsapp`);
    await expect(page.getByText("+15559990002")).toBeVisible();

    await page.getByText("+15559990002").first().click();
    await expect(page).toHaveURL(/conversation=/);
    await expect(page.getByRole("heading", { name: "+15559990002" })).toBeVisible();

    await page.getByRole("link", { name: "Back to conversations" }).click();
    await expect(page).not.toHaveURL(/conversation=/);
    await expect(page.getByText("+15559990002")).toBeVisible();
  });

  test("D: an open service window shows the TEXT composer (WAI-004)", async ({ page }) => {
    const owner = await makeOwnerWithBusiness("e2e-wa-open");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    await createOpenConversation(owner.businessId, numberId, "+15559990003", 2);

    await loginAsInBrowser(page, owner.email);
    await page.goto(`/${owner.businessId}/whatsapp`);
    await page.getByText("+15559990003").first().click();
    await expect(page.getByLabel("Message text")).toBeVisible();
    await expect(page.getByText("24-hour window: open")).toBeVisible();
  });

  test("E: a closed service window shows the TEMPLATE composer (WAI-004)", async ({ page }) => {
    const owner = await makeOwnerWithBusiness("e2e-wa-closed");
    const { numberId } = await setupConnectedAccount(owner.businessId, owner.userId);
    await createOpenConversation(owner.businessId, numberId, "+15559990004", null);

    await loginAsInBrowser(page, owner.email);
    await page.goto(`/${owner.businessId}/whatsapp`);
    await page.getByText("+15559990004").first().click();
    await expect(page.getByLabel(/approved template required/i)).toBeVisible();
    await expect(page.getByLabel("Message text")).toHaveCount(0);
    await expect(page.getByText("24-hour window: closed")).toBeVisible();
  });

  test("G: a cross-business conversation id never loads a thread", async ({ page }) => {
    const ownerA = await makeOwnerWithBusiness("e2e-wa-tenant-a");
    const ownerB = await makeOwnerWithBusiness("e2e-wa-tenant-b");
    const { numberId } = await setupConnectedAccount(ownerB.businessId, ownerB.userId);
    const foreignConversationId = await createOpenConversation(ownerB.businessId, numberId, "+15559990005", 1);

    await loginAsInBrowser(page, ownerA.email);
    await page.goto(`/${ownerA.businessId}/whatsapp?conversation=${foreignConversationId}`);
    await expect(page.getByRole("heading", { name: "Choose a conversation" })).toBeVisible();
    await expect(page.getByText("+15559990005")).toHaveCount(0);
  });
});
