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
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id as string, client };
}

async function selectBaseUiOption(page: Page, comboboxName: string, optionName: string) {
  await page.getByRole("combobox", { name: comboboxName }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function fillMinimalExpenseForm(page: Page) {
  // Category and payment method default to a valid selection already
  // (ExpenseForm's own useState defaults) — only amount is required to
  // be filled in for a minimal valid submission.
  await page.getByLabel("Amount (NGN)").fill("1500");
}

test.describe("expenses", () => {
  test("record an expense and it appears in the expense list", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-record");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/expenses/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { name: /^EXP-\d{6}$/ })).toBeVisible();

    await page.goto(`/${businessId}/expenses`);
    await expect(page.getByText(/^EXP-\d{6}$/)).toBeVisible();
  });

  test("expense detail renders the category name snapshot, and a later category rename does not alter it", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-snapshot");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    await selectBaseUiOption(page, "Category", "Rent");
    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/expenses/[0-9a-f-]{36}$`));
    const expenseUrl = page.url();
    await expect(page.getByText("Rent")).toBeVisible();

    // Rename the "Rent" category via the categories management page.
    await page.goto(`/${businessId}/expenses/categories`);
    await page.getByRole("row", { name: /Rent/ }).getByRole("button", { name: "Rename" }).click();
    // exact: true — a substring match on "Name" would also match the
    // dialog's own accessible name ("Rename "Rent""), which itself
    // contains "name" as a substring.
    await page.getByLabel("Name", { exact: true }).fill("Renamed Rent E2E");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Renamed Rent E2E")).toBeVisible();

    await page.goto(expenseUrl);
    await expect(page.getByText("Rent", { exact: true })).toBeVisible();
    await expect(page.getByText("Renamed Rent E2E")).toHaveCount(0);
  });

  test("archiving a category removes it from the new-expense picker only — an expense already recorded against it keeps its historical label", async ({ page }) => {
    // Codex adversarial review, Finding 7.G: this test previously
    // archived "Utilities" WITHOUT first recording an expense against it,
    // so it never actually proved the "history is preserved" half of its
    // own title. It now creates that expense first, so the archive step
    // has real historical data to (not) disturb.
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-archive-cat");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    await selectBaseUiOption(page, "Category", "Utilities");
    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/expenses/[0-9a-f-]{36}$`));
    const expenseUrl = page.url();
    await expect(page.getByText("Utilities")).toBeVisible();

    await page.goto(`/${businessId}/expenses/categories`);
    await page.getByRole("row", { name: /Utilities/ }).getByRole("button", { name: "Archive category" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    // Archiving does not delete — the category remains listed, now
    // marked Archived (history preserved, not hidden).
    await expect(page.getByRole("row", { name: /Utilities/ }).getByText("Archived")).toBeVisible();

    // Removed from the ACTIVE-only picker for new expenses.
    await page.goto(`/${businessId}/expenses/new`);
    await page.getByRole("combobox", { name: "Category" }).click();
    await expect(page.getByRole("option", { name: "Utilities", exact: true })).toHaveCount(0);

    // The expense recorded BEFORE the archive still renders its
    // historical category_name_snapshot unchanged.
    await page.goto(expenseUrl);
    await expect(page.getByText("Utilities")).toBeVisible();
  });

  test("void an expense — it stays visible historically and cannot be voided twice", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-void");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/expenses/[0-9a-f-]{36}$`));
    const expenseUrl = page.url();

    await page.getByRole("button", { name: "Void expense" }).click();
    await page.getByLabel("Reason").fill("Recorded by mistake");
    await page.getByRole("button", { name: "Void", exact: true }).click();

    // "Voided" appears both in the header badge and in the "Record
    // history" definition list below — scoped to the badge specifically.
    await expect(page.getByTestId("expense-status-badge")).toHaveText("Voided");
    // The void button disappears once voided — no direct UI path to void
    // the same expense twice.
    await expect(page.getByRole("button", { name: "Void expense" })).toHaveCount(0);
    await expect(page.getByText("Recorded by mistake")).toBeVisible();

    // Still reachable and correctly rendered after a fresh navigation —
    // voiding never deletes the record.
    await page.goto(expenseUrl);
    await expect(page.getByTestId("expense-status-badge")).toHaveText("Voided");
  });

  test("a double-click submission does not create a duplicate expense", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-dup");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    await fillMinimalExpenseForm(page);

    await page.getByTestId("expense-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });

    await expect(page).toHaveURL(new RegExp(`/${businessId}/expenses/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/expenses?status=ALL`);
    const rows = page.getByRole("row").filter({ hasText: /^EXP-\d{6}/ });
    await expect(rows).toHaveCount(1);
  });

  test("an amount with more than 2 decimal places is blocked client-side", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-precision");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    const amountInput = page.getByLabel("Amount (NGN)");
    await amountInput.fill("1.234");
    const isValid = await amountInput.evaluate((el: HTMLInputElement) => el.checkValidity());
    expect(isValid).toBe(false);
  });

  test("a zero amount is blocked client-side", async ({ page }) => {
    const { email, businessId } = await createOwnerAndBusiness("e2e-exp-zero");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/expenses/new`);
    const amountInput = page.getByLabel("Amount (NGN)");
    await amountInput.fill("0");
    const isValid = await amountInput.evaluate((el: HTMLInputElement) => el.checkValidity());
    expect(isValid).toBe(false);
  });

  test("a manage-only user (no expenses.view) can record an expense and lands on an accessible success page, not the (inaccessible) list", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-exp-manage-only");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-exp-manage-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    // No seeded Phase 1E role is manage-only (every role with
    // expenses.manage also has expenses.view) — a deliberately
    // constructed one-off role exercises the split precisely, mirroring
    // sales-permissions.spec.ts's own precedent for testing a permission
    // boundary the seeded roles cannot isolate on their own.
    const roleName = await createRoleWithPermissions(["expenses.manage"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${owner.businessId}/expenses/new`);
    // Codex adversarial review, Finding 7.F: the hidden creationKey input
    // already exists in the DOM (it's how the mounted-intent pattern
    // submits the key at all) — reading its value here is test
    // introspection of state already present in the page, not a new
    // production exposure. This is what actually proves the post-create
    // remount mints a FRESH key, not just that the redirect landed on the
    // right URL.
    const firstCreationKey = await page.locator('input[name="creationKey"]').inputValue();
    expect(firstCreationKey).toMatch(/^[0-9a-f-]{36}$/);

    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();

    // Redirected back to /expenses/new — never to the (inaccessible)
    // detail page — with a generic success banner only.
    await expect(page).toHaveURL(new RegExp(`/${owner.businessId}/expenses/new\\?created=1$`));
    await expect(page.getByTestId("expense-created-banner")).toBeVisible();

    // The redirect is a full navigation (a Server Action redirect(), not
    // a client-side route transition) — ExpenseForm's
    // useState(() => crypto.randomUUID()) initializer therefore runs
    // again on this fresh mount. Proven directly: the new hidden
    // creationKey differs from the one captured before the first submit.
    const secondCreationKey = await page.locator('input[name="creationKey"]').inputValue();
    expect(secondCreationKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondCreationKey).not.toBe(firstCreationKey);
  });

  test("a view-only user (expenses.view, no expenses.manage) can browse, use the branch filter, and view an expense, but cannot record or void", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-exp-view-only");
    // A real, pre-existing expense the view-only user will later open
    // directly — the "cannot void" half of this test was previously
    // asserted only indirectly (via the absent "New expense" link); this
    // is what lets it check the Void control itself is genuinely absent
    // on a real expense detail page, not merely inferred from the list
    // page's own create-link visibility.
    const { data: category } = await owner.client
      .from("expense_categories")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("name", "Rent")
      .single();
    const { data: expenseId } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: crypto.randomUUID(),
      p_category_id: category!.id,
      p_amount: 1200,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-exp-view-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    // No seeded Phase 1E role is view-only for expenses (every role that
    // has expenses.view also has expenses.manage) — a deliberately
    // constructed one-off role exercises the split precisely, mirroring
    // the manage-only test above.
    const roleName = await createRoleWithPermissions(["expenses.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses`);
    await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New expense" })).toHaveCount(0);
    // Branch filter metadata resolves for this expenses.view-only caller
    // too (get_business_branch_options' own "expenses" scope is
    // authorized on expenses.view OR expenses.manage — see
    // 20260830080000_branch_option_rpc.sql) — the control renders with a
    // real, human-readable default, never crashing the whole page the
    // way an unhandled insufficient_privilege from that RPC once did.
    const branchFilter = page.getByRole("combobox", { name: "Branch" });
    await expect(branchFilter).toBeVisible();
    await expect(branchFilter).toContainText("All branches");

    // /new independently requires expenses.manage — inaccessible here.
    await page.goto(`/${owner.businessId}/expenses/new`);
    await expect(page.getByText("Not found")).toBeVisible();

    // The real, pre-existing expense is viewable (expenses.view is
    // exactly what backs the detail page)...
    await page.goto(`/${owner.businessId}/expenses/${expenseId}`);
    await expect(page.getByRole("heading", { name: /^EXP-\d{6}$/ })).toBeVisible();
    // ...but its Void control is genuinely absent — never merely
    // disabled, and never reachable by a direct server-action call this
    // caller could still trigger client-side.
    await expect(page.getByRole("button", { name: "Void expense" })).toHaveCount(0);
  });

  test("a caller with neither expenses.view nor expenses.manage is denied entirely", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-exp-no-access");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-exp-no-access-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    await addMemberWithRole(owner.businessId, user.id, "VIEWER");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses`);
    await expect(page.getByText("Not found")).toBeVisible();

    await page.goto(`/${owner.businessId}/expenses/new`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("cross-tenant expense route 404s", async ({ page }) => {
    const a = await createOwnerAndBusiness("e2e-exp-xtenant-a");
    const b = await createOwnerAndBusiness("e2e-exp-xtenant-b");

    await page.goto("/login");
    await page.getByLabel("Email").fill(a.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto(`/${a.businessId}/expenses/new`);
    await fillMinimalExpenseForm(page);
    await page.getByRole("button", { name: "Record expense" }).click();
    await expect(page).toHaveURL(new RegExp(`/${a.businessId}/expenses/[0-9a-f-]{36}$`));
    const expenseId = page.url().split("/").pop()!;

    await page.context().clearCookies();
    await loginAsInBrowser(page, b.email, PASSWORD);
    await page.goto(`/${a.businessId}/expenses/${expenseId}`);
    await expect(page.getByText("Not found")).toBeVisible();
  });

  test("cross-tenant category management page is inaccessible, and the target category is unaffected", async ({ page }) => {
    const a = await createOwnerAndBusiness("e2e-cat-xtenant-a");
    const b = await createOwnerAndBusiness("e2e-cat-xtenant-b");

    await loginAsInBrowser(page, b.email, PASSWORD);
    // b has no membership in a's business at all — the category
    // management page 404s outright, matching the app's general
    // fail-closed convention for a foreign businessId. The Server Action
    // boundary itself (a forged categoryId/businessId reaching
    // updateExpenseCategory directly) is covered precisely by
    // tests/integration/expense-action-auth.test.ts.
    await page.goto(`/${a.businessId}/expenses/categories`);
    await expect(page.getByText("Not found")).toBeVisible();

    const { data: unchanged } = await a.client
      .from("expense_categories")
      .select("name")
      .eq("business_id", a.businessId)
      .eq("name", "Rent")
      .single();
    expect(unchanged?.name).toBe("Rent");
  });

  test("category management page is read-only for expenses.view-only callers", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cat-view-only");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-cat-view-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["expenses.view"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses/categories`);
    await expect(page.getByRole("heading", { name: "Expense categories" })).toBeVisible();
    await expect(page.getByText("Rent")).toBeVisible();
    await expect(page.getByRole("button", { name: "New category" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive category" })).toHaveCount(0);
  });

  test("category management page is usable for expenses.manage-only callers (manage without view)", async ({ page }) => {
    const owner = await createOwnerAndBusiness("e2e-cat-manage-only");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-cat-manage-only-${suffix}@example.test`;
    const user = await createConfirmedTestUser(email, PASSWORD);
    const roleName = await createRoleWithPermissions(["expenses.manage"]);
    await addMemberWithRole(owner.businessId, user.id, roleName);
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${owner.businessId}/expenses/categories`);
    await expect(page.getByRole("heading", { name: "Expense categories" })).toBeVisible();
    await page.getByRole("button", { name: "New category" }).click();
    await page.getByLabel("Name").fill("Manage-Only Created Category");
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(page.getByText("Manage-Only Created Category")).toBeVisible();
  });
});
