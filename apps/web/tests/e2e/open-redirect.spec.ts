import { test, expect } from "@playwright/test";

test("a crafted next= on /login never redirects off-site after login", async ({ page }) => {
  await page.goto("/login?next=https://evil.example.com");
  // isSafeRedirectPath falls back to "/" for an absolute URL — confirm the
  // hidden field carries the safe fallback, not the attacker-supplied value.
  const nextField = page.locator('input[name="next"]');
  await expect(nextField).toHaveValue("/");
});

test("a crafted next= on /login using a protocol-relative URL also falls back", async ({ page }) => {
  await page.goto("/login?next=//evil.example.com");
  const nextField = page.locator('input[name="next"]');
  await expect(nextField).toHaveValue("/");
});

test("signed-out visitor to a protected businessId route is sent to /login", async ({ page }) => {
  await page.goto("/00000000-0000-0000-0000-000000000000");
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("/auth/confirm with a malformed type fails safely to /login, not to an arbitrary redirect", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=not-a-real-token&type=not-a-real-type&next=/onboarding");
  await expect(page).toHaveURL(/\/login\?error=confirmation-failed/);
});

test("/auth/confirm with a malformed token_hash fails safely", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=not-a-real-token&type=email&next=/onboarding");
  await expect(page).toHaveURL(/\/login\?error=confirmation-failed/);
});
