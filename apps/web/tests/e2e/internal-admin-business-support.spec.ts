import { test, expect, type Page } from "@playwright/test";
import {
  createConfirmedTestUser,
} from "../integration/helpers/admin-client";
import { createTestDbClient } from "../integration/helpers/db-client";
import { createOwnerAndBusiness, addMemberWithRole, randomUuid } from "../integration/helpers/inventory";
import { getDefaultBranchId } from "../integration/helpers/staff";
import { makeSaleProduct, saleItem } from "../integration/helpers/sales";
import { getDefaultCategoryId, makeExpense } from "../integration/helpers/expenses";
import { computeTotp } from "../integration/helpers/mfa";

// Phase 1O-C browser evidence. These tests deliberately use the same real
// sign-in and Supabase MFA enrollment/challenge flow as the frozen 1O-A/1O-B
// specs. Direct SQL is limited to privileged test-fixture provisioning and a
// summarized audit event; browser assertions always traverse the rendered UI.

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function insertPlatformAdmin(userId: string, role: "SUPER_ADMIN" | "SUPPORT") {
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

async function elevateBrowserToAal2(page: Page) {
  await page.goto("/internal/admin");
  await expect(page).toHaveURL(/\/internal\/admin\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("code").innerText()).trim();
  await page.getByLabel("6-digit code").fill(computeTotp(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page).toHaveURL(/\/internal\/admin$/);
}

async function createPlatformAdmin(prefix: string, role: "SUPER_ADMIN" | "SUPPORT") {
  const email = `${prefix}-${Date.now()}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  await insertPlatformAdmin(user.id, role);
  return { email, userId: user.id };
}

async function seedAuditSummary(businessId: string, actorUserId: string, actorEmail: string) {
  const sql = createTestDbClient();
  try {
    await sql`
      select private.record_audit_event(
        ${businessId}::uuid, 'USER'::text, ${actorUserId}::uuid,
        'sale.created'::text, 'COMMERCE'::text, null::uuid,
        ${actorEmail}::text, null::text, 'business'::text, ${randomUuid()}::uuid,
        'Support browser fixture'::text, 'SUCCESS'::text,
        '{"must_not_render":"raw-metadata"}'::jsonb
      )
    `;
  } finally {
    await sql.end();
  }
}

function supportTabs(page: Page) {
  return page.getByRole("navigation", { name: "Business support sections" });
}

function cardTitle(page: Page, title: string | RegExp) {
  return page.locator('[data-slot="card-title"]').filter({ hasText: title });
}

async function openSupportTab(page: Page, label: string, tab: string) {
  await supportTabs(page).getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`\\?tab=${tab}$`));
  await expect(supportTabs(page).getByRole("link", { name: label, exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
}

test.describe("Phase 1O-C business support console", () => {
  test("an AAL2 SUPER_ADMIN uses every support tab through the browser", async ({ page }) => {
    const admin = await createPlatformAdmin("support-e2e-super", "SUPER_ADMIN");
    const owner = await createOwnerAndBusiness(`support-browser-target-${Date.now()}`);
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, {
      name: "Support activity product",
      openingQuantity: 3,
    });
    const sale = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_branch_id: defaultBranchId,
      p_items: [saleItem(product.id, 1)],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(sale.error).toBeNull();
    // Give the subsequent expense a later server timestamp so the browser
    // can prove the feed's newest-first ordering as well as its categories.
    await page.waitForTimeout(1_100);
    const categoryId = await getDefaultCategoryId(owner.client, owner.businessId);
    await makeExpense(owner.client, owner.businessId, categoryId, { branchId: defaultBranchId });
    await seedAuditSummary(owner.businessId, owner.userId, owner.email);

    await loginAsInBrowser(page, admin.email);
    await elevateBrowserToAal2(page);
    await page.getByRole("link", { name: "Businesses" }).click();
    await page.getByLabel("Search businesses by name or slug").fill(owner.businessId);
    await page.locator(`a[href="/internal/admin/businesses/${owner.businessId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/internal/admin/businesses/${owner.businessId}$`));
    await expect(page.getByRole("heading", { name: new RegExp("support-browser-target") })).toBeVisible();

    await expect(cardTitle(page, "Overview")).toBeVisible();
    await openSupportTab(page, "Members", "members");
    await expect(cardTitle(page, /Members \(/)).toBeVisible();
    await page.getByLabel("Search members by email").fill(owner.email);
    await expect(page.getByRole("cell", { name: owner.email })).toBeVisible();
    await expect(page.getByRole("cell", { name: "OWNER", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "active", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "member(s) pagination" })).toBeVisible();

    await openSupportTab(page, "Branches", "branches");
    await expect(cardTitle(page, /Branches \(/)).toBeVisible();
    await expect(page.getByRole("cell", { name: "Main Branch", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible();

    await openSupportTab(page, "Subscription", "subscription");
    await expect(cardTitle(page, "Subscription")).toBeVisible();
    await expect(page.getByText("TRIALING", { exact: true })).toBeVisible();

    await openSupportTab(page, "Activity", "activity");
    await expect(cardTitle(page, "Activity")).toBeVisible();
    const activityRows = await page.locator("table tbody tr").allTextContents();
    expect(activityRows.some((row) => row.includes("Sale"))).toBe(true);
    expect(activityRows.some((row) => row.includes("Expense"))).toBe(true);
    expect(activityRows.findIndex((row) => row.includes("Expense"))).toBeLessThan(
      activityRows.findIndex((row) => row.includes("Sale"))
    );

    await openSupportTab(page, "Audit", "audit");
    await expect(cardTitle(page, "Audit")).toBeVisible();
    await expect(page.getByRole("table", { name: "Audit history" }).getByRole("cell", { name: "sale.created" }).first()).toBeVisible();
    await expect(page.getByText("raw-metadata", { exact: false })).toHaveCount(0);

    await openSupportTab(page, "Diagnostics", "diagnostics");
    await expect(cardTitle(page, "Diagnostics")).toBeVisible();
    await expect(page.getByText(/OK|INFO|WARNING/, { exact: true }).first()).toBeVisible();

    await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=not-a-tab`);
    await expect(cardTitle(page, "Overview")).toBeVisible();
    await expect(supportTabs(page).getByRole("link", { name: "Overview", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  test("an AAL2 SUPPORT admin retains all non-audit support tabs and cannot force audit data", async ({ page }) => {
    const admin = await createPlatformAdmin("support-e2e-support", "SUPPORT");
    const owner = await createOwnerAndBusiness(`support-no-audit-${Date.now()}`);

    await loginAsInBrowser(page, admin.email);
    await elevateBrowserToAal2(page);
    await page.goto(`/internal/admin/businesses/${owner.businessId}`);
    await expect(cardTitle(page, "Overview")).toBeVisible();

    for (const [label, tab] of [
      ["Members", "members"],
      ["Branches", "branches"],
      ["Subscription", "subscription"],
      ["Activity", "activity"],
      ["Diagnostics", "diagnostics"],
    ]) {
      await openSupportTab(page, label, tab);
    }
    await expect(supportTabs(page).getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
    await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=audit`);
    await expect(cardTitle(page, "Audit")).toBeVisible();
    await expect(page.getByText(/Audit history is unavailable/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Audit history" })).toHaveCount(0);
  });

  test("tenant OWNER and tenant ADMIN are denied the support console in the browser", async ({ page }) => {
    const owner = await createOwnerAndBusiness(`support-denied-${Date.now()}`);
    const adminEmail = `support-e2e-tenant-admin-${Date.now()}@example.test`;
    const tenantAdmin = await createConfirmedTestUser(adminEmail, PASSWORD);
    await addMemberWithRole(owner.businessId, tenantAdmin.id, "ADMIN");

    await loginAsInBrowser(page, owner.email);
    await page.goto(`/internal/admin/businesses/${owner.businessId}`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.context().clearCookies();
    await loginAsInBrowser(page, adminEmail);
    await page.goto(`/internal/admin/businesses/${owner.businessId}`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("support console is responsive, dark-safe, and keyboard reachable", async ({ page }) => {
    const admin = await createPlatformAdmin("support-e2e-visual", "SUPER_ADMIN");
    const owner = await createOwnerAndBusiness(`support-visual-${Date.now()}`);

    await loginAsInBrowser(page, admin.email);
    await elevateBrowserToAal2(page);
    await page.goto(`/internal/admin/businesses/${owner.businessId}`);

    // Each representative tab is rendered at its intended browser width.
    // Tables may scroll within their own component; the document itself must
    // never acquire horizontal overflow.
    for (const [width, height, tab] of [
      [390, 844, "overview"],
      [768, 900, "members"],
      [1280, 900, "activity"],
      [1440, 900, "diagnostics"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=${tab}`);
      await expect(cardTitle(page, tab === "overview" ? "Overview" : new RegExp(tab, "i"))).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.screenshot({ path: `qa-1oc-support-${tab}-${width}.png`, fullPage: true });
    }

    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=audit`);
      await expect(cardTitle(page, "Audit")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.screenshot({ path: `qa-1oc-support-audit-dark-${width}.png`, fullPage: true });
    }

    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`/internal/admin/businesses/${owner.businessId}?tab=members`);
    await expect(page.getByLabel("Search members by email")).toBeVisible();
    await expect(page.getByLabel("Filter by role")).toBeVisible();
    await expect(page.getByRole("table", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "member(s) pagination" })).toBeVisible();
    await expect(supportTabs(page).getByRole("link", { name: "Members", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await page.getByLabel("Search members by email").focus();
    await expect(page.getByLabel("Search members by email")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Filter by role")).toBeFocused();
  });
});
