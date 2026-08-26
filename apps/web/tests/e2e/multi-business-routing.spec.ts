import { test, expect } from "@playwright/test";
import { createConfirmedTestUser, createUserClient } from "../integration/helpers/admin-client";

test("a user with 2+ memberships sees a deterministic selection list, not an arbitrary redirect", async ({ page }) => {
  const email = `multi-biz-${Date.now()}@example.test`;
  const password = "Password1234";
  await createConfirmedTestUser(email, password);

  const client = createUserClient();
  await client.auth.signInWithPassword({ email, password });

  const first = await client.rpc("create_business", { p_name: "First Co", p_slug: `first-${Date.now()}` });
  const second = await client.rpc("create_business", { p_name: "Second Co", p_slug: `second-${Date.now()}` });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3100\/$/);
  // getByText would also match the Next.js route-announcer's live-region
  // copy of the heading text; scope to the actual heading role instead.
  await expect(page.getByRole("heading", { name: "Choose a business" })).toBeVisible();

  // Deterministic order: the first-created business appears before the
  // second-created one, matching listMemberships' created_at ascending
  // sort. Each card's link also contains the role badge text ("OWNER"),
  // so match on substring containment rather than an end-anchored regex.
  const cards = page.locator("a", { hasText: "Co" });
  await expect(cards.first()).toContainText("First Co");

  await page.getByText("Second Co").click();
  await expect(page).toHaveURL(new RegExp(second.data!.id));
  void first;
});
