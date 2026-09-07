import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient, createAdminClient } from "../integration/helpers/admin-client";

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
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id as string, client };
}

async function acceptedMember(client: ReturnType<typeof createUserClient>, businessId: string, role: string, prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const { data: defaultBranch } = await client
    .from("business_branches")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_default", true)
    .single();
  const { data: invId } = await client.rpc("create_business_invitation", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_email: email,
    p_role: role,
    p_branch_ids: [defaultBranch!.id],
    p_primary_branch_id: defaultBranch!.id,
  });
  await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });
  await memberClient.rpc("accept_business_invitation", { p_invitation_id: invId as string });
  return { email };
}

test.describe("billing", () => {
  test("OWNER sees the trial status and can schedule a cancellation from the real billing page", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-billing-owner");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.getByRole("link", { name: "Billing" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/settings/billing$`));
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("Growth plan")).toBeVisible();
    // Exact match: "Trial" (the status badge) also appears as a substring
    // of "Trial ends <date>" (the paid-through-date paragraph) — without
    // `exact: true` Playwright's strict mode rejects the ambiguous match.
    await expect(page.getByText("Trial", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Cancel subscription" }).click();
    await page.getByRole("button", { name: "Schedule cancellation" }).click();
    await expect(page.getByText("Cancellation scheduled — access continues until the date above.")).toBeVisible();
  });

  test("ADMIN can view billing but never sees management controls; SALES cannot reach the page at all", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-billing-admin");
    const admin = await acceptedMember(owner.client, owner.businessId, "ADMIN", "e2e-billing-admin-member");
    const sales = await acceptedMember(owner.client, owner.businessId, "SALES", "e2e-billing-sales-member");

    await loginAsInBrowser(page, admin.email, PASSWORD);
    await page.goto(`/${owner.businessId}/settings/billing`);
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
    await expect(page.getByText("Available plans")).toHaveCount(0);

    // Switching authenticated users within one test requires clearing the
    // ADMIN session first — navigating to /login while already
    // authenticated redirects straight past the login form to the
    // dashboard, mirroring every other multi-user-in-one-test spec's own
    // established convention (e.g. tests/e2e/expenses.spec.ts,
    // tests/e2e/logout.spec.ts).
    await page.context().clearCookies();
    await loginAsInBrowser(page, sales.email, PASSWORD);
    await page.goto(`/${owner.businessId}/settings/billing`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  // APP-1L-03: real provider cancellation requires a verified
  // subscription.create event to have already bound this subscription's
  // own provider identity — a PAYSTACK subscription that reached ACTIVE
  // (e.g. a reconciliation gap, or the subscription.create webhook not
  // yet delivered) but has NO bound provider_subscription_code must show
  // a safe, non-actionable state, never a false "cancel" affordance and
  // never a silent local-only cancellation.
  test("a PAYSTACK subscription with no bound provider identity yet shows a safe disabled state, never a false cancel affordance", async ({
    page,
  }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-billing-no-identity");
    const admin = createAdminClient();
    const { data: plan } = await admin.from("subscription_plans").select("id").eq("code", "GROWTH").single();
    await admin.rpc("activate_paystack_subscription", {
      p_business_id: businessId,
      p_plan_id: plan!.id,
      p_period_start: new Date().toISOString(),
      p_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      p_provider_environment: "LIVE",
      // Deliberately NO provider_customer_code/subscription identity —
      // simulates the reconciliation gap this test is proving is handled
      // safely.
    });

    await loginAsInBrowser(page, email, PASSWORD);
    await page.goto(`/${businessId}/settings/billing`);
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
    await expect(
      page.getByText("Cancellation isn't available yet for this subscription. Please try again shortly, or contact support.")
    ).toBeVisible();
  });
});
