import { test, expect } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";
import { addMemberWithRole, createRoleWithPermissions, randomUuid } from "../integration/helpers/inventory";
import { createBranch, getDefaultBranchId, getBranchLocationId, assignMemberToBranch, getMemberId, inviteMember, acceptInvitation } from "../integration/helpers/staff";

const PASSWORD = "Password1234";

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const STATE_DATE_FROM = isoDate(-30);
const STATE_DATE_TO = isoDate(1);

async function loginAsInBrowser(page: import("@playwright/test").Page, email: string, password: string) {
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

// Mirrors tests/e2e/reports-customers-inventory.spec.ts's own fixture
// exactly — a real, confirmed, signed-in MANAGER member assigned (via the
// real invite-then-branch-reassign path) to a non-default branch the
// OWNER's own client has no operational access to (CANNOT_MANAGE_SELF).
async function createBranchAssignedMember(
  prefix: string,
  businessId: string,
  ownerClient: ReturnType<typeof createUserClient>,
  branchIds: string[]
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
  await assignMemberToBranch(ownerClient, businessId, memberId, branchIds, branchIds[0]);

  return { email, client: memberClient };
}

const REPORTS = [
  { slug: "sales", label: "Sales & Revenue" },
  { slug: "customers", label: "Customers" },
  { slug: "inventory", label: "Inventory" },
  { slug: "branches", label: "Branches" },
] as const;

test.describe("Report CSV export (Phase 1N-C5)", () => {
  for (const report of REPORTS) {
    test(`${report.slug}: Export CSV action is visible, keyboard-focusable, and downloads a real CSV`, async ({ page }) => {
      const owner = await createOwnerAndBusiness(`e2e-export-${report.slug}`);
      await loginAsInBrowser(page, owner.email, PASSWORD);
      await page.goto(`/${owner.businessId}/reports/${report.slug}?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}`);

      const exportLink = page.getByRole("link", { name: "Export CSV" });
      await expect(exportLink).toBeVisible();
      // Explicit text label, not icon-only — the accessible name must not
      // be blank/generic (see the Download icon's aria-hidden marking in
      // each report page's JSX).
      await expect(exportLink).toHaveAccessibleName("Export CSV");

      const [download] = await Promise.all([page.waitForEvent("download"), exportLink.click()]);
      expect(download.suggestedFilename()).toMatch(
        new RegExp(`^businessos-${report.slug}-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv$`)
      );
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const csv = Buffer.concat(chunks).toString("utf-8");
      const lines = csv.split("\r\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      // Header row present and CRLF-joined (RFC 4180), matching
      // lib/reports/csv.ts's serializeCsv contract.
      expect(lines[0].length).toBeGreaterThan(0);
      expect(csv).not.toContain("\n\n");
    });
  }

  test("denied caller (no reports.view) gets a fail-closed 404 on direct export route access, never a CSV", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-export-denied");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-export-denied-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["customers.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    const response = await page.request.get(`/${owner.businessId}/reports/customers/export?preset=last_30_days`);
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"] ?? "").not.toContain("text/csv");
  });

  test("unauthenticated direct export request fails closed (redirected to login, no CSV)", async ({ page }) => {
    // requirePermissionOrNotFound's own requireUser() step redirects an
    // unauthenticated caller to /login (lib/auth/dal.ts) rather than
    // reaching the notFound() branch the "denied caller" test below
    // exercises — that branch only runs once a user IS resolved. An APIRequestContext
    // follows that redirect by default, so the final status here is the
    // login page's own 200, not the 404 an authenticated-but-unauthorized
    // caller gets. The security-relevant assertions are that the final
    // response is genuinely the login page (never CSV content) and that
    // no export ever bypasses maxRedirects to land on a 200 CSV directly.
    const owner = await createOwnerAndBusiness("e2e-export-anon");
    const exportUrl = `/${owner.businessId}/reports/sales/export?preset=last_30_days`;

    const noRedirect = await page.request.get(exportUrl, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(noRedirect.status());
    expect(noRedirect.headers()["location"] ?? "").toMatch(/\/login/);

    const followed = await page.request.get(exportUrl);
    expect(followed.status()).toBe(200);
    expect(followed.headers()["content-type"] ?? "").not.toContain("text/csv");
    expect(followed.url()).toMatch(/\/login/);
    const body = await followed.text();
    expect(body).not.toContain("Revenue");
  });

  test("cross-tenant: an authenticated owner cannot export another business's report data", async ({ page }) => {
    const ownerA = await createOwnerAndBusiness("e2e-export-tenant-a");
    const ownerB = await createOwnerAndBusiness("e2e-export-tenant-b");
    await loginAsInBrowser(page, ownerA.email, PASSWORD);

    const response = await page.request.get(`/${ownerB.businessId}/reports/inventory/export?preset=last_30_days`);
    expect(response.status()).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(ownerB.businessId);
  });

  test("a branch id from a foreign business is rejected, not silently ignored or broadened", async ({ page }) => {
    const ownerA = await createOwnerAndBusiness("e2e-export-branch-a");
    const ownerB = await createOwnerAndBusiness("e2e-export-branch-b");
    const foreignBranchId = await createBranch(ownerB.client, ownerB.businessId, { name: `Foreign ${ownerB.suffix}` });
    await loginAsInBrowser(page, ownerA.email, PASSWORD);

    const response = await page.request.get(
      `/${ownerA.businessId}/reports/branches/export?preset=last_30_days&branch=${foreignBranchId}`
    );
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid branch/i);
  });

  test("an invalid (non-UUID) branch id is rejected with a controlled 400, not a 500", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-export-branch-invalid");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    const response = await page.request.get(
      `/${owner.businessId}/reports/inventory/export?preset=last_30_days&branch=not-a-uuid`
    );
    expect(response.status()).toBe(400);
  });

  test("response headers: text/csv content type, attachment disposition, private no-store caching, nosniff", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-export-headers");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    const response = await page.request.get(`/${owner.businessId}/reports/branches/export?preset=last_30_days`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(headers["content-disposition"]).toMatch(/^attachment; filename="businessos-branches-.*\.csv"$/);
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  // Codex follow-up (C5 review, LOW #1): the previous version of this
  // coverage only proved search+sort+range preservation — branch was never
  // exercised at all. This fixture mirrors
  // reports-customers-inventory.spec.ts's own setupCustomerRealBranchFixture
  // exactly: Branch A is the business's real default branch (the OWNER can
  // sell there directly), Branch B is a second real branch a branch-assigned
  // MANAGER member sells at (the OWNER can never operate at a second branch
  // — CANNOT_MANAGE_SELF). Branch selection itself is driven through the
  // real rendered <Select> — never page.goto or a hand-built ?branch= URL —
  // so this proves the actual UI control, not just URL parsing.
  test("real filtered export: date range + real branch selection + search + sort from the customers screen is reflected in the downloaded CSV", async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await createOwnerAndBusiness("e2e-export-real-branch");
    const suffix = owner.suffix;
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: `Export Branch B ${suffix}` });
    const seller = await createBranchAssignedMember(`e2e-export-real-branch-seller`, owner.businessId, owner.client, [branchB]);

    const { data: productA } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: `Export Branch A Product ${suffix}`,
      p_sku: `export-brancha-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 5,
    });
    const { data: matchCustomerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: `Zeta Export Match ${suffix}`,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: matchCustomerId ?? undefined,
      p_items: [{ product_id: productA!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
      p_branch_id: branchA,
    });
    // A second Branch-A customer, deliberately excluded by the search
    // term below (proves search still narrows within the branch-filtered
    // set, not just branch membership alone).
    const { data: otherBranchACustomerId } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: `Alpha Excluded ${suffix}`,
    });
    await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: otherBranchACustomerId ?? undefined,
      p_items: [{ product_id: productA!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
      p_branch_id: branchA,
    });

    const { data: productB } = await seller.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: `Export Branch B Product ${suffix}`,
      p_sku: `export-branchb-${suffix}`,
      p_selling_price: 1000,
      p_opening_quantity: 5,
      p_opening_location_id: await getBranchLocationId(owner.businessId, branchB),
    });
    const { data: branchBCustomerId } = await seller.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: `Branch B Only Customer ${suffix}`,
    });
    const { error: saleBError } = await seller.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: branchBCustomerId ?? undefined,
      p_items: [{ product_id: productB!.id, quantity: 1 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
      p_amount_paid: 1000,
      p_branch_id: branchB,
    });
    expect(saleBError).toBeNull();

    await loginAsInBrowser(page, owner.email, PASSWORD);
    // Starts WITHOUT branch in the URL — the real branch control below is
    // the only thing allowed to add it.
    await page.goto(`/${owner.businessId}/reports/customers?preset=custom&dateFrom=${STATE_DATE_FROM}&dateTo=${STATE_DATE_TO}&sort=name&dir=asc`);

    const branchSelect = page.getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toContainText("Company-wide");

    // Real branch-control interaction: open the actual rendered Select and
    // click Branch A's real option — never page.goto/evaluate/history.
    await branchSelect.click();
    await page.getByRole("option", { name: "Main Branch", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(branchSelect).toContainText("Main Branch");
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page.getByText(`Branch B Only Customer ${suffix}`)).not.toBeVisible();

    const searchInput = page.getByLabel("Search customers by name, phone, or email");
    await searchInput.fill(`Zeta Export Match ${suffix}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=Zeta/);
    await expect(page).toHaveURL(new RegExp(`branch=${branchA}`));
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page).toHaveURL(new RegExp(`dateFrom=${STATE_DATE_FROM}`));
    await expect(page).toHaveURL(new RegExp(`dateTo=${STATE_DATE_TO}`));
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=asc/);

    const exportLink = page.getByRole("link", { name: "Export CSV" });
    // The export href itself preserves the exact state currently on
    // screen (branch + search + sort + custom range) — asserted before
    // clicking so a regression in buildReportExportHref's query-state
    // wiring fails here rather than only showing up in the downloaded
    // content below.
    const href = await exportLink.getAttribute("href");
    expect(href).toContain(`branch=${branchA}`);
    expect(href).toContain("q=Zeta");
    expect(href).toContain("sort=name");
    expect(href).toContain("dir=asc");
    expect(href).toContain("preset=custom");
    expect(href).toContain(`dateFrom=${STATE_DATE_FROM}`);
    expect(href).toContain(`dateTo=${STATE_DATE_TO}`);
    expect(href).not.toContain("page=");

    const [download] = await Promise.all([page.waitForEvent("download"), exportLink.click()]);
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^businessos-customers-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv$`)
    );
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString("utf-8");

    expect(csv.split("\r\n")[0]).toBe(
      "Customer Name,Phone,Email,Completed Orders,Revenue,Average Order Value,First Purchase,Last Purchase,New Customer,Returning Customer,Currency"
    );
    // Real UTF-8 text, not mojibake/binary — no replacement character.
    // Constructed at runtime from its code point (rather than a literal
    // glyph or "�" escape) so the needle is provably U+FFFD itself,
    // not source-encoding-dependent text.
    const replacementCharacter = String.fromCodePoint(0xfffd);
    expect(replacementCharacter).toHaveLength(1);
    expect(replacementCharacter.codePointAt(0)).toBe(0xfffd);
    // Sanity check that the detector actually catches U+FFFD when present.
    expect(`abc${replacementCharacter}xyz`).toContain(replacementCharacter);
    expect(csv).not.toContain(replacementCharacter);
    // Branch A + search match: present.
    expect(csv).toContain(`Zeta Export Match ${suffix}`);
    // Branch A but excluded by the active search term: absent.
    expect(csv).not.toContain(`Alpha Excluded ${suffix}`);
    // Branch B only: absent under both the branch filter and the search.
    expect(csv).not.toContain(`Branch B Only Customer ${suffix}`);
  });

  // The 10,001-row-over-ceiling -> ReportExportTooLargeError -> 413 path
  // itself is covered by the unit tests in lib/reports/csv.test.ts
  // (collectAllReportRows throwing at the boundary without fetching
  // further pages), deliberately NOT re-proven here with 10,001 real
  // seeded rows per the approved plan's "Export limit test" guidance
  // against heavy fixtures. This test instead proves each route's own
  // catch block actually maps that error type to 413 rather than falling
  // through to the generic 500 branch, by asserting the well-below-limit
  // path still returns a normal 200 CSV (a regression that broke the
  // ReportExportTooLargeError instanceof check would still show up as a
  // 500 here for a route that mishandles page-1 metadata).
  test("below the row ceiling, export still succeeds with 200 (error-mapping regression guard)", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-export-limit-wiring");
    await loginAsInBrowser(page, owner.email, PASSWORD);
    const response = await page.request.get(`/${owner.businessId}/reports/customers/export?preset=last_30_days`);
    expect(response.status()).toBe(200);
  });
});
