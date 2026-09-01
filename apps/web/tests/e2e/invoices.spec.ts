import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions } from "../integration/helpers/inventory";
import { createBranch, getDefaultBranchId, assignMemberToBranch, getMemberId, inviteMember, acceptInvitation } from "../integration/helpers/staff";

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

// Mirrors branch-aware-workflows.spec.ts's own createBranchAssignedMember
// — a MANAGER (whose seeded role bundle includes invoices.manage)
// assigned to a specific branch, since the OWNER can never self-assign
// beyond their own default branch (CANNOT_MANAGE_SELF, a frozen Phase 1F
// rule). The invoice-creation branch picker itself resolves through
// get_invoice_branch_options (20260831080700_invoice_picker_rpcs.sql),
// gated on invoices.manage ALONE — MANAGER's other permissions
// (sales.create included) are incidental to this fixture, never required
// by the picker.
async function createBranchAssignedMember(
  prefix: string,
  businessId: string,
  ownerClient: ReturnType<typeof createUserClient>,
  branchId: string
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });

  const defaultBranchId = await getDefaultBranchId(ownerClient, businessId);
  const invitationId = await inviteMember(ownerClient, businessId, email, "MANAGER", {
    branchIds: [defaultBranchId],
    primaryBranchId: defaultBranchId,
  });
  await acceptInvitation(memberClient, invitationId);
  const memberId = await getMemberId(businessId, user.id);
  await assignMemberToBranch(ownerClient, businessId, memberId, [branchId]);

  return { email, client: memberClient };
}

test.describe("Phase 1H invoices + payments", () => {
  test("A: create an invoice, record a partial then final payment, and an overpayment attempt is rejected", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-flow");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Invoice Customer ${suffix}`,
    });
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Invoice Product ${suffix}`,
      p_sku: `e2e-inv-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 0,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/invoices/new`);

    await page.getByLabel("Customer").fill(`E2E Invoice Customer ${suffix}`);
    await page
      .getByTestId("customer-picker-results")
      .getByText(`E2E Invoice Customer ${suffix}`, { exact: false })
      .click();

    await page.getByLabel("Search products").fill(`E2E Invoice Product ${suffix}`);
    await page
      .getByTestId("invoice-product-results")
      .getByText(`E2E Invoice Product ${suffix}`, { exact: false })
      .click();

    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices/[0-9a-f-]{36}$`));
    const statusBadge = page.getByTestId("invoice-status-badge");
    await expect(statusBadge).toContainText("Issued");
    await expect(page.getByText("NGN 1,000.00").first()).toBeVisible();

    // Partial payment: 400 of 1000.
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.getByLabel("Amount").fill("400");
    await page.getByRole("button", { name: "Confirm payment" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices/[0-9a-f-]{36}$`));
    await expect(statusBadge).toContainText("Partially paid");

    // Overpayment attempt: 700 exceeds the remaining 600 balance — the
    // server rejects it (a validation error, no navigation), so the SAME
    // sheet instance stays open with a controlled error — the invoice's
    // own balance/status are unaffected.
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.getByLabel("Amount").fill("700");
    await page.getByRole("button", { name: "Confirm payment" }).click();
    await expect(page.getByText(/exceeds the invoice's outstanding balance/)).toBeVisible();
    await expect(statusBadge).toContainText("Partially paid");

    // Correct the amount to the real remaining balance IN THE SAME
    // still-open sheet (a rejected submission never navigates away, so
    // there is nothing to reopen) and resubmit.
    await page.getByLabel("Amount").fill("600");
    await page.getByRole("button", { name: "Confirm payment" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices/[0-9a-f-]{36}$`));
    await expect(statusBadge).toContainText("Paid");
    await expect(statusBadge).not.toContainText("Partially paid");

    // A fresh load of the same page (never relying on any lingering
    // client-side state from the payment sheet's own prior interactions)
    // confirms the settled, DB-authoritative state: no "Record payment"
    // trigger once fully paid, and both payments appear in the history.
    await page.reload();
    await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
    const paymentHistory = page.getByTestId("payment-history");
    await expect(paymentHistory.getByText("NGN 400.00")).toBeVisible();
    await expect(paymentHistory.getByText("NGN 600.00")).toBeVisible();
  });

  // Codex adversarial review, remediation round 2, Low 4: clicking "Add
  // line" with an empty description and an invalid unit price used to
  // silently no-op — no visible feedback at all. Now both fields show a
  // real, accessibly-associated error, and correcting one field clears
  // only that field's own error (the other stays visible until fixed).
  test("J: an invalid custom line shows visible, accessibly-associated field errors, not a silent no-op", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-custom-line-a11y");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/invoices/new`);

    await page.getByRole("button", { name: "Add custom line" }).click();
    // Neither field filled in — clicking "Add line" must surface BOTH
    // errors, not just refuse silently.
    await page.getByRole("button", { name: "Add line" }).click();

    const descriptionInput = page.getByLabel("Description");
    const unitPriceInput = page.getByLabel("Unit price");
    await expect(descriptionInput).toHaveAttribute("aria-invalid", "true");
    await expect(unitPriceInput).toHaveAttribute("aria-invalid", "true");

    const descriptionErrorId = await descriptionInput.getAttribute("aria-describedby");
    const unitPriceErrorId = await unitPriceInput.getAttribute("aria-describedby");
    expect(descriptionErrorId).toBeTruthy();
    expect(unitPriceErrorId).toBeTruthy();
    // The describedby id must point at a REAL, visible element carrying
    // the error text — not a dangling reference.
    await expect(page.locator(`#${descriptionErrorId}`)).toBeVisible();
    await expect(page.locator(`#${unitPriceErrorId}`)).toBeVisible();
    await expect(page.locator(`#${descriptionErrorId}`)).toHaveText("Enter a description.");
    await expect(page.locator(`#${unitPriceErrorId}`)).toHaveText("Enter a price with up to 2 decimal places.");

    // Fixing ONLY the description clears just that field's own error —
    // the still-invalid unit price stays flagged.
    await descriptionInput.fill("Delivery fee");
    await expect(descriptionInput).toHaveAttribute("aria-invalid", "false");
    await expect(unitPriceInput).toHaveAttribute("aria-invalid", "true");

    await unitPriceInput.fill("1500");
    await page.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByText("Delivery fee")).toBeVisible();
  });

  test("B: a Branch-B-assigned member creates a Branch B invoice", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-branch-b");
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Invoice Branch B" });
    const member = await createBranchAssignedMember("e2e-invoice-branch-b-member", owner.businessId, owner.client, branchB);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Branch Invoice Customer ${suffix}`,
    });
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Branch Invoice Product ${suffix}`,
      p_sku: `e2e-inv-branch-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 0,
    });

    await loginAsInBrowser(page, member.email, PASSWORD);
    await page.goto(`/${owner.businessId}/invoices/new`);

    // Preselected automatically — the member's own (only) assigned branch.
    await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("Invoice Branch B");

    await page.getByLabel("Customer").fill(`E2E Branch Invoice Customer ${suffix}`);
    await page
      .getByTestId("customer-picker-results")
      .getByText(`E2E Branch Invoice Customer ${suffix}`, { exact: false })
      .click();
    await page.getByLabel("Search products").fill(`E2E Branch Invoice Product ${suffix}`);
    await page
      .getByTestId("invoice-product-results")
      .getByText(`E2E Branch Invoice Product ${suffix}`, { exact: false })
      .click();
    await page.getByRole("button", { name: "Create invoice" }).click();

    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices/[0-9a-f-]{36}$`));
    await expect(page.getByText("Invoice Branch B", { exact: true })).toBeVisible();
  });

  test("C: a view-only user can view an invoice but cannot record a payment or void it", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-view-only");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "View Only Test Customer",
    });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId as string,
      p_branch_id: branchA,
      p_items: [{ description: "Service", quantity: 1, unit_price: 2000 }],
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-invoice-view-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    // No seeded role is invoices.view-only without invoices.manage — a
    // deliberately constructed one-off role exercises the split
    // precisely, mirroring this project's own established convention
    // (see expenses.spec.ts's identical "view-only" fixture pattern).
    const roleName = await createRoleWithPermissions(["invoices.view", "payments.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/invoices/${invoiceId}`);
    await expect(page.getByText("Service", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Void invoice" })).toHaveCount(0);

    // /new independently requires invoices.manage — inaccessible here.
    await page.goto(`/${owner.businessId}/invoices/new`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("D: an unpaid invoice can be voided through the real UI", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-void");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Void Test Customer",
    });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId as string,
      p_branch_id: branchA,
      p_items: [{ description: "Service", quantity: 1, unit_price: 3000 }],
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/invoices/${invoiceId}`);
    await page.getByRole("button", { name: "Void invoice" }).click();
    await page.getByRole("button", { name: "Void invoice", exact: true }).last().click();

    await expect(page.getByText("Void", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
  });

  test("E: the print-friendly invoice route renders without error", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-print");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Print Test Customer",
    });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId as string,
      p_branch_id: branchA,
      p_items: [{ description: "Printable service", quantity: 1, unit_price: 4000 }],
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/invoices/${invoiceId}/print`);
    await expect(page.getByText("Print Test Customer")).toBeVisible();
    await expect(page.getByText("Printable service")).toBeVisible();
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  });

  // Codex adversarial review, remediation round 1, Low 7: re-tested at
  // all three of the review's own named viewports (375/768/1440), not
  // merely mobile — mirrors branch-aware-workflows.spec.ts's own
  // identical three-width pattern.
  for (const width of [375, 768, 1440]) {
    test(`F: invoice create and detail are usable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await createOwnerAndBusiness(`e2e-invoice-width-${width}`);
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await owner.client.rpc("create_customer", {
        p_business_id: owner.businessId,
        p_creation_key: crypto.randomUUID(),
        p_name: `E2E Width Invoice Customer ${suffix}`,
      });
      await owner.client.rpc("create_product", {
        p_business_id: owner.businessId,
        p_creation_key: crypto.randomUUID(),
        p_name: `E2E Width Invoice Product ${suffix}`,
        p_sku: `e2e-inv-width-${width}-${suffix}`,
        p_selling_price: 750,
        p_opening_quantity: 0,
      });

      await loginAsInBrowser(page, owner.email, PASSWORD);
      await page.goto(`/${owner.businessId}/invoices/new`);
      await page.getByLabel("Customer").fill(`E2E Width Invoice Customer ${suffix}`);
      await page
        .getByTestId("customer-picker-results")
        .getByText(`E2E Width Invoice Customer ${suffix}`, { exact: false })
        .click();
      await page.getByLabel("Search products").fill(`E2E Width Invoice Product ${suffix}`);
      await page
        .getByTestId("invoice-product-results")
        .getByText(`E2E Width Invoice Product ${suffix}`, { exact: false })
        .click();

      let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      await page.getByRole("button", { name: "Create invoice" }).click();
      await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices/[0-9a-f-]{36}$`));

      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  // Codex adversarial review, remediation round 1, Medium 6: the sidebar
  // must actually offer an Invoices entry, not merely be reachable by
  // typed URL.
  test("G: the dashboard sidebar links to Invoices under Finance", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-invoice-nav");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}`);
    await page.getByRole("link", { name: "Invoices" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/invoices$`));
  });

  // Codex adversarial review, remediation round 1, Medium 4: the
  // dedicated payments.record-only surface is a real, reachable browser
  // page — a payments.record-only caller (no invoices.view) can search
  // for and select an outstanding invoice, and record a payment against
  // it, entirely through /[businessId]/payments/record.
  test("H: payments.record-only caller records a payment through the dedicated /payments/record surface", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-payments-record-only");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Payments Record Only Customer",
    });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId as string,
      p_branch_id: branchA,
      p_items: [{ description: "Recordable service", quantity: 1, unit_price: 5000 }],
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-payments-record-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["payments.record"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    // /invoices is inaccessible to this caller (no invoices.view).
    await page.goto(`/${owner.businessId}/invoices`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${owner.businessId}/payments/record`);
    // get_payable_invoice_options searches by invoice number / customer
    // name snapshot — never item descriptions.
    await page.getByLabel("Invoice").fill("Payments Record Only Customer");
    await page
      .getByTestId("payable-invoice-results")
      .getByText("Payments Record Only Customer", { exact: false })
      .click();
    // PaymentForm (reused verbatim from the invoice detail page) renders
    // its fields inside a Sheet, behind its own "Record payment" trigger.
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.getByLabel("Amount").fill("5000");
    await page.getByRole("button", { name: "Confirm payment" }).click();

    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/payments/record\\?created=1$`));
    await expect(page.getByTestId("payment-recorded-banner")).toBeVisible();

    const { data: invoice } = await owner.client.from("invoices").select("status, amount_paid").eq("id", invoiceId as string).single();
    expect(invoice?.status).toBe("PAID");
    expect(Number(invoice?.amount_paid)).toBe(5000);
  });

  // Codex adversarial review, remediation round 1, Medium 4: the
  // dedicated payments.view-only surface is a real, reachable browser
  // page showing invoice/customer/branch details, without invoices.view.
  test("I: payments.view-only caller reads payment history through the dedicated /payments surface", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-payments-view-only");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Payments View Only Customer",
    });
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId as string,
      p_branch_id: branchA,
      p_items: [{ description: "Viewable service", quantity: 1, unit_price: 3000 }],
    });
    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_invoice_id: invoiceId as string,
      p_amount: 3000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-payments-view-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["payments.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/invoices`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${owner.businessId}/payments`);
    await expect(page.getByText("Payments View Only Customer")).toBeVisible();
    await expect(page.getByText("NGN 3,000.00")).toBeVisible();
  });
});
