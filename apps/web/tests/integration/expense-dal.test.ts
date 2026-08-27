import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { getDefaultCategoryId, makeExpenseCategory, makeExpense } from "./helpers/expenses";
import { encodeCursor } from "@/lib/pagination";

// Hybrid technique — see tests/integration/sale-dal.test.ts for the full
// rationale.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => {
  return {
    requireUser: async () => {
      const { data } = await currentClient.auth.getUser();
      if (!data.user) throw new Error("not signed in");
      return data.user;
    },
  };
});

const {
  listExpenses,
  getExpense,
  listExpenseCategories,
  listActiveExpenseCategoriesForPicker,
  getExpenseCategory,
} = await import("@/lib/expenses/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("expense DAL tenant isolation", () => {
  it("listExpenses never returns another business's expenses", async () => {
    const a = await createOwnerAndBusiness("exp-dal-tenant-a");
    const b = await createOwnerAndBusiness("exp-dal-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const categoryA = await getDefaultCategoryId(a.client, a.businessId);
    await makeExpense(a.client, a.businessId, categoryA);

    currentClient = b.client;
    const { rows } = await listExpenses(b.businessId);
    expect(rows.filter((r) => r.business_id === a.businessId)).toHaveLength(0);
  });

  it("getExpense 404s (throws) for an expense belonging to a different business", async () => {
    const a = await createOwnerAndBusiness("exp-dal-getone-a");
    const b = await createOwnerAndBusiness("exp-dal-getone-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const categoryA = await getDefaultCategoryId(a.client, a.businessId);
    const expenseId = await makeExpense(a.client, a.businessId, categoryA);

    currentClient = b.client;
    await expect(getExpense(b.businessId, expenseId)).rejects.toThrow();
  });

  it("listExpenseCategories never returns another business's categories", async () => {
    const a = await createOwnerAndBusiness("exp-dal-cat-tenant-a");
    const b = await createOwnerAndBusiness("exp-dal-cat-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    await makeExpenseCategory(a.client, a.businessId, { name: "Tenant A Only" });

    currentClient = b.client;
    const categories = await listExpenseCategories(b.businessId);
    expect(categories.some((c) => c.name === "Tenant A Only")).toBe(false);
  });

  it("getExpenseCategory 404s (throws) for a category belonging to a different business", async () => {
    const a = await createOwnerAndBusiness("exp-dal-cat-getone-a");
    const b = await createOwnerAndBusiness("exp-dal-cat-getone-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const categoryId = await makeExpenseCategory(a.client, a.businessId);

    currentClient = b.client;
    await expect(getExpenseCategory(b.businessId, categoryId)).rejects.toThrow();
  });
});

describe("expense category picker (ACTIVE only)", () => {
  it("listActiveExpenseCategoriesForPicker excludes archived categories", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-picker-active");
    cleanupUserIds.push(userId);
    currentClient = client;

    const archivedId = await makeExpenseCategory(client, businessId, {
      name: "Soon Archived",
      status: "ARCHIVED",
    });
    const activeId = await makeExpenseCategory(client, businessId, { name: "Still Active" });

    const picker = await listActiveExpenseCategoriesForPicker(businessId);
    expect(picker.some((c) => c.id === archivedId)).toBe(false);
    expect(picker.some((c) => c.id === activeId)).toBe(true);
  });

  it("listExpenseCategories (unfiltered, management list) includes archived categories as history", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-mgmt-list-all");
    cleanupUserIds.push(userId);
    currentClient = client;

    const archivedId = await makeExpenseCategory(client, businessId, {
      name: "History Category",
      status: "ARCHIVED",
    });

    const all = await listExpenseCategories(businessId);
    expect(all.some((c) => c.id === archivedId)).toBe(true);
  });
});

describe("expense category snapshot rendering", () => {
  it("a category rename after expense creation does not alter the expense's stored category_name_snapshot", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-snapshot-rename");
    cleanupUserIds.push(userId);
    currentClient = client;

    const categoryId = await makeExpenseCategory(client, businessId, { name: "Original Name" });
    const expenseId = await makeExpense(client, businessId, categoryId);

    await client.from("expense_categories").update({ name: "Renamed Later" }).eq("id", categoryId);

    const expense = await getExpense(businessId, expenseId);
    expect(expense.category_name_snapshot).toBe("Original Name");
  });
});

describe("expense list filters and voided visibility", () => {
  it("status filter POSTED excludes voided expenses; unfiltered (ALL) includes them", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-status-filter");
    cleanupUserIds.push(userId);
    currentClient = client;

    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);
    await client.rpc("void_expense", { p_business_id: businessId, p_expense_id: expenseId, p_reason: "test void" });

    const posted = await listExpenses(businessId, { status: "POSTED" });
    expect(posted.rows.some((r) => r.id === expenseId)).toBe(false);

    const all = await listExpenses(businessId, {});
    expect(all.rows.some((r) => r.id === expenseId)).toBe(true);
    expect(all.rows.find((r) => r.id === expenseId)?.status).toBe("VOIDED");
  });

  it("category filter narrows to exactly that category_id", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-category-filter");
    cleanupUserIds.push(userId);
    currentClient = client;

    const categoryA = await makeExpenseCategory(client, businessId, { name: "Filter Category A" });
    const categoryB = await makeExpenseCategory(client, businessId, { name: "Filter Category B" });
    await makeExpense(client, businessId, categoryA);
    await makeExpense(client, businessId, categoryB);

    const { rows } = await listExpenses(businessId, { categoryId: categoryA });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.category_id === categoryA)).toBe(true);
  });

  it("payment method filter narrows correctly", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-payment-filter");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId, { paymentMethod: "CARD" });

    const { rows } = await listExpenses(businessId, { paymentMethod: "CARD" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.payment_method === "CARD")).toBe(true);
  });
});

describe("expense free-text search safety (real Data API, same imatch encoder)", () => {
  const ADVERSARIAL_TERMS = [
    "alpha", "alpha,beta", ",", "alpha)", "(alpha)", "(", "alpha.beta",
    "alpha:beta", "alpha*beta", 'alpha"beta', "alpha'beta", "alpha\\beta",
    "alpha%beta", "alpha_beta", "or(payee.eq.foo)",
    "+", "?", "^", "$", "{", "}", "[", "]", "|",
  ];

  it("every adversarial search term returns a valid response, never PGRST100", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-search-safety");
    cleanupUserIds.push(userId);
    currentClient = client;

    for (const term of ADVERSARIAL_TERMS) {
      const { rows } = await listExpenses(businessId, { search: term });
      expect(rows, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  });

  it("a literal expense-number search matches only the exact expense, never broadens", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-search-literal");
    cleanupUserIds.push(userId);
    currentClient = client;

    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);
    const expense = await getExpense(businessId, expenseId);

    const { rows } = await listExpenses(businessId, { search: expense.expense_number });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(expenseId);
  });

  it("payee search finds the exact payee, tenant-scoped, bounded", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-search-payee");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId, { payee: "Unique Payee Name" });

    const { rows } = await listExpenses(businessId, { search: "Unique Payee Name" });
    expect(rows.length).toBe(1);
  });
});

describe("expense DAL pagination determinism", () => {
  it("keyset pagination (incurred_at DESC, id DESC) returns every expense exactly once", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-pagination");
    cleanupUserIds.push(userId);
    currentClient = client;

    const categoryId = await getDefaultCategoryId(client, businessId);
    for (let i = 0; i < 5; i++) {
      await makeExpense(client, businessId, categoryId, { creationKey: randomUuid() });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { rows, nextCursor } = await listExpenses(businessId, { cursor });
      seen.push(...rows.map((r) => r.id));
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});

// Codex adversarial review, Finding 1 + Finding 7.A — the exact
// dateTo-inclusive-calendar-day boundary fix. Every case below mirrors
// Codex's own reproduction: an expense incurred at noon on the selected
// day must be included by a "To date" filter of that same day, and only
// the instant at the START of the FOLLOWING day is excluded.
describe("expense date filter boundary semantics (dateFrom/dateTo are whole UTC calendar days)", () => {
  it("an expense at the exact start of the selected day is included by dateFrom", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-datefilter-from-start");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-26T00:00:00.000Z",
    });

    const { rows } = await listExpenses(businessId, { dateFrom: "2026-08-26" });
    expect(rows.some((r) => r.id === expenseId)).toBe(true);
  });

  it("an expense at noon on the selected day is included by dateTo of that same day (the exact Codex repro)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-datefilter-to-noon");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-26T12:00:00.000Z",
    });

    const { rows } = await listExpenses(businessId, { dateTo: "2026-08-26" });
    expect(rows.some((r) => r.id === expenseId)).toBe(true);
  });

  it("an expense at the last instant of the selected day (23:59:59.999Z) is included by dateTo", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-datefilter-to-lastinstant");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-26T23:59:59.999Z",
    });

    const { rows } = await listExpenses(businessId, { dateTo: "2026-08-26" });
    expect(rows.some((r) => r.id === expenseId)).toBe(true);
  });

  it("an expense at the very start of the FOLLOWING day is excluded when dateTo is the prior day", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-datefilter-to-excluded");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-27T00:00:00.000Z",
    });

    const { rows } = await listExpenses(businessId, { dateTo: "2026-08-26" });
    expect(rows.some((r) => r.id === expenseId)).toBe(false);
  });

  it("dateFrom and dateTo on the same calendar day include every expense that day, and only that day", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-datefilter-single-day");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const inRange = await makeExpense(client, businessId, categoryId, { incurredAt: "2026-08-26T09:00:00.000Z" });
    const before = await makeExpense(client, businessId, categoryId, { incurredAt: "2026-08-25T23:59:59.999Z" });
    const after = await makeExpense(client, businessId, categoryId, { incurredAt: "2026-08-27T00:00:00.000Z" });

    const { rows } = await listExpenses(businessId, { dateFrom: "2026-08-26", dateTo: "2026-08-26" });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inRange);
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(after);
  });
});

// Codex adversarial review, Finding 3 + Finding 7.B — malformed filter
// values must never reach Postgres as a raw comparison value (which would
// otherwise surface as a raw 22P02/22007 parser error). The DAL itself
// defends against this independent of the page-layer parsing
// (lib/validation/expenses.ts's parseExpenseListFilters).
describe("malformed expense filters never reach Postgres (DAL-level defense)", () => {
  it("a non-UUID categoryId is silently ignored, not sent to Postgres", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-malformed-categoryid");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId);

    // A real Postgres 22P02 (invalid uuid syntax) would reject the whole
    // query with a thrown error — this must resolve successfully instead,
    // with the malformed filter simply not applied.
    await expect(listExpenses(businessId, { categoryId: "not-a-uuid" })).resolves.toBeDefined();
  });

  it("a malformed dateFrom/dateTo is silently ignored, not sent to Postgres", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-malformed-dates");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId);

    // A real Postgres 22007 (invalid datetime format) would reject the
    // whole query otherwise.
    await expect(
      listExpenses(businessId, { dateFrom: "not-a-date", dateTo: "also-not-a-date" })
    ).resolves.toBeDefined();
    // A non-existent calendar date (rejected by lib/date-utc.ts's
    // round-trip check) is treated identically.
    await expect(listExpenses(businessId, { dateTo: "2026-02-30" })).resolves.toBeDefined();
  });

  // Codex adversarial review (2nd pass), Finding 1 + Finding 7.A — DAL-
  // level defense in depth: an inverted pair reaching listExpenses
  // DIRECTLY (bypassing lib/validation/expenses.ts's parseExpenseListFilters
  // entirely, e.g. a caller other than the /expenses page) must still
  // never be sent to Postgres as two contradictory predicates, and other
  // filters passed alongside it must be completely unaffected.
  //
  // Codex adversarial review (3rd pass), Finding 2: the ORIGINAL version
  // of this test used only one expense, recorded exactly on the
  // (inverted) dateFrom day. That expense falls inside BOTH the correct
  // "both dates dropped, no date filter at all" result AND a
  // hypothetical WRONG "silently swap dateFrom/dateTo" implementation's
  // result (swapped: dateFrom=2026-08-27, dateTo=2026-08-28, i.e.
  // [2026-08-27T00:00Z, 2026-08-29T00:00Z) — which 2026-08-28T12:00Z
  // still falls inside) — so the test could not actually distinguish
  // "dropped" from "swapped". Fixed below by adding a second expense
  // recorded well OUTSIDE that hypothetical swapped window: only the
  // "dates genuinely dropped" behavior returns it; a silent swap would
  // exclude it, which is exactly what makes its presence real proof.
  it("drops both inverted date filters without swapping them, and preserves a sibling filter", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-inverted-nodrop");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);

    // Inside BOTH the correct (no date filter) result and a hypothetical
    // swapped-range [2026-08-27, 2026-08-29) result — on its own, proves
    // nothing about drop-vs-swap.
    const expenseA = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-28T12:00:00.000Z",
      paymentMethod: "CASH",
    });
    // Well OUTSIDE the hypothetical swapped range — a silent swap would
    // exclude this row entirely. Its presence in the result is the
    // actual proof that the date filters were dropped, not swapped.
    const expenseB = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-20T12:00:00.000Z",
      paymentMethod: "CASH",
    });
    // A different sibling-filter value (paymentMethod) — proves the
    // still-valid paymentMethod filter is genuinely applied (this is
    // NOT "every filter broke down"), not just that the date pair was
    // dropped.
    const expenseC = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-28T12:00:00.000Z",
      paymentMethod: "CARD",
    });

    const { rows } = await listExpenses(businessId, {
      dateFrom: "2026-08-28",
      dateTo: "2026-08-27",
      paymentMethod: "CASH",
    });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(expenseA);
    expect(ids).toContain(expenseB); // proves DROPPED, not swapped
    expect(ids).not.toContain(expenseC); // proves the sibling filter still applies
  });

  it("an inverted date pair does not affect a sibling categoryId filter (drop, not swap)", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-inverted-range-siblings");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryA = await makeExpenseCategory(client, businessId, { name: "Inverted Range Category A" });
    const categoryB = await makeExpenseCategory(client, businessId, { name: "Inverted Range Category B" });

    // Same drop-vs-swap technique as above, this time proving categoryId
    // (rather than paymentMethod) survives as the sibling filter.
    const expenseInsideSwap = await makeExpense(client, businessId, categoryA, {
      incurredAt: "2026-08-28T12:00:00.000Z",
    });
    const expenseOutsideSwap = await makeExpense(client, businessId, categoryA, {
      incurredAt: "2026-08-20T12:00:00.000Z",
    });
    const expenseWrongCategory = await makeExpense(client, businessId, categoryB, {
      incurredAt: "2026-08-28T12:00:00.000Z",
    });

    const { rows } = await listExpenses(businessId, {
      categoryId: categoryA,
      dateFrom: "2026-08-28",
      dateTo: "2026-08-27",
    });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(expenseInsideSwap);
    expect(ids).toContain(expenseOutsideSwap); // proves DROPPED, not swapped
    expect(ids).not.toContain(expenseWrongCategory); // proves categoryId still applies
    expect(rows.every((r) => r.category_id === categoryA)).toBe(true);
  });

  it("dateFrom === dateTo (a valid single-day range) is NOT treated as inverted at the DAL level", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-equal-range");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId, {
      incurredAt: "2026-08-27T12:00:00.000Z",
    });

    const { rows } = await listExpenses(businessId, { dateFrom: "2026-08-27", dateTo: "2026-08-27" });
    expect(rows.some((r) => r.id === expenseId)).toBe(true);
  });
});

// Codex adversarial review, Finding 3 + Finding 7.C — a syntactically
// decodable (valid JSON shape) but semantically invalid cursor must be
// treated as "no cursor" (first page), exactly like a malformed/tampered
// cursor already is (lib/pagination.ts's own decodeCursor), never
// forwarded to Postgres as a raw comparison value.
describe("malformed expense cursor is treated as absent, never reaches Postgres", () => {
  it("a cursor with a non-date incurredAt value is rejected safely", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-cursor-bad-date");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId);

    const badCursor = encodeCursor({ createdAt: "not-a-date", id: randomUuid() });
    const { rows } = await listExpenses(businessId, { cursor: badCursor });
    // Treated as no cursor at all -> the first page, not an error and not
    // an empty result.
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a cursor with a non-UUID id value is rejected safely", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-cursor-bad-id");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId);

    const badCursor = encodeCursor({ createdAt: new Date().toISOString(), id: "not-a-uuid" });
    const { rows } = await listExpenses(businessId, { cursor: badCursor });
    expect(rows.length).toBeGreaterThan(0);
  });

  // Codex adversarial review (2nd pass), Finding 2 + Finding 7.B — the
  // exact repro: Date.parse("0") succeeds in JS ("0" parses to epoch
  // year 2000 in some engines / 1970 in others) but '0'::timestamptz is
  // rejected by Postgres with a 22007. Each case below is a value that
  // is syntactically a plausible "some kind of date-ish string" but is
  // NOT the canonical shape this application's own cursor.createdAt
  // value can ever actually be (see lib/date-utc.ts's
  // isRealTimestampInstant for the exact accepted grammar).
  it.each([
    ["0", "the exact Codex repro — Date.parse succeeds, Postgres timestamptz input rejects it"],
    ["123", "a bare number, not a timestamp"],
    ["not-a-date", "not date-shaped at all"],
    ["2026-02-30T00:00:00.000Z", "an impossible calendar date Date would silently roll forward"],
    ["04 DecFoo 1995", "a loose, non-ISO natural-language-ish string Date.parse tolerates"],
    // Codex adversarial review (3rd pass), Finding 1 — real DAL coverage
    // for the offset/year gaps found in isRealTimestampInstant's own
    // unit tests (lib/date-utc.test.ts). This is the exact same "no
    // Postgres timestamp error" property, exercised end-to-end against
    // the real local Data API, not just the pure validator function.
    ["2026-08-27T19:54:42.395+99:99", "an out-of-range timezone offset (the exact Codex repro)"],
    ["0000-01-01T00:00:00.000Z", "year 0000, which Postgres's timestamptz input parser rejects outright"],
  ])("a cursor with createdAt=%s (%s) is rejected safely, never reaching Postgres", async (badCreatedAt) => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-cursor-strict");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    await makeExpense(client, businessId, categoryId);

    const badCursor = encodeCursor({ createdAt: badCreatedAt, id: randomUuid() });
    // A real Postgres 22007 would reject the whole query if this ever
    // reached the database as a raw comparison value — this must
    // resolve successfully instead (treated as no cursor -> first page).
    const { rows } = await listExpenses(businessId, { cursor: badCursor });
    expect(rows.length, badCreatedAt).toBeGreaterThan(0);
  });

  it("a VALID, application-generated cursor (the real shape listExpenses itself emits) is accepted, and pagination actually advances", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-cursor-valid-generated");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    // Strictly more than DEFAULT_PAGE_SIZE (25) so a second page is
    // actually forced to exist — otherwise nextCursor would just be null
    // and this test would trivially (and meaninglessly) pass.
    for (let i = 0; i < 27; i++) {
      await makeExpense(client, businessId, categoryId, { creationKey: randomUuid() });
    }

    const firstPage = await listExpenses(businessId, {});
    expect(firstPage.nextCursor).not.toBeNull();

    // The cursor listExpenses itself just emitted is the real,
    // canonical shape isRealTimestampInstant validates against — this is
    // what actually proves the strict validator doesn't accidentally
    // reject the application's own legitimate output.
    const secondPage = await listExpenses(businessId, { cursor: firstPage.nextCursor! });
    expect(secondPage.rows.length).toBeGreaterThan(0);
    // No overlap between pages — genuine forward progress, not a reset
    // to page one.
    const firstIds = new Set(firstPage.rows.map((r) => r.id));
    expect(secondPage.rows.every((r) => !firstIds.has(r.id))).toBe(true);

    // incurred_at DESC, id DESC ordering is unchanged by this fix — every
    // row across both pages is strictly ordered by that same key.
    const combined = [...firstPage.rows, ...secondPage.rows];
    for (let i = 1; i < combined.length; i++) {
      const prev = combined[i - 1];
      const cur = combined[i];
      const cmp = prev.incurred_at === cur.incurred_at ? prev.id > cur.id : prev.incurred_at > cur.incurred_at;
      expect(cmp, `row ${i - 1} vs ${i}`).toBe(true);
    }
  });
});

describe("expense DAL never exposes creation_key", () => {
  it("listExpenses/getExpense rows never carry creation_key", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("exp-dal-no-creation-key");
    cleanupUserIds.push(userId);
    currentClient = client;
    const categoryId = await getDefaultCategoryId(client, businessId);
    const expenseId = await makeExpense(client, businessId, categoryId);

    const { rows } = await listExpenses(businessId);
    expect(rows[0]).not.toHaveProperty("creation_key");

    const expense = await getExpense(businessId, expenseId);
    expect(expense).not.toHaveProperty("creation_key");
  });
});
