import { test, type Page, type ConsoleMessage } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

// Phase 1Q-0D final live hydration + visual matrix QA. This spec is
// evidence-gathering only: it creates its own throwaway fixture
// businesses (one real NG business per country via the real
// create_business RPC, then its country/currency/timezone corrected
// directly via service-role SQL — the same sanctioned pattern used by
// tests/integration/helpers/inventory.ts's setBusinessCountryCurrencyForTest,
// never weakening create_business's own NG-only activation gate), seeds
// realistic sales/product/expense data, then drives real SSR+hydration
// page loads across the responsive/dark-mode/locale/currency matrix and
// records results to a JSON file this run reads back to build its report.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SECRET_KEY = process.env.SUPABASE_TEST_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const RESULTS_PATH = path.join(process.cwd(), "qa-screenshots", "1q0d-results.json");
const SHOT_DIR = path.join(process.cwd(), "qa-screenshots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results: Record<string, unknown> = {
  hydrationLoads: [],
  hydrationMismatches: [],
  consoleWarnings: [],
  screenshots: [],
};

function saveResults() {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

const COUNTRIES: Record<
  string,
  { country: string; currency: string; symbol: string; locale: string; timezone: string }
> = {
  NG: { country: "NG", currency: "NGN", symbol: "₦", locale: "en-NG", timezone: "Africa/Lagos" },
  GH: { country: "GH", currency: "GHS", symbol: "GH₵", locale: "en-GH", timezone: "Africa/Accra" },
  KE: { country: "KE", currency: "KES", symbol: "KSh", locale: "en-KE", timezone: "Africa/Nairobi" },
  ZA: { country: "ZA", currency: "ZAR", symbol: "R", locale: "en-ZA", timezone: "Africa/Johannesburg" },
  GB: { country: "GB", currency: "GBP", symbol: "£", locale: "en-GB", timezone: "Europe/London" },
  US: { country: "US", currency: "USD", symbol: "$", locale: "en-US", timezone: "America/New_York" },
};

function admin() {
  if (!SECRET_KEY) throw new Error("SUPABASE_TEST_SECRET_KEY must be set");
  return createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function createFixtureBusiness(cc: string, opts: { withSales?: boolean } = {}) {
  const meta = COUNTRIES[cc];
  const admin_ = admin();
  const email = `qa-1q0d-${cc.toLowerCase()}-${Date.now()}@example.test`;
  const password = "Password1234";
  const { data: userData, error: userErr } = await admin_.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !userData?.user) throw new Error(`createUser failed for ${cc}: ${userErr?.message}`);

  const userClient = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { error: signInErr } = await userClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn failed for ${cc}: ${signInErr.message}`);

  const slug = `qa-1q0d-${cc.toLowerCase()}-${Date.now()}`;
  const { data: biz, error: bizErr } = await userClient.rpc("create_business", {
    p_name: `${cc} QA Traders`,
    p_slug: slug,
  });
  if (bizErr || !biz) throw new Error(`create_business failed for ${cc}: ${bizErr?.message}`);
  const businessId = (biz as { id: string }).id;

  let productName: string | undefined;
  if (opts.withSales) {
    productName = `${cc} Flagship Item ${Date.now()}`;
    const { error: prodErr } = await userClient.rpc("create_product", {
      p_business_id: businessId,
      p_creation_key: crypto.randomUUID(),
      p_name: productName,
      p_sku: `${cc.toLowerCase()}-qa-sku-${Date.now()}`,
      p_selling_price: 1234567.89,
      p_opening_quantity: 500,
    });
    if (prodErr) throw new Error(`create_product failed for ${cc}: ${prodErr.message}`);
  }

  // Sanctioned direct-SQL fixture correction (service-role only), mirroring
  // tests/integration/helpers/inventory.ts::setBusinessCountryCurrencyForTest.
  // Never used by any application code path; never a weakening of
  // create_business's own NG-only activation gate.
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`
      update public.businesses
      set country_code = ${meta.country}, currency_code = ${meta.currency}, timezone = ${meta.timezone}
      where id = ${businessId}
    `;
  } finally {
    await sql.end();
  }

  return { businessId, email, password, meta, productName };
}

async function loginUI(page: Page, email: string, password: string) {
  // Always start from a clean, unauthenticated state — reusing the same
  // `page` across multiple fixture accounts within one test otherwise
  // leaves a prior session's cookie active, which makes /login
  // immediately redirect back to that prior account's dashboard instead
  // of rendering the Email field (observed: 00b's second loginUI call
  // hung waiting for getByLabel('Email') because the NG session was
  // still active).
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/[0-9a-f-]{36}$|\/$/, { timeout: 15000 }).catch(() => {});
}

function attachConsoleWatchers(page: Page, tag: string) {
  const hydrationHits: string[] = [];
  const warnings: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (/hydration/i.test(text) || /server rendered HTML/i.test(text) || /text mismatch/i.test(text)) {
      hydrationHits.push(`[${tag}] console:${msg.type()}: ${text}`);
    }
    if (msg.type() === "error" || msg.type() === "warning") {
      warnings.push(`[${tag}] ${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    hydrationHits.push(`[${tag}] pageerror: ${err.message}`);
  });
  return { hydrationHits, warnings };
}

test.describe.configure({ mode: "serial" });

const fixtures: Record<string, Awaited<ReturnType<typeof createFixtureBusiness>>> = {};

test("00 setup fixtures", async () => {
  test.setTimeout(120_000);
  fixtures.NG = await createFixtureBusiness("NG", { withSales: true });
  fixtures.GH = await createFixtureBusiness("GH", { withSales: true });
  fixtures.KE = await createFixtureBusiness("KE", { withSales: false });
  fixtures.ZA = await createFixtureBusiness("ZA", { withSales: false });
  fixtures.GB = await createFixtureBusiness("GB", { withSales: false });
  fixtures.US = await createFixtureBusiness("US", { withSales: true });
  fs.writeFileSync(
    path.join(SHOT_DIR, "1q0d-fixtures.json"),
    JSON.stringify(
      Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, { businessId: v.businessId, email: v.email }])),
      null,
      2
    )
  );
});

test("00b seed real sales via UI (NG, GH, US)", async ({ page }) => {
  test.setTimeout(120_000);
  for (const cc of ["NG", "GH", "US"]) {
    const f = fixtures[cc];
    if (!f.productName) continue;
    await loginUI(page, f.email, f.password);
    for (let i = 0; i < 3; i++) {
      await page.goto(`/${f.businessId}/sales/new`, { waitUntil: "networkidle" });
      await page.getByLabel("Search products").fill(f.productName);
      const result = page.getByTestId("product-picker-results").getByText(f.productName, { exact: false });
      await result.click({ timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: /Complete sale/ }).click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
});

test("01 hydration stress NG (30 loads)", async ({ page }) => {
  test.setTimeout(180_000);
  const f = fixtures.NG;
  await loginUI(page, f.email, f.password);
  const { hydrationHits, warnings } = attachConsoleWatchers(page, "NG");
  for (let i = 0; i < 30; i++) {
    await page.goto(`/${f.businessId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(150);
  }
  (results.hydrationLoads as unknown[]).push({ country: "NG", loads: 30, mismatches: hydrationHits.length });
  (results.hydrationMismatches as unknown[]).push(...hydrationHits);
  (results.consoleWarnings as unknown[]).push(...warnings);
  saveResults();
});

test("02 hydration stress GH (20 loads)", async ({ page }) => {
  test.setTimeout(140_000);
  const f = fixtures.GH;
  await loginUI(page, f.email, f.password);
  const { hydrationHits, warnings } = attachConsoleWatchers(page, "GH");
  for (let i = 0; i < 20; i++) {
    await page.goto(`/${f.businessId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(150);
  }
  (results.hydrationLoads as unknown[]).push({ country: "GH", loads: 20, mismatches: hydrationHits.length });
  (results.hydrationMismatches as unknown[]).push(...hydrationHits);
  (results.consoleWarnings as unknown[]).push(...warnings);
  saveResults();
});

test("03 hydration stress US (20 loads)", async ({ page }) => {
  test.setTimeout(140_000);
  const f = fixtures.US;
  await loginUI(page, f.email, f.password);
  const { hydrationHits, warnings } = attachConsoleWatchers(page, "US");
  for (let i = 0; i < 20; i++) {
    await page.goto(`/${f.businessId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(150);
  }
  (results.hydrationLoads as unknown[]).push({ country: "US", loads: 20, mismatches: hydrationHits.length });
  (results.hydrationMismatches as unknown[]).push(...hydrationHits);
  (results.consoleWarnings as unknown[]).push(...warnings);
  saveResults();
});

test("04 activity + notification locale check", async ({ page }) => {
  test.setTimeout(120_000);
  const localeResults: Record<string, unknown> = {};
  for (const cc of ["NG", "GH", "GB", "US"]) {
    const f = fixtures[cc];
    await loginUI(page, f.email, f.password);
    const { hydrationHits } = attachConsoleWatchers(page, `activity-${cc}`);
    await page.goto(`/${f.businessId}/activity`, { waitUntil: "networkidle" });
    const activityText = await page.locator("body").innerText();
    await page.goto(`/${f.businessId}/notifications`, { waitUntil: "networkidle" });
    const notifText = await page.locator("body").innerText();
    localeResults[cc] = {
      hydrationHits,
      hasContent: activityText.length > 0 && notifText.length > 0,
    };
  }
  (results as Record<string, unknown>).localeResults = localeResults;
  saveResults();
});

test("05 missing-currency UI (sales/new, invoices/new) at 390/1280", async ({ page }) => {
  test.setTimeout(60_000);
  const f = fixtures.KE; // KE has no seeded sales/products but has currency set
  await loginUI(page, f.email, f.password);
  const missingCurrency: Record<string, unknown> = {};
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/${f.businessId}/sales/new`, { waitUntil: "networkidle" });
    const salesBody = await page.locator("body").innerText();
    await page.screenshot({ path: path.join(SHOT_DIR, `1q0d-ke-sales-new-${width}.png`), fullPage: true });
    await page.goto(`/${f.businessId}/invoices/new`, { waitUntil: "networkidle" });
    const invoicesBody = await page.locator("body").innerText();
    await page.screenshot({ path: path.join(SHOT_DIR, `1q0d-ke-invoices-new-${width}.png`), fullPage: true });
    missingCurrency[width] = {
      salesLooksBlank: salesBody.trim().length < 20,
      invoicesLooksBlank: invoicesBody.trim().length < 20,
    };
  }
  (results as Record<string, unknown>).missingCurrency = missingCurrency;
  saveResults();
});

test("06 currency display matrix + large values + responsive + dark mode", async ({ page }) => {
  test.setTimeout(300_000);
  const symbolResults: Record<string, unknown> = {};
  const widths = [390, 768, 1280, 1440];
  for (const cc of ["NG", "GH", "KE", "ZA", "GB", "US"]) {
    const f = fixtures[cc];
    await loginUI(page, f.email, f.password);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${f.businessId}`, { waitUntil: "networkidle" });
      const bodyText = await page.locator("body").innerText();
      const hasSymbol = bodyText.includes(f.meta.symbol);
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      symbolResults[`${cc}-${width}`] = { hasSymbol, hasOverflow };
      if (width === 390 || width === 1440) {
        await page.screenshot({
          path: path.join(SHOT_DIR, `1q0d-${cc.toLowerCase()}-dashboard-${width}.png`),
          fullPage: true,
        });
      }
    }
    // dark mode at 1440 for dashboard
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${f.businessId}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(SHOT_DIR, `1q0d-${cc.toLowerCase()}-dashboard-1440-dark.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
  }
  (results as Record<string, unknown>).symbolResults = symbolResults;
  saveResults();
});

// Both the sales-trend chart and Branch performance render on the
// DASHBOARD route (`/${businessId}`, components/dashboard/management-overview.tsx),
// not `/reports` — the prior version of this test navigated to `/reports`
// for both checks, so `Branch Performance` heading and chart-point
// selectors could never actually be found there; that gap (not a real
// product defect) is exactly what made both checks unreliable before.
//
// The chart itself is a hand-drawn inline SVG (components/dashboard/sales-trend-chart.tsx),
// not Recharts — each data point is an SVG <circle> whose native `title`
// attribute IS the tooltip (a plain browser-native title, not a
// role="tooltip" DOM node a hover can reveal in headless Chromium
// reliably). Reading that attribute directly is the correct way to
// assert its content — see that file's own comment on why a nested
// <title> child (which DOES land in the a11y tree) was deliberately
// replaced with this attribute to fix a real hydration mismatch (React
// #418). The title text is `${dateLabel}: ${formattedAmount}`, so a
// single non-zero-valued circle's title attribute contains everything
// item 6 asks to verify (date, non-zero amount, currency symbol) in one
// read — no hover, no visual-only tooltip lookup.
test("07a sales-trend tooltip: real non-zero data point (NG, GH, US)", async ({ page }) => {
  test.setTimeout(180_000);
  const tooltipResults: Record<string, unknown> = {};
  const { hydrationHits, warnings } = attachConsoleWatchers(page, "07a-tooltip");
  for (const cc of ["NG", "GH", "US"]) {
    const f = fixtures[cc];
    await loginUI(page, f.email, f.password);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${f.businessId}`, { waitUntil: "load", timeout: 20000 });

      // By id, not getByRole: this heading is deliberately sr-only (a
      // real <h2>, but visually hidden), and matching it by its stable id
      // is more reliable across viewport widths than a role+name query.
      const chartHeading = page.locator("#sales-trend-heading");
      const circles = page.locator("svg circle[title]");
      const circleCount = await circles.count().catch(() => 0);

      let nonZeroTitle: string | null = null;
      for (let i = 0; i < circleCount; i++) {
        const title = await circles.nth(i).getAttribute("title");
        // Every title is "<date label>: <formatted amount>" — reject the
        // ones whose amount is exactly zero (no sales that day) so this
        // always lands on a REAL non-zero point, never the first/empty one.
        if (title && !/:\s*[^\d]*0(\.0+)?\s*$/.test(title)) {
          nonZeroTitle = title;
          break;
        }
      }

      const hasSymbol = nonZeroTitle ? nonZeroTitle.includes(f.meta.symbol) : false;
      const hasDateColon = nonZeroTitle ? nonZeroTitle.includes(":") : false;

      tooltipResults[`${cc}-${width}`] = {
        chartHeadingCount: await chartHeading.count().catch(() => 0),
        circleCount,
        tooltipText: nonZeroTitle,
        hasSymbol,
        hasDateColon,
      };
    }
  }
  (results as Record<string, unknown>).tooltipResults = tooltipResults;
  (results as Record<string, unknown>).tooltipConsole = { hydrationHits, warnings };
  saveResults();
});

// Branch performance (components/dashboard/branch-performance.tsx) is a
// role="region" landmark labelled by its own real heading — located by
// that accessible name, never by plain text match, so this can never be
// confused with the page's other headings.
test("07b branch performance visibility (NG, GH, US)", async ({ page }) => {
  test.setTimeout(180_000);
  const branchResults: Record<string, unknown> = {};
  const { hydrationHits, warnings } = attachConsoleWatchers(page, "07b-branch");
  for (const cc of ["NG", "GH", "US"]) {
    const f = fixtures[cc];
    await loginUI(page, f.email, f.password);
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${f.businessId}`, { waitUntil: "load", timeout: 20000 });

      // The region is located by its accessible name, which resolves via
      // aria-labelledby="branch-performance-heading" regardless of the
      // labelling element's own tag — components/ui/card.tsx's CardTitle
      // renders a plain <div>, not a real <h*>, so this codebase's Cards
      // are never matched by getByRole("heading"); by id is the correct,
      // element-agnostic way to find the visible label text itself.
      const region = page.getByRole("region", { name: /branch performance/i });
      const heading = page.locator("#branch-performance-heading");
      await heading.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

      const regionFound = (await region.count().catch(() => 0)) > 0;
      const headingVisible = await heading.isVisible({ timeout: 3000 }).catch(() => false);
      // Last row of the branch table, or the "no branch data" fallback
      // paragraph when the fixture account has no assigned branches —
      // either way, this asserts the region's own LAST rendered element
      // ends up on screen after scrolling, not just its heading.
      const lastRow = region.locator("table tbody tr").last();
      const lastRowCount = await lastRow.count().catch(() => 0);
      const finalElement = lastRowCount > 0 ? lastRow : region.getByText(/no branch performance data/i);
      await finalElement.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const finalElementVisible = await finalElement.isVisible({ timeout: 3000 }).catch(() => false);

      const overflow = await page
        .evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
        .catch(() => null);

      branchResults[`${cc}-${width}`] = { regionFound, headingVisible, finalElementVisible, overflow };
      if (width === 1440) {
        await page.screenshot({ path: path.join(SHOT_DIR, `1q0d-${cc.toLowerCase()}-dashboard-branch-${width}.png`) }).catch(() => {});
      }
    }
  }
  (results as Record<string, unknown>).branchResults = branchResults;
  (results as Record<string, unknown>).branchConsole = { hydrationHits, warnings };
  saveResults();
});

test("08 accessibility spot check", async ({ page }) => {
  test.setTimeout(60_000);
  const f = fixtures.NG;
  await loginUI(page, f.email, f.password);
  const a11y: Record<string, unknown> = {};
  for (const route of ["activity", "notifications", "sales/new", "invoices/new", ""]) {
    await page.goto(`/${f.businessId}${route ? "/" + route : ""}`, { waitUntil: "networkidle" });
    const headingCount = await page.locator("h1, h2, [role='heading']").count();
    const buttonsWithNoName = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.filter((b) => !b.textContent?.trim() && !b.getAttribute("aria-label")).length;
    });
    a11y[route || "dashboard"] = { headingCount, buttonsWithNoName };
  }
  (results as Record<string, unknown>).a11y = a11y;
  saveResults();
});
