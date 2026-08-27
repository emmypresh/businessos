import { test, expect, type Page } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

const PASSWORD = "Password1234";

async function loginAsInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function createOwnerBusiness(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${suffix}@example.test`;
  await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  const { data: business } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: `${prefix}-${suffix}`,
  });
  return { email, businessId: business!.id };
}

test.describe("customers", () => {
  test("create a customer, then view it", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-cust-create");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("Jane Doe");
    await page.getByLabel("Phone").fill("0801234567");
    await page.getByLabel("Email").fill("jane@example.test");
    await page.getByRole("button", { name: "Create customer" }).click();

    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { name: "Jane Doe" })).toBeVisible();
    await expect(page.getByText("0801234567")).toBeVisible();
  });

  test("edit a customer's fields", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-cust-edit");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("Original Name");
    await page.getByRole("button", { name: "Create customer" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Renamed Customer");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { name: "Renamed Customer" })).toBeVisible();
  });

  test("archive a customer", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-cust-archive");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("To Be Archived");
    await page.getByRole("button", { name: "Create customer" }).click();
    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Archived", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  });

  test("a duplicate/double-click submission does not create a duplicate customer", async ({ page }) => {
    const { email, businessId } = await createOwnerBusiness("e2e-cust-dup");
    await loginAsInBrowser(page, email, PASSWORD);

    await page.goto(`/${businessId}/customers/new`);
    await page.getByLabel("Name").fill("Duplicate Click Customer");

    // Same technique as products.spec.ts's own double-click test: fires
    // two real, concurrent submissions of the SAME <form> (and therefore
    // the same hidden creationKey), bypassing the submit button's
    // disabled state entirely to exercise the idempotency-key backstop
    // itself.
    await page.getByTestId("customer-form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });

    await expect(page).toHaveURL(new RegExp(`/${businessId}/customers/[0-9a-f-]{36}$`));

    await page.goto(`/${businessId}/customers?search=Duplicate Click Customer`);
    const rows = page.getByRole("row").filter({ hasText: "Duplicate Click Customer" });
    await expect(rows).toHaveCount(1);
  });
});
