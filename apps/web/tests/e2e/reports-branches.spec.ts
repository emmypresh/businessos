import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions, createMemberWithCustomPermissions, randomUuid } from "../integration/helpers/inventory";
import { createBranch, assignMemberToBranch, getMemberId } from "../integration/helpers/staff";
import { makeSaleProduct, makeCustomer, saleItem } from "../integration/helpers/sales";
import { createTestDbClient } from "../integration/helpers/db-client";

const PASSWORD = "Password1234";

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const STATE_DATE_FROM = isoDate(-30);
const STATE_DATE_TO = isoDate(1);

function expectNoActiveSearch(page: Page) {
  expect(new URL(page.url()).searchParams.get("q") ?? "").toBe("");
}

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
  return { email, businessId: business!.id as string, client, suffix };
}

async function backdateSaleCompletedAt(saleId: string, isoTimestamp: string) {
  const sql = createTestDbClient();
  try {
    await sql`update public.sales set completed_at = ${isoTimestamp}::timestamptz where id = ${saleId}`;
  } finally {
    await sql.end();
  }
}

// create_sale requires the CALLER's own operational branch access
// (private.has_branch_access) whenever an explicit p_branch_id is given —
// replace_member_branches forbids a caller from ever targeting their OWN
// membership, so the business owner can never self-grant access to a
// branch beyond their own default one. A dedicated seller must be created
// and assigned instead. The report itself is still always viewed as the
// OWNER (reports.view is business-wide, unrestricted by branch
// assignment) — mirrors reports-customers-inventory.spec.ts's own
// createBranchAssignedMember fixture, just for a plain sales.create
// permission rather than a full MANAGER invite.
async function createSellerAssignedToBranch(prefix: string, owner: Awaited<ReturnType<typeof createOwnerAndBusiness>>, branchId: string) {
  const seller = await createMemberWithCustomPermissions(owner.businessId, prefix, ["sales.create"]);
  const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
  await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchId], branchId);
  return seller;
}

test.describe("Branch Detailed Report (Phase 1N-C4)", () => {
  test("requires reports.view — denied caller sees Not found, not the report", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-branch-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-branch-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["branches.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/branches`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("shows the Branches link in the reports workspace navigation", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-branch-nav");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports`);
    // Scoped to the report-categories section — the sidebar's own
    // unrelated "Branches" (business-branch management) link also matches
    // a bare name-based locator.
    const link = page.getByLabel("More reports").getByRole("link", { name: /Branches/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/reports/branches`));
  });

  test("comparison table shows real per-branch revenue/sales, and real branch selection opens the drilldown", async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await createOwnerAndBusiness("e2e-branch-drilldown");
    const branchAId = await createBranch(owner.client, owner.businessId, { name: `Uptown ${owner.suffix}` });
    const seller = await createSellerAssignedToBranch("e2e-branch-drilldown", owner, branchAId);

    const customerId = await makeCustomer(owner.client, owner.businessId, { name: `Branch Customer ${owner.suffix}` });
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1500, trackInventory: false });

    const sale = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_items: [saleItem(product.id, 2)],
      p_branch_id: branchAId,
    });
    expect(sale.error).toBeNull();
    await backdateSaleCompletedAt(sale.data as string, new Date().toISOString());

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/branches?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

    // The branch name cell always renders as a link to its own drilldown.
    await expect(page.getByRole("link", { name: `Uptown ${owner.suffix}` })).toBeVisible();

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Company-wide");

    // Real branch-control interaction: open the actual rendered Select and
    // click the real branch option — never a hand-built ?branch= URL.
    await branchSelect.click();
    await page.getByRole("option", { name: `Uptown ${owner.suffix}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchAId}`));
    await expect(branchSelect).toContainText(`Uptown ${owner.suffix}`);
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));

    // The selected-branch drilldown section renders with the real numbers.
    await expect(page.getByRole("heading", { name: `Uptown ${owner.suffix}` })).toBeVisible();
    await expect(page.getByTestId("kpi-selected-revenue")).toContainText("3,000");
    // CardTitle renders as a plain styled <div>, not a heading element
    // (components/ui/card.tsx) — asserted by visible text, not ARIA role.
    await expect(page.getByText("Revenue trend")).toBeVisible();
    await expect(page.getByText("Top products by units sold")).toBeVisible();
  });

  test("real search narrows the comparison table by branch name", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-branch-search");
    await createBranch(owner.client, owner.businessId, { name: `Lekki ${owner.suffix}` });
    await createBranch(owner.client, owner.businessId, { name: `Yaba ${owner.suffix}` });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/branches`);

    const searchInput = page.getByLabel("Search branches by name or code");
    await searchInput.fill(`Lekki ${owner.suffix}`);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page).toHaveURL(/q=Lekki/);
    await expect(page.getByText(`Lekki ${owner.suffix}`)).toBeVisible();
    await expect(page.getByText(`Yaba ${owner.suffix}`)).not.toBeVisible();
  });

  test("preserves search/sort through real pagination", async ({ page }) => {
    test.setTimeout(90_000);
    const owner = await createOwnerAndBusiness("e2e-branch-paginate");
    for (let i = 0; i < 26; i += 1) {
      await createBranch(owner.client, owner.businessId, { name: `Paginate Branch ${owner.suffix} ${String(i).padStart(2, "0")}` });
    }

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/branches?sort=name&dir=asc`);

    const searchInput = page.getByLabel("Search branches by name or code");
    await searchInput.fill(`Paginate Branch ${owner.suffix}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=Paginate/);
    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
    await expect(page.getByText(`Paginate Branch ${owner.suffix} 00`)).toBeVisible();

    // Real sort click while q is STILL active.
    await page.getByRole("link", { name: /Sort by Branch/ }).click();
    await expect(page).toHaveURL(/q=Paginate/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);

    await searchInput.fill("");
    await page.getByRole("button", { name: "Search" }).click();
    expectNoActiveSearch(page);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);

    // Real pagination click — never a hand-built ?page=2 URL.
    await page.getByRole("navigation", { name: "Branch report pagination" }).getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    expectNoActiveSearch(page);
  });

  test("selecting an inactive branch surfaces its own historical drilldown even though it is absent from the comparison table", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-branch-inactive");
    const branchId = await createBranch(owner.client, owner.businessId, { name: `Retired ${owner.suffix}` });
    const sql = createTestDbClient();
    try {
      await sql`update public.business_branches set status = 'INACTIVE' where id = ${branchId}`;
    } finally {
      await sql.end();
    }

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/branches?branch=${branchId}`);

    // The comparison table itself never renders an INACTIVE branch as a row...
    await expect(page.getByRole("cell", { name: `Retired ${owner.suffix}`, exact: true })).toHaveCount(0);
    // ...but its own drilldown section, selected via the branch dropdown
    // (which DOES list INACTIVE branches — lib/branches/dal.ts's
    // listReportBranchOptions), still renders.
    await expect(page.getByRole("heading", { name: `Retired ${owner.suffix}` })).toBeVisible();
  });
});
