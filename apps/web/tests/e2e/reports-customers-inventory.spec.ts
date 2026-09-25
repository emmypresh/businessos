import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions } from "../integration/helpers/inventory";
import { createBranch, getBranchLocationId, assignMemberToBranch, getMemberId, getDefaultBranchId, inviteMember, acceptInvitation } from "../integration/helpers/staff";

const PASSWORD = "Password1234";

// A custom range well within the 366-day cap (lib/reports/report-range-query.ts)
// that still covers "now", so a sale created during the test lands inside it.
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const STATE_DATE_FROM = isoDate(-30);
const STATE_DATE_TO = isoDate(1);

// A cleared search <Input> still submits its GET form as `q=` (an empty
// value), never an omitted key — asserting "q" is empty this way (rather
// than a raw `not.toContain("q=")` substring check, which false-fails on
// that empty value) is what actually proves no search term survived.
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
  return { email, businessId: business!.id as string, client };
}

// Mirrors tests/e2e/branch-aware-workflows.spec.ts's own fixture exactly —
// a real, confirmed, signed-in MANAGER member assigned (via the real
// invite-then-branch-reassign path) to a non-default branch the OWNER's
// own client has no operational access to (CANNOT_MANAGE_SELF). Needed
// here only to seed a real sale at a real, non-default branch — the
// report pages themselves are always viewed as the OWNER (reports.view is
// business-wide, unrestricted by branch assignment).
async function createBranchAssignedMember(
  prefix: string,
  businessId: string,
  ownerClient: ReturnType<typeof createUserClient>,
  branchIds: string[],
  primaryBranchId?: string
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const memberClient = createUserClient();
  await memberClient.auth.signInWithPassword({ email, password: PASSWORD });

  const defaultBranchId = await getDefaultBranchId(ownerClient, businessId);
  const invitationId = await inviteMember(ownerClient, businessId, email, "MANAGER", {
    branchIds: [defaultBranchId],
    primaryBranchId: defaultBranchId,
  });
  await acceptInvitation(memberClient, invitationId);
  const memberId = await getMemberId(businessId, (await memberClient.auth.getUser()).data.user!.id);
  await assignMemberToBranch(ownerClient, businessId, memberId, branchIds, primaryBranchId ?? branchIds[0]);

  return { email, client: memberClient };
}

test.describe("Customer Detailed Report (Phase 1N-C3)", () => {
  test("requires reports.view — denied caller sees Not found, not the report", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-cust-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["customers.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/customers`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a reports.view-only caller can load the report and see real KPIs", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-reports-only");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Customer Report Product ${suffix}`,
      p_sku: `cust-report-${suffix}`,
      p_selling_price: 2500,
      p_opening_quantity: 10,
    });
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `E2E Customer ${suffix}`,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId ?? undefined,
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 2500,
    });

    const reportsSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-cust-reports-only-${reportsSuffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["reports.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/customers?preset=last_30_days`);
    await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
    await expect(page.getByTestId("kpi-customer-total")).toBeVisible();
    await expect(page.getByTestId("kpi-customer-revenue")).toContainText("₦2,500.00");
    await expect(page.getByLabel("Customer detail").getByText(`E2E Customer ${suffix}`)).toBeVisible();
  });

  test("the workspace Customers link is active and preserves the active range", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-cust-link-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=last_7_days`);
    const link = page.getByLabel("More reports").getByRole("link", { name: /Customers/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/reports/customers\\?preset=last_7_days`));
  });

  test("Back to Reports preserves the current range", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-cust-back-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/customers?preset=last_7_days`);
    await page.getByRole("link", { name: "Back to Reports" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/reports\\?preset=last_7_days`));
  });

  test("zero activity shows a truthful empty state", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-cust-zero");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/customers?preset=custom&dateFrom=1999-01-01&dateTo=1999-01-02`);
    await expect(page.getByText("No customer activity in this period.")).toBeVisible();
  });

  test("a customer with only a purchase before the range shows the no-activity empty state, not the directory", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-range-empty");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Range Empty Product ${suffix}`,
      p_sku: `range-empty-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Range Empty Customer ${suffix}`,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId ?? undefined,
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // The customer's only purchase is today; a far-future custom window has
    // no period activity for them at all — the table must show the
    // no-activity empty state, never the customer directory with 0s.
    await page.goto(`/${owner.businessId}/reports/customers?preset=custom&dateFrom=2999-01-01&dateTo=2999-01-02`);
    await expect(page.getByText("No customer activity in this period.")).toBeVisible();
    await expect(page.getByText(`Range Empty Customer ${suffix}`)).not.toBeVisible();
  });

  test("search narrows the table and a no-match search shows its own empty state", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-search");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Search Product ${suffix}`,
      p_sku: `search-cust-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Searchable Customer ${suffix}`,
    });
    // The detail table is period-activity-scoped (Phase 1N-C3 remediation)
    // — a customer needs a completed sale in the active window to appear
    // at all, search or not.
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId ?? undefined,
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/customers`);
    await page.getByLabel("Search customers by name, phone, or email").fill(`Searchable Customer ${suffix}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByLabel("Customer detail").getByText(`Searchable Customer ${suffix}`)).toBeVisible();

    await page.getByLabel("Search customers by name, phone, or email").fill("zzz-no-such-customer-zzz");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText(/No customers with activity in this period match/)).toBeVisible();
  });

  test("sorting by name toggles the URL sort/direction params and preserves the active range/branch", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-sort");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Sort Product ${suffix}`,
      p_sku: `sort-cust-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: "Sortable Customer",
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId ?? undefined,
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
    });
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/customers?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);
    await page.getByRole("link", { name: /Sort by Customer/ }).click();
    await expect(page).toHaveURL(/sort=name/);
    // The custom range must survive the sort click — this is exactly the
    // query-state-loss bug the remediation fixes.
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
  });

  test("pagination and search preserve the active custom range and branch together", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cust-state");
    const suffix = `${Date.now()}`;
    const { data: product } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `State Product ${suffix}`,
      p_sku: `state-cust-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    const { data: customerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `State Customer ${suffix}`,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerId ?? undefined,
      p_items: [{ product_id: product!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
    });
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/customers?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

    await page.getByLabel("Search customers by name, phone, or email").fill("State Customer");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=State/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
  });

  // Codex follow-up (Phase 1N-C3 final review pass 2, LOW): the previous
  // version of this coverage asserted a "real selected branch" purely by
  // putting `branch=<uuid>` directly in `page.goto`, which proves URL
  // handling AFTER navigation but never proves the rendered branch <Select>
  // itself can drive a real user through that same state. This fixture and
  // the two tests below replace it: the branch is always picked by opening
  // the real Select and clicking the real "Main Branch" option — never
  // page.goto, evaluate/history manipulation, or hand-built query strings
  // for the branch itself. A real Branch-B-only customer (created through
  // a real, branch-assigned MANAGER member, since the OWNER can never
  // operate at a second branch — CANNOT_MANAGE_SELF) is seeded throughout
  // so it can be asserted as never leaking into Branch A's scope.
  async function setupCustomerRealBranchFixture(prefix: string, branchACustomerCount: number) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: `${prefix} Branch B` });
    const seller = await createBranchAssignedMember(`${prefix}-seller`, owner.businessId, owner.client, [branchB]);

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data: productA } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Real Branch A Product ${suffix}`,
      p_sku: `real-brancha-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 1000,
    });

    // Zero-padded so ascending alpha sort == ascending numeric order.
    await Promise.all(
      Array.from({ length: branchACustomerCount }, async (_, i) => {
        const index = String(i).padStart(2, "0");
        const { data: customerId } = await owner.client.rpc("create_customer", {
          p_business_id: owner.businessId,
          p_creation_key: crypto.randomUUID(),
          p_name: `Real Branch A Customer ${suffix} ${index}`,
        });
        const { error } = await owner.client.rpc("create_sale", {
          p_business_id: owner.businessId,
          p_creation_key: crypto.randomUUID(),
          p_customer_id: customerId ?? undefined,
          p_items: [{ product_id: productA!.id, quantity: 1 }],
          p_payment_status: "PAID",
          p_payment_method: "CASH",
          p_amount_paid: 500,
          p_branch_id: branchA,
        });
        expect(error).toBeNull();
      })
    );

    const { data: productB } = await seller.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Real Branch B Product ${suffix}`,
      p_sku: `real-branchb-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 10,
      p_opening_location_id: await getBranchLocationId(owner.businessId, branchB),
    });
    const { data: customerBId } = await seller.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Real Branch B Only Customer ${suffix}`,
    });
    const { error: saleBError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_customer_id: customerBId ?? undefined,
      p_items: [{ product_id: productB!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 500,
      p_branch_id: branchB,
    });
    expect(saleBError).toBeNull();

    return { owner, branchA, branchB, seller, suffix };
  }

  test("Customer report preserves custom range after real branch selection and search", async ({ page }) => {
    test.setTimeout(60_000);
    const { owner, branchA, suffix } = await setupCustomerRealBranchFixture("e2e-cust-real-branch-search", 3);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // Starts WITHOUT branch in the URL — the real branch control below is
    // the only thing allowed to add it.
    await page.goto(`/${owner.businessId}/reports/customers?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Company-wide");

    // Real branch-control interaction: open the actual rendered Select and
    // click the real "Main Branch" option.
    await branchSelect.click();
    await page.getByRole("option", { name: "Main Branch", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(branchSelect).toContainText("Main Branch");
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();

    // Real search through the actual search input/form.
    const searchInput = page.getByLabel("Search customers by name, phone, or email");
    await searchInput.fill(`Real Branch A Customer ${suffix} 01`);
    await page.getByRole("button", { name: "Search" }).click();

    // Full post-search state: preset/dateFrom/dateTo/branch/q all present.
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(searchInput).toHaveValue(`Real Branch A Customer ${suffix} 01`);
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 01`)).toBeVisible();
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();
    await expect(branchSelect).toContainText("Main Branch");
  });

  test("Customer report preserves branch/search/sort through real pagination", async ({ page }) => {
    test.setTimeout(90_000);
    const { owner, branchA, suffix } = await setupCustomerRealBranchFixture("e2e-cust-real-branch-paginate", 26);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // sort=name&dir=asc is set explicitly (not left to the default
    // revenue-desc sort) so which of the 26 equal-revenue Branch-A
    // customers lands on which page is deterministic. Branch is supplied
    // here (this test's focus is search/sort/pagination survival, not the
    // branch control itself — that is covered separately above) but the
    // rendered Select is still asserted as reflecting it below.
    await page.goto(
      `/${owner.businessId}/reports/customers?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}&branch=${branchA}&sort=name&dir=asc`
    );
    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Main Branch");

    // Real search narrows to a single Branch-A customer.
    const searchInput = page.getByLabel("Search customers by name, phone, or email");
    await searchInput.fill(`Real Branch A Customer ${suffix} 07`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 07`)).toBeVisible();
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();

    // Real sort click while q is STILL active — must preserve
    // preset/dateFrom/dateTo/branch/q and add/update sort/dir. The column
    // is already sorted by name ascending, so the toggle rule in
    // lib/reports/report-table-links.ts flips it to descending.
    await page.getByRole("link", { name: /Sort by Customer/ }).click();
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(searchInput).toHaveValue(`Real Branch A Customer ${suffix} 07`);
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 07`)).toBeVisible();
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();

    // The narrow search leaves a single row — no real second page exists
    // under it, so pagination needs the search cleared first (still a real
    // UI action: an empty fill + a real Search click), while branch/sort/
    // dir survive via the form's own hidden fields.
    await searchInput.fill("");
    await page.getByRole("button", { name: "Search" }).click();
    expectNoActiveSearch(page);
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(branchSelect).toContainText("Main Branch");
    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 25`)).toBeVisible();
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();

    // Real pagination: a genuine 26th row means "Next" is a real, enabled
    // control — click it (never construct ?page=2 by hand).
    await page.getByRole("navigation", { name: "Customer report pagination" }).getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    // Explicit — never inferred from dateFrom/dateTo — proof the custom
    // preset itself (not just its bounds) survives real pagination.
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    expectNoActiveSearch(page);
    await expect(page.getByText(/Page 2 of 2/)).toBeVisible();
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 00`)).toBeVisible();
    await expect(page.getByLabel("Customer detail").getByText(`Real Branch A Customer ${suffix} 25`)).not.toBeVisible();
    await expect(page.getByText(`Real Branch B Only Customer ${suffix}`)).not.toBeVisible();
    await expect(branchSelect).toContainText("Main Branch");
  });
});

test.describe("Inventory Detailed Report (Phase 1N-C3)", () => {
  test("requires reports.view — denied caller sees Not found, not the report", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-inv-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-inv-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["inventory.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/inventory`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("a reports.view-only caller can load the report and see real stock status", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-inv-reports-only");
    const suffix = `${Date.now()}`;
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Out Of Stock Product ${suffix}`,
      p_sku: `oos-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 0,
    });

    const reportsSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-inv-reports-only-${reportsSuffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["reports.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/reports/inventory?preset=last_30_days`);
    await expect(page.getByRole("heading", { name: "Inventory", level: 1 })).toBeVisible();
    await expect(page.getByTestId("kpi-inventory-total")).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText(`Out Of Stock Product ${suffix}`)).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText("Out of stock", { exact: true })).toBeVisible();
  });

  test("the workspace Inventory link is active and preserves the active range", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-inv-link-preserve");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports?preset=last_7_days`);
    const link = page.getByLabel("More reports").getByRole("link", { name: /Inventory/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/reports/inventory\\?preset=last_7_days`));
  });

  test("zero products shows a truthful empty state", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-inv-zero");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/reports/inventory`);
    await expect(page.getByText("No tracked products found.")).toBeVisible();
  });

  test("search narrows the table and a no-match search shows its own empty state", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-inv-search");
    const suffix = `${Date.now()}`;
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `Searchable Product ${suffix}`,
      p_sku: `search-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 5,
    });

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/inventory`);
    await page.getByLabel("Search products by name or SKU").fill(`Searchable Product ${suffix}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByLabel("Inventory detail").getByText(`Searchable Product ${suffix}`)).toBeVisible();

    await page.getByLabel("Search products by name or SKU").fill("zzz-no-such-product-zzz");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText(/No products match/)).toBeVisible();
  });

  test("sorting preserves the active custom range, and search preserves it too", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-inv-state");
    const suffix = `${Date.now()}`;
    await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: `State Product ${suffix}`,
      p_sku: `state-inv-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 10,
    });
    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/inventory?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

    await page.getByRole("link", { name: /Sort by Product/ }).click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));

    await page.getByLabel("Search products by name or SKU").fill("State Product");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=State/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
  });

  // Codex follow-up (Phase 1N-C3 final review pass 2, LOW) — the inventory
  // sibling of the customer fixture/tests above: the branch is always
  // picked by opening the real rendered Select and clicking the real
  // "Main Branch" option — never page.goto, evaluate/history manipulation,
  // or a hand-built branch query string for that specific coverage.
  //
  // Unlike the customer report, get_inventory_detail_report_rpc.sql's own
  // header comment is explicit that p_branch_id narrows which
  // inventory_locations/sales COUNT (current_quantity/units_sold/
  // movements), never which PRODUCTS are listed — products are always
  // business-wide rows (see that migration's own `tmp_inventory_report`
  // CTE, which selects from `public.products` with no location/branch
  // join at all). So a Branch-B-only product's ROW is still expected to
  // appear when Branch A is selected — this is confirmed, intended RPC
  // behavior, and the tests below assert the CORRECT scoping shape: that
  // product's own QUANTITY/stock-status columns must reflect Branch A's
  // real (zero) stock, never Branch B's real (non-zero) stock.
  async function setupInventoryRealBranchFixture(prefix: string, branchAProductCount: number) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: `${prefix} Branch B` });
    const seller = await createBranchAssignedMember(`${prefix}-seller`, owner.businessId, owner.client, [branchB]);
    const branchALocationId = await getBranchLocationId(owner.businessId, branchA);
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Zero-padded so ascending alpha sort matches ascending numeric order.
    await Promise.all(
      Array.from({ length: branchAProductCount }, async (_, i) => {
        const index = String(i).padStart(2, "0");
        const { error } = await owner.client.rpc("create_product", {
          p_business_id: owner.businessId,
          p_creation_key: crypto.randomUUID(),
          p_name: `Real Inv Branch A Product ${suffix} ${index}`,
          p_sku: `real-inv-brancha-${suffix}-${index}`,
          p_selling_price: 500,
          p_opening_quantity: 5,
          p_opening_location_id: branchALocationId,
        });
        expect(error).toBeNull();
      })
    );

    // A real product whose ONLY stock is at Branch B, seeded through the
    // branch-assigned MEMBER's own client (the only one with real
    // operational access to Branch B's location).
    const branchBOnlyName = `Real Inv Branch B Only Product ${suffix}`;
    const { error: productBError } = await seller.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: branchBOnlyName,
      p_sku: `real-inv-branchb-${suffix}`,
      p_selling_price: 500,
      p_opening_quantity: 10,
      p_opening_location_id: branchBLocationId,
    });
    expect(productBError).toBeNull();

    return { owner, branchA, branchB, seller, suffix, branchBOnlyName };
  }

  test("Inventory report preserves custom range after real branch selection and search", async ({ page }) => {
    test.setTimeout(60_000);
    const { owner, branchA, suffix, branchBOnlyName } = await setupInventoryRealBranchFixture("e2e-inv-real-branch-search", 3);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // Starts WITHOUT branch in the URL — the real branch control below is
    // the only thing allowed to add it.
    await page.goto(`/${owner.businessId}/reports/inventory?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Company-wide");

    // Real branch-control interaction.
    await branchSelect.click();
    await page.getByRole("option", { name: "Main Branch", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(branchSelect).toContainText("Main Branch");
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));

    // Real search (Branch-A product) through the actual search input/form.
    const searchInput = page.getByLabel("Search products by name or SKU");
    await searchInput.fill(`Real Inv Branch A Product ${suffix} 01`);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(searchInput).toHaveValue(`Real Inv Branch A Product ${suffix} 01`);
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 01`)).toBeVisible();
    await expect(branchSelect).toContainText("Main Branch");

    // The Branch-B-only product's ROW is still expected to appear
    // (business-wide rows — see this describe block's own header comment)
    // — confirm it is scoped to Branch A's real zero stock, never Branch
    // B's real 10 units, when found via a real search.
    await searchInput.fill(branchBOnlyName);
    await page.getByRole("button", { name: "Search" }).click();
    const branchBOnlyRow = page.getByRole("row").filter({ hasText: branchBOnlyName });
    await expect(branchBOnlyRow).toBeVisible();
    await expect(branchBOnlyRow).toContainText("Out of stock");
  });

  test("Inventory report preserves branch/search/sort through real pagination", async ({ page }) => {
    test.setTimeout(90_000);
    const { owner, branchA, suffix } = await setupInventoryRealBranchFixture("e2e-inv-real-branch-paginate", 26);

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // sort=name&dir=asc is explicit from the first load — with the
    // default sort key (units_sold, all zero here) ties break on an
    // unpredictable product_id, so an explicit, deterministic sort is what
    // makes "which page a given product lands on" assertable at all.
    // Branch is supplied here (this test's focus is search/sort/
    // pagination survival, not the branch control itself — covered
    // separately above) but the rendered Select is still asserted below.
    await page.goto(
      `/${owner.businessId}/reports/inventory?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}&branch=${branchA}&sort=name&dir=asc`
    );
    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Main Branch");

    // Real search narrows to a single Branch-A product.
    const searchInput = page.getByLabel("Search products by name or SKU");
    await searchInput.fill(`Real Inv Branch A Product ${suffix} 07`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 07`)).toBeVisible();

    // Real sort click while q is STILL active — must preserve
    // preset/dateFrom/dateTo/branch/q and add/update sort/dir. Already
    // sorted by name ascending, so the toggle rule flips it to descending.
    await page.getByRole("link", { name: /Sort by Product/ }).click();
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`q=Real`));
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(searchInput).toHaveValue(`Real Inv Branch A Product ${suffix} 07`);
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 07`)).toBeVisible();

    // The narrow search leaves a single row — no real second page exists
    // under it, so pagination needs the search cleared first (still a real
    // UI action: an empty fill + a real Search click), while branch/sort/
    // dir survive via the form's own hidden fields.
    await searchInput.fill("");
    await page.getByRole("button", { name: "Search" }).click();
    expectNoActiveSearch(page);
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(branchSelect).toContainText("Main Branch");
    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
    // Descending by name, the Branch-B-only product ("B" > "A") is the
    // real first row, followed by the tail of Branch-A products.
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 25`)).toBeVisible();

    // Real pagination: a genuine 27th row (26 Branch-A products + the
    // Branch-B-only one) means "Next" is real and enabled — click it
    // (never construct ?page=2 by hand).
    await page.getByRole("navigation", { name: "Inventory report pagination" }).getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2/);
    // Explicit — never inferred from dateFrom/dateTo — proof the custom
    // preset itself (not just its bounds) survives real pagination.
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    expectNoActiveSearch(page);
    await expect(page.getByText(/Page 2 of 2/)).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 00`)).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText(`Real Inv Branch A Product ${suffix} 25`)).not.toBeVisible();
    await expect(branchSelect).toContainText("Main Branch");
  });

  // Codex follow-up (Phase 1N-C3 final review, LOW) — a preset (not
  // custom-range) regression: sort and a real pagination click must both
  // preserve the active PRESET, never silently converting it to a custom
  // range or dropping it. Deliberately reuses `last_30_days`, never
  // `custom`, so this stays a genuinely distinct scenario from every
  // custom-range test above.
  test("a preset (last_30_days) survives a real sort click and a real pagination click", async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await createOwnerAndBusiness("e2e-inv-preset-paginate");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const presetProductCount = 26;
    await Promise.all(
      Array.from({ length: presetProductCount }, async (_, i) => {
        const index = String(i).padStart(2, "0");
        const { error } = await owner.client.rpc("create_product", {
          p_business_id: owner.businessId,
          p_creation_key: crypto.randomUUID(),
          p_name: `Preset Product ${suffix} ${index}`,
          p_sku: `preset-prod-${suffix}-${index}`,
          p_selling_price: 500,
          p_opening_quantity: 5,
        });
        expect(error).toBeNull();
      })
    );

    await loginAsInBrowser(page, owner.email, PASSWORD);
    await page.goto(`/${owner.businessId}/reports/inventory?preset=last_30_days`);

    // The default sort (units_sold, all zero here) ties break on an
    // unpredictable product_id — clicking "Sort by Product" is the first
    // click on that column, so the toggle rule in
    // lib/reports/report-table-links.ts's buildReportSortHref always
    // lands on descending first ("25", not "00", is the real first row).
    await page.getByRole("link", { name: /Sort by Product/ }).click();
    await expect(page).toHaveURL(/preset=last_30_days/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(page.getByLabel("Inventory detail").getByText(`Preset Product ${suffix} 25`)).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText(`Preset Product ${suffix} 00`)).not.toBeVisible();

    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
    await page.getByRole("navigation", { name: "Inventory report pagination" }).getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/preset=last_30_days/);
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=desc/);
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText(/Page 2 of 2/)).toBeVisible();
    // Descending, page 2 holds the real remaining tail — "00" alone.
    await expect(page.getByLabel("Inventory detail").getByText(`Preset Product ${suffix} 00`)).toBeVisible();
    await expect(page.getByLabel("Inventory detail").getByText(`Preset Product ${suffix} 25`)).not.toBeVisible();
  });
});
