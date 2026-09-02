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

// Mirrors invoices.spec.ts's own createBranchAssignedMember exactly — a
// MANAGER (whose seeded role bundle includes returns.view/returns.manage)
// assigned to a specific branch, since the OWNER can never self-assign
// beyond their own default branch (CANNOT_MANAGE_SELF).
async function createBranchAssignedMember(
  prefix: string,
  businessId: string,
  ownerClient: ReturnType<typeof createUserClient>,
  branchId: string,
  role = "MANAGER"
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });

  const defaultBranchId = await getDefaultBranchId(ownerClient, businessId);
  const invitationId = await inviteMember(ownerClient, businessId, email, role, {
    branchIds: [defaultBranchId],
    primaryBranchId: defaultBranchId,
  });
  await acceptInvitation(memberClient, invitationId);
  const memberId = await getMemberId(businessId, user.id);
  await assignMemberToBranch(ownerClient, businessId, memberId, [branchId]);

  return { email, userId: user.id, client: memberClient };
}

async function createCustomProduct(
  ownerClient: ReturnType<typeof createUserClient>,
  businessId: string,
  name: string,
  sellingPrice: number,
  options: { openingQuantity?: number; trackInventory?: boolean } = {}
) {
  const trackInventory = options.trackInventory ?? true;
  const { data } = await ownerClient.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_name: name,
    p_sku: `e2e-ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    p_selling_price: sellingPrice,
    p_track_inventory: trackInventory,
    p_opening_quantity: trackInventory ? options.openingQuantity ?? 50 : undefined,
  });
  return data!.id as string;
}

async function createCompletedSale(
  client: ReturnType<typeof createUserClient>,
  businessId: string,
  productId: string,
  quantity: number,
  branchId?: string,
  options: { partiallyPaidAmount?: number } = {}
) {
  const { data: saleId } = await client.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: crypto.randomUUID(),
    p_items: [{ product_id: productId, quantity }],
    p_payment_status: options.partiallyPaidAmount !== undefined ? "PARTIALLY_PAID" : "PAID",
    p_payment_method: "CASH",
    p_amount_paid: options.partiallyPaidAmount,
    p_branch_id: branchId,
  });
  return saleId as string;
}

test.describe("Phase 1I returns + refunds", () => {
  test("A: create a partial return with restock=true and a partial refund", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-partial");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Product ${suffix}`, 1000);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 5);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);

    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    await row.getByLabel(/Quantity to return/).fill("2");

    await page.getByLabel("Refund amount").fill("1500");
    await page.getByLabel("Refund method").click();
    await page.getByRole("option", { name: "Cash" }).click();
    await page.getByLabel("Reason (optional)").click();
    await page.getByRole("option", { name: "Customer return" }).click();

    await page.getByRole("button", { name: "Create return" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));
    await expect(page.getByText("NGN 1,500.00")).toBeVisible();
    await expect(page.getByText("Restocked")).toBeVisible();
    await expect(page.getByText("Customer return")).toBeVisible();
  });

  test("B: a no-refund return with restock=false is recorded with zero refund and shows Not restocked", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-norefund");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret NoRefund ${suffix}`, 500);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 3);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    await row.getByLabel(/Quantity to return/).fill("1");
    // Restock defaults to true — uncheck to record a not-restocked line
    // (e.g. a damaged item the caller doesn't want back in sellable
    // stock).
    await row.getByRole("checkbox", { name: /Restock/ }).uncheck();
    await page.getByLabel("Reason (optional)").click();
    await page.getByRole("option", { name: "Damaged" }).click();

    await page.getByRole("button", { name: "Create return" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));
    await expect(page.getByText("No refund")).toBeVisible();
    await expect(page.getByText("Not restocked")).toBeVisible();
  });

  test("C: a full return of the entire sold quantity with a full refund succeeds", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-full");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Full ${suffix}`, 2000);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 2);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    // Auto-filled to the full remaining quantity (2) on check.
    await expect(row.getByLabel(/Quantity to return/)).toHaveValue("2");

    await page.getByLabel("Refund amount").fill("4000");
    await page.getByLabel("Refund method").click();
    await page.getByRole("option", { name: "Bank Transfer" }).click();

    await page.getByRole("button", { name: "Create return" }).click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));
    await expect(page.getByText("NGN 4,000.00").first()).toBeVisible();
  });

  test("D: a quantity exceeding what remains is client-side blocked", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-overquantity");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Over ${suffix}`, 1000);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 2);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    await row.getByLabel(/Quantity to return/).fill("5"); // only 2 sold
    await expect(page.getByText(/no more than 2/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create return" })).toBeDisabled();
  });

  // The client's own advisory refund ceiling is computed from the sale's
  // TOTAL amount_paid, fetched once at sale-selection time — it has no
  // visibility into a return made by someone else moments later. This
  // proves the SERVER remains the real authority: a refund the client's
  // own (now-stale) estimate would have permitted is still correctly
  // rejected once a prior return has already consumed the sale's own
  // refundable ceiling. (Precision/malformed-payload rejection is covered
  // in more depth by the integration suite —
  // tests/integration/returns-application.test.ts — per this round's own
  // "use integration tests for permission/action cases" guidance.)
  test("D2: a refund the client's own stale ceiling would allow is still server-rejected once a prior return has consumed it", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-stale-ceiling");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Stale ${suffix}`, 2000);
    // PARTIALLY_PAID at 1000 of a 4000 total — the client's own advisory
    // ceiling is min(remaining item VALUE, the sale's own amount_paid),
    // and for a fully-paid sale that ceiling can never actually exceed
    // the true remaining refundable amount (the math cancels out
    // exactly). A partially-paid sale is what makes a genuinely stale,
    // too-generous client estimate possible: the refundable ceiling is
    // capped by amount_paid, which the client cannot know has already
    // been partly consumed by someone else's return moments earlier.
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 2, undefined, {
      partiallyPaidAmount: 1000,
    });
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId);

    // A prior return already refunds 800 of the sale's own 1000
    // amount_paid — the CLIENT's own picker never learns this; its
    // ceiling is computed from min(remaining item value = 2000, the
    // sale's own amount_paid = 1000) = 1000.
    await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItems![0].id, quantity: 1, restock: false }],
      p_refund_amount: 800,
      p_refund_method: "CASH",
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    // Only 1 unit remains returnable — its own value basis is 2000,
    // under the client's own (stale) 1000 ceiling only in the sense that
    // it doesn't further constrain it; the client's computed ceiling here
    // is min(2000, 1000) = 1000.
    await row.getByLabel(/Quantity to return/).fill("1");
    await page.getByLabel("Refund amount").fill("500");
    await page.getByLabel("Refund method").click();
    await page.getByRole("option", { name: "Cash" }).click();
    await expect(page.getByRole("button", { name: "Create return" })).toBeEnabled();

    await page.getByRole("button", { name: "Create return" }).click();
    // Only 200 of the amount_paid actually remains (1000 - 800) — the
    // server correctly rejects the 500 the client's own stale estimate
    // (1000) would have allowed, with a controlled message, never a raw
    // SQLSTATE.
    await expect(page.getByText(/more than this sale can refund/)).toBeVisible();
    await expect(page).toHaveURL(`/${owner.businessId}/returns/new`);
  });

  test("E: multiple separate returns against the same sale are both recorded and both listed", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-multiple");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Multi ${suffix}`, 500);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 4);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);

    for (const quantity of ["1", "1"]) {
      await page.goto(`/${owner.businessId}/returns/new`);
      await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
      await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();
      const row = page.getByTestId(/^return-line-/);
      await row.getByRole("checkbox", { name: /Include/ }).check();
      await row.getByLabel(/Quantity to return/).fill(quantity);
      await page.getByRole("button", { name: "Create return" }).click();
      await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));
    }

    await page.goto(`/${owner.businessId}/returns`);
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(2);
  });

  test("F1: returns.view-only cannot reach the create route", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-view-only");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const viewerRole = await createRoleWithPermissions(["returns.view"]);
    const viewerEmail = `e2e-ret-viewer-${suffix}@example.test`;
    const viewerUser = await createConfirmedTestUser(viewerEmail, PASSWORD);
    await addMemberWithRole(owner.businessId, viewerUser.id, viewerRole);

    await loginAsInBrowser(page, viewerEmail, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await expect(page.getByText(/404|not found/i)).toBeVisible();
  });

  test("F2: returns.manage-only can reach and complete the create flow, WITHOUT returns.view", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-manage-only");
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Perm ${suffix}`, 1000);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 2, branchA);

    const manageOnly = await createBranchAssignedMember("e2e-ret-manage-only", owner.businessId, owner.client, branchA);
    // Downgrade to a returns.manage-ONLY custom role (MANAGER's seeded
    // bundle includes far more, including returns.view) — mirrors the DB
    // round's own custom-role fixture technique. Deliberately WITHOUT
    // returns.view, sales.view, sales.create, inventory.view,
    // inventory.adjust, branches.view — returns.manage must be entirely
    // self-contained.
    const manageOnlyRole = await createRoleWithPermissions(["returns.manage"]);
    const memberId = await getMemberId(owner.businessId, manageOnly.userId);
    const sql = (await import("../integration/helpers/db-client")).createTestDbClient();
    await sql`update public.business_members set role_id = (select id from public.roles where name = ${manageOnlyRole}) where id = ${memberId}`;
    await sql.end();

    await loginAsInBrowser(page, manageOnly.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns`);
    await expect(page.getByText(/404|not found/i)).toBeVisible();

    await page.goto(`/${owner.businessId}/returns/new`);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();
    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    await row.getByLabel(/Quantity to return/).fill("1");
    await page.getByRole("button", { name: "Create return" }).click();
    // Redirected back to the accessible fallback, never the (inaccessible) detail page.
    await expect(page).toHaveURL(`/${owner.businessId}/returns/new?created=1`);
    await expect(page.getByTestId("return-created-banner")).toBeVisible();
  });

  test("G: a wrong-branch sale is unavailable to a returns.manage caller assigned to a different branch", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-wrong-branch");
    const branchB = await createBranch(owner.client, owner.businessId, { name: "E2E Ret Branch B" });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret WrongBranch ${suffix}`, 1000, {
      trackInventory: false,
    });
    const creator = await createBranchAssignedMember("e2e-ret-wb-creator", owner.businessId, owner.client, branchB);
    const saleId = await createCompletedSale(creator.client, owner.businessId, productId, 2, branchB);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    // A second member, assigned only to the DEFAULT branch (never Branch B).
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const other = await createBranchAssignedMember("e2e-ret-wb-other", owner.businessId, owner.client, defaultBranchId);

    await loginAsInBrowser(page, other.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    // The Branch B sale never appears in this caller's own picker
    // results at all — never disclosed as existing-but-inaccessible.
    await expect(page.getByTestId("sale-picker-results")).toContainText("No matching completed sales.");
  });

  test("H: return detail renders items, snapshot fields, and no mutation controls", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-detail");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Detail ${suffix}`, 1000);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 3);
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId);
    const { data: returnId } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItems![0].id, quantity: 1, restock: true }],
      p_refund_amount: 1000,
      p_refund_method: "CASH",
      p_reason: "WRONG_ITEM",
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/${returnId}`);
    await expect(page.getByText(`E2E Ret Detail ${suffix}`)).toBeVisible();
    await expect(page.getByText("Wrong item")).toBeVisible();
    await expect(page.getByText("NGN 1,000.00").first()).toBeVisible();
    await expect(page.getByText("Restocked")).toBeVisible();
    // Immutable history — no edit/delete/void affordance anywhere.
    await expect(page.getByRole("button", { name: /^(edit|delete|void)$/i })).toHaveCount(0);
  });

  test("I: double-submit is idempotent — a second click while a request is already in flight never creates a second return", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-doublesubmit");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const productId = await createCustomProduct(owner.client, owner.businessId, `E2E Ret Double ${suffix}`, 500);
    const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 3);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/returns/new`);
    await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
    await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();
    const row = page.getByTestId(/^return-line-/);
    await row.getByRole("checkbox", { name: /Include/ }).check();
    await row.getByLabel(/Quantity to return/).fill("1");

    const submit = page.getByRole("button", { name: "Create return" });
    // Two rapid clicks — the SubmitButton's own pending-disable (never
    // client-disable ALONE — the creation_key stays fixed regardless)
    // guards this; the DB's own idempotency ledger is the real authority.
    await Promise.all([submit.click(), submit.click()]);
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
  });

  // Re-tested at all three named viewports (375/768/1440) — mirrors
  // invoices.spec.ts's own identical three-width pattern.
  for (const width of [375, 768, 1440]) {
    test(`J: return create and detail are usable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await createOwnerAndBusiness(`e2e-ret-width-${width}`);
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // A deliberately long product/branch name (Codex-style adversarial
      // width smoke) to prove long content never forces the page wider
      // than the viewport.
      const productId = await createCustomProduct(
        owner.client,
        owner.businessId,
        `E2E Width Return Product With An Unusually Long Descriptive Name ${suffix}`,
        1250
      );
      const saleId = await createCompletedSale(owner.client, owner.businessId, productId, 2);
      const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();

      await loginAsInBrowser(page, owner.email, PASSWORD);
      await page.goto(`/${owner.businessId}/returns/new`);
      await page.getByLabel("Sale").fill(saleRow!.sale_number as string);
      await page.getByTestId("sale-picker-results").getByText(saleRow!.sale_number as string, { exact: false }).click();

      let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

      const row = page.getByTestId(/^return-line-/);
      await row.getByRole("checkbox", { name: /Include/ }).check();
      await row.getByLabel(/Quantity to return/).fill("1");
      await page.getByRole("button", { name: "Create return" }).click();
      await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/returns/[0-9a-f-]{36}$`));

      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  test("K: the dashboard sidebar links to Returns under Operations", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-ret-nav");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}`);
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: "Returns" })).toBeVisible();
  });
});
