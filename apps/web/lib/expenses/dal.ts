import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import { calendarDayStartUtc, calendarDayEndExclusiveUtc, isRealTimestampInstant } from "@/lib/date-utc";
import type { ExpenseStatus, PaymentMethod, ExpenseCategoryStatus } from "./constants";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase-1E-specific wrapper over lib/pagination.ts's generic
 * decodeCursor: that function already validates the cursor's JSON SHAPE
 * (two string fields) but not the SEMANTIC validity of either value — a
 * syntactically well-formed cursor carrying a non-date string or a
 * non-UUID id would otherwise reach Postgres as a raw comparison value
 * and surface as a raw 22007/22P02 parser error instead of the generic
 * "malformed cursor -> first page" fallback every other paginated list
 * already gets. Deliberately a narrow wrapper here, not a change to the
 * shared decodeCursor (which every Phase 1C/1D list also depends on) —
 * avoids any regression risk to that shared, already-proven helper.
 *
 * Codex adversarial review, Finding 2 (2nd pass): the timestamp check
 * uses lib/date-utc.ts's isRealTimestampInstant, NOT `Date.parse`/
 * `Number.isNaN(Date.parse(...))` — Date.parse accepts a much wider,
 * looser grammar than Postgres's own timestamptz parser (confirmed:
 * `Date.parse("0")` succeeds in JS, `'0'::timestamptz` is rejected by
 * Postgres with a 22007). isRealTimestampInstant instead only accepts
 * the exact canonical shape this application's own cursor.createdAt
 * value (copied straight from a SELECT'd incurred_at column — see
 * listExpenses below) can ever actually be.
 */
function decodeExpenseCursor(value: string | undefined): Cursor | null {
  const cursor = decodeCursor(value);
  if (!cursor) return null;
  if (!isRealTimestampInstant(cursor.createdAt)) return null;
  if (!UUID_PATTERN.test(cursor.id)) return null;
  return cursor;
}

// Explicit column list — never select("*"). creation_key is deliberately
// absent: it is internal mutation-control metadata (idempotency
// traceability only), not a display field — matching products'/sales'
// own creation_key treatment exactly, and matching expenses' own
// column-restricted SELECT grant (create_expenses.sql), which excludes it
// too.
// Phase 1G: branch_id/branch_name_snapshot are BOTH nullable — a
// company-wide expense has neither (see 20260829080300_branch_aware_expenses.sql).
// branch_name_snapshot is what every display use renders (see this file's
// own header on snapshots — a branch rename/deactivation later never
// changes it); branch_id is selected only so callers can filter by it.
const EXPENSE_COLUMNS =
  "id, business_id, expense_number, category_id, category_name_snapshot, " +
  "amount, currency_code, payment_method, payee, reference, notes, " +
  "branch_id, branch_name_snapshot, " +
  "incurred_at, status, created_by, created_at, voided_at, voided_by, void_reason";

export type ExpenseRow = {
  id: string;
  business_id: string;
  expense_number: string;
  category_id: string;
  category_name_snapshot: string;
  amount: number;
  currency_code: string;
  payment_method: string;
  payee: string | null;
  reference: string | null;
  notes: string | null;
  branch_id: string | null;
  branch_name_snapshot: string | null;
  incurred_at: string;
  status: string;
  created_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

export const listExpenses = cache(
  async (
    businessId: string,
    options: {
      search?: string;
      categoryId?: string;
      paymentMethod?: PaymentMethod;
      status?: ExpenseStatus;
      branchId?: string;
      companyWideOnly?: boolean;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
    } = {}
  ): Promise<{ rows: ExpenseRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    // Preferred order per the approved plan: incurred_at DESC, id DESC —
    // NOT created_at, unlike every other Phase 1C/1D list. incurred_at is
    // the financially meaningful date (when the expense happened, which
    // may be backfilled well after created_at); id breaks ties
    // deterministically for rows sharing the same incurred_at instant.
    let query = supabase
      .from("expenses")
      .select(EXPENSE_COLUMNS)
      .eq("business_id", businessId)
      .order("incurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    // categoryId is defensively UUID-checked here too (not just at the
    // page/filter-parsing boundary — lib/validation/expenses.ts's
    // parseExpenseListFilters) — this DAL function never trusts its own
    // caller's shape, matching decodeExpenseCursor's/date-filter
    // treatment below: a malformed value is silently ignored (never
    // applied as a filter), never forwarded to Postgres.
    if (options.categoryId && UUID_PATTERN.test(options.categoryId)) {
      query = query.eq("category_id", options.categoryId);
    }
    if (options.paymentMethod) {
      query = query.eq("payment_method", options.paymentMethod);
    }
    if (options.status) {
      query = query.eq("status", options.status);
    }
    // Phase 1G: mutually exclusive by construction (the filter UI only
    // ever offers one or the other — see expense-filters.tsx) — a
    // specific branch, OR company-wide-only (branch_id IS NULL), never
    // both. expenses.view is business-wide (mirrors sales.view/
    // reports.view — never gated on has_branch_access), so this only ever
    // narrows an already-fully-visible result set, exactly like the sales
    // list's own branch filter.
    if (options.branchId) {
      query = query.eq("branch_id", options.branchId);
    } else if (options.companyWideOnly) {
      query = query.is("branch_id", null);
    }
    // Calendar-day boundaries, NOT the raw "YYYY-MM-DD" strings — a
    // visible "To date" field is an inclusive calendar day, so dateTo
    // resolves to the EXCLUSIVE next-day boundary and uses `lt`, never
    // `lte` against the bare date (which Postgres/PostgREST would
    // otherwise compare against midnight, excluding nearly the entire
    // selected day). See lib/date-utc.ts's header comment. A malformed
    // date string (already rejected upstream by
    // lib/validation/expenses.ts's dateFrom/dateTo schema in the normal
    // page flow) resolves to null here and the filter is simply omitted
    // — never passed to Postgres as a raw comparison value.
    const fromBoundary = options.dateFrom ? calendarDayStartUtc(options.dateFrom) : null;
    const toBoundaryExclusive = options.dateTo ? calendarDayEndExclusiveUtc(options.dateTo) : null;

    // Codex adversarial review, Finding 1 (defense in depth): an INVERTED
    // pair (dateFrom lexicographically after dateTo — both are
    // "YYYY-MM-DD" calendar dates, which sort identically as strings and
    // as instants) is a contradictory predicate, not a malformed value —
    // sending both to Postgres as independent gte/lt constraints would
    // silently produce a permanently-empty result rather than surfacing
    // as an error. BOTH dates are dropped together here too, even if
    // this function is ever called directly with a raw filter object
    // that bypasses lib/validation/expenses.ts's own parseExpenseListFilters
    // (the primary boundary, in the normal page flow) — never silently
    // swapped, which would change the caller's actual intent. Only
    // evaluated once both sides are confirmed genuine calendar dates; a
    // malformed value on either side is already handled independently by
    // the null checks below.
    const datesInverted =
      options.dateFrom !== undefined &&
      options.dateTo !== undefined &&
      fromBoundary !== null &&
      toBoundaryExclusive !== null &&
      options.dateFrom > options.dateTo;

    if (fromBoundary && !datesInverted) {
      query = query.gte("incurred_at", fromBoundary.toISOString());
    }
    if (toBoundaryExclusive && !datesInverted) {
      query = query.lt("incurred_at", toBoundaryExclusive.toISOString());
    }
    if (options.search) {
      // Structured filters above use plain eq/gte/lte — never raw string
      // interpolation. Free-text search reuses the same imatch encoder
      // already proven safe for products/customers/sales, against the
      // three safe textual fields (expense_number, payee, reference) —
      // never notes (unbounded free text, not intended as a search key
      // here) and never category_name_snapshot (use categoryId instead).
      const value = buildImatchSearchValue(options.search);
      query = query.or(`expense_number.imatch.${value},payee.imatch.${value},reference.imatch.${value}`);
    }

    const cursor = decodeExpenseCursor(options.cursor);
    if (cursor) {
      // lib/pagination.ts's Cursor names its sort-key field `createdAt`
      // generically — every OTHER paginated list in this app happens to
      // order by created_at DESC and so populates it directly with that
      // column. This list orders by incurred_at DESC instead (per the
      // approved plan), so incurred_at is what's encoded into/decoded
      // from that same slot; the cursor itself is an opaque token, never
      // rendered, so the field's literal name is immaterial to callers.
      query = query.or(
        `incurred_at.lt.${cursor.createdAt},and(incurred_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load expenses: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as ExpenseRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.incurred_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

export const getExpense = cache(async (businessId: string, expenseId: string): Promise<ExpenseRow> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", expenseId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load expense: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as ExpenseRow;
});

// Expense categories ------------------------------------------------------

const CATEGORY_COLUMNS = "id, business_id, name, status, created_by, created_at, updated_at";

export type ExpenseCategoryRow = {
  id: string;
  business_id: string;
  name: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

// The category management list — every category regardless of status
// (archived categories remain visible here as history, per the approved
// plan; §29). Small, business-scoped, and not expected to paginate at any
// realistic scale (Phase 1E ships ten seeded defaults per business), so
// this is a plain unpaginated list, ordered by name for a stable,
// predictable management UI rather than by recency.
export const listExpenseCategories = cache(
  async (
    businessId: string,
    options: { status?: ExpenseCategoryStatus } = {}
  ): Promise<ExpenseCategoryRow[]> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("expense_categories")
      .select(CATEGORY_COLUMNS)
      .eq("business_id", businessId)
      .order("name", { ascending: true });

    if (options.status) {
      query = query.eq("status", options.status);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load expense categories: ${error.message}`);
    }

    return (data ?? []) as unknown as ExpenseCategoryRow[];
  }
);

// The "new expense" category picker — ACTIVE only, never archived
// (archiving a category must remove it from new-expense selection; §5/§29
// of the approved plan). A thin, deliberately named wrapper over
// listExpenseCategories rather than a duplicate query.
export const listActiveExpenseCategoriesForPicker = cache(
  async (businessId: string): Promise<ExpenseCategoryRow[]> => {
    return listExpenseCategories(businessId, { status: "ACTIVE" });
  }
);

export const getExpenseCategory = cache(
  async (businessId: string, categoryId: string): Promise<ExpenseCategoryRow> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("expense_categories")
      .select(CATEGORY_COLUMNS)
      .eq("business_id", businessId)
      .eq("id", categoryId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load expense category: ${error.message}`);
    }
    if (!data) {
      notFound();
    }

    return data as unknown as ExpenseCategoryRow;
  }
);

export type { Cursor };
