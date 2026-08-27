import { z } from "zod";
import {
  MAX_EXPENSE_AMOUNT,
  PAYEE_MAX_LENGTH,
  REFERENCE_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  VOID_REASON_MAX_LENGTH,
  CATEGORY_NAME_MIN_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
} from "@/lib/expenses/constants";

/**
 * Client-side feedback only — create_expense's/void_expense's own
 * validation
 * (supabase/migrations/20260827080300_create_expense_creation_requests_and_rpc.sql,
 * supabase/migrations/20260827080400_void_expense_rpc.sql) remains the
 * actual authority. Every rule here mirrors those RPCs' exact contracts,
 * including create_expense's exact-precision round-trip check.
 */

// Validated as a STRING first — regex-checked for AT MOST 2 decimal
// places BEFORE any numeric coercion — so excess precision (1.234) is
// REJECTED with a clear message, never silently rounded by a float
// conversion. Mirrors create_expense's own round-trip proof
// (v_amount_narrowed <> v_amount -> INVALID_EXPENSE_AMOUNT) and
// lib/validation/sales.ts's saleQuantity schema's own string-first
// technique. No leading `-` is accepted by the pattern at all, so a
// negative amount is rejected at the regex stage, before the >0 refine
// ever runs.
export const ExpenseAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, {
    error: "Enter an amount with up to 2 decimal places.",
  })
  .transform((v) => Number(v))
  .refine((v) => v > 0, { error: "Amount must be greater than zero." })
  .refine((v) => v <= MAX_EXPENSE_AMOUNT, { error: "Amount is too large." });

export const ExpensePaymentMethodSchema = z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"], {
  error: "Choose a payment method.",
});

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

// A datetime-local input's raw string value ("YYYY-MM-DDTHH:mm"),
// interpreted by the browser's own local clock when converted to a Date
// — never re-derived through a hardcoded timezone. Mirrors
// create_expense's own grace window (p_incurred_at > now() + 1 day is
// rejected as INVALID_EXPENSE_DATE) so a clearly-invalid future date
// never leaves the form; there is deliberately no lower bound, matching
// the RPC's own allowance for legitimate historical backfill entries.
export const ExpenseIncurredAtSchema = z
  .string()
  .min(1, { error: "Enter the date this expense was incurred." })
  .refine((v) => !Number.isNaN(Date.parse(v)), { error: "Enter a valid date." })
  .refine((v) => Date.parse(v) <= Date.now() + 24 * 60 * 60 * 1000, {
    error: "Date cannot be in the future.",
  });

// Shared UUID identifier check for every Phase 1E Server Action's
// businessId/categoryId/expenseId form fields (lib/expenses/actions.ts).
// A non-empty-but-malformed identifier (not a UUID at all) is rejected
// before any permission lookup or database call — merely checking "is
// this a non-empty string" would let a garbage value like "not-a-uuid"
// reach getPermissions()/the RPC layer and surface a raw Postgres
// 22P02 there instead of a controlled, generic ActionState error. A
// well-formed but foreign/nonexistent UUID is a separate, expected case,
// still handled by the ordinary tenant-scoped RLS/RPC checks further
// down — this schema only rules out syntactically invalid input.
export const IdSchema = z.uuid();

export const CreateExpenseSchema = z.object({
  creationKey: z.uuid(),
  categoryId: z.uuid({ error: "Choose a category." }),
  amount: ExpenseAmountSchema,
  paymentMethod: ExpensePaymentMethodSchema,
  incurredAt: ExpenseIncurredAtSchema,
  payee: optionalTrimmed(PAYEE_MAX_LENGTH),
  reference: optionalTrimmed(REFERENCE_MAX_LENGTH),
  notes: optionalTrimmed(NOTES_MAX_LENGTH),
});

export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;

export const VoidExpenseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, { error: "Enter a reason for voiding this expense." })
    .max(VOID_REASON_MAX_LENGTH, {
      error: `Reason must be ${VOID_REASON_MAX_LENGTH} characters or fewer.`,
    }),
});

export type VoidExpenseInput = z.infer<typeof VoidExpenseSchema>;

export const ExpenseFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  categoryId: z.uuid().optional(),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]).optional(),
  status: z.enum(["POSTED", "VOIDED"]).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});

export type ExpenseFilterInput = z.infer<typeof ExpenseFilterSchema>;

/**
 * Parses raw, untrusted `searchParams` values (each may be a string,
 * string[], or undefined — Next.js's own searchParams shape) into a safe
 * ExpenseFilterInput, field by field. Deliberately LENIENT per-field, not
 * a single whole-object parse: a malformed value in ONE field (a
 * `categoryId` that isn't a UUID, a `dateFrom` that isn't a real calendar
 * date) is silently dropped — treated as "no filter" for that field
 * specifically — while every OTHER, well-formed filter still applies.
 * This is what actually keeps a malformed value from ever reaching
 * lib/expenses/dal.ts (and therefore Postgres) at all: the DAL only ever
 * receives already-validated values from this function in the normal
 * page flow (it also independently defends itself — see
 * lib/expenses/dal.ts's own UUID/calendar-date checks — but this is the
 * primary boundary).
 */
export function parseExpenseListFilters(query: Record<string, string | string[] | undefined>): ExpenseFilterInput {
  const pick = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" ? value : undefined;
  };

  const rawSearch = pick("search");
  const search = ExpenseFilterSchema.shape.search.safeParse(rawSearch);
  const categoryId = ExpenseFilterSchema.shape.categoryId.safeParse(pick("categoryId"));
  const paymentMethod = ExpenseFilterSchema.shape.paymentMethod.safeParse(pick("paymentMethod"));
  const status = ExpenseFilterSchema.shape.status.safeParse(pick("status"));
  const dateFrom = ExpenseFilterSchema.shape.dateFrom.safeParse(pick("dateFrom"));
  const dateTo = ExpenseFilterSchema.shape.dateTo.safeParse(pick("dateTo"));

  // Each individually well-formed "YYYY-MM-DD" string compares correctly
  // with plain lexicographic `>` (ISO calendar dates sort the same way
  // as strings and as instants) — no Date parsing needed for this check.
  // An INVERTED pair (dateFrom after dateTo) is a contradictory
  // predicate, not a malformed value — Codex adversarial review, Finding
  // 1: BOTH dates are dropped together (never silently swapped, which
  // would change the caller's actual intent), while every other filter
  // (search/categoryId/paymentMethod/status) is completely unaffected.
  const datesInverted =
    dateFrom.success && dateTo.success && dateFrom.data !== undefined && dateTo.data !== undefined &&
    dateFrom.data > dateTo.data;

  return {
    search: search.success ? search.data : undefined,
    categoryId: categoryId.success ? categoryId.data : undefined,
    paymentMethod: paymentMethod.success ? paymentMethod.data : undefined,
    status: status.success ? status.data : undefined,
    dateFrom: datesInverted ? undefined : dateFrom.success ? dateFrom.data : undefined,
    dateTo: datesInverted ? undefined : dateTo.success ? dateTo.data : undefined,
  };
}

// Category name validation — mirrors expense_categories.name's exact
// CHECK constraint (length(name) <= 100 and length(btrim(name)) >= 2).
// Used for both create (name only — status is never caller-chosen at
// creation, matching the INSERT grant which excludes that column
// entirely) and rename (name only — archiving is a separate, dedicated
// action, never bundled into this schema).
export const ExpenseCategoryNameSchema = z
  .string()
  .trim()
  .min(CATEGORY_NAME_MIN_LENGTH, {
    error: `Name must be at least ${CATEGORY_NAME_MIN_LENGTH} characters.`,
  })
  .max(CATEGORY_NAME_MAX_LENGTH, {
    error: `Name must be ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`,
  });

export const CreateExpenseCategorySchema = z.object({
  name: ExpenseCategoryNameSchema,
});

export type CreateExpenseCategoryInput = z.infer<typeof CreateExpenseCategorySchema>;

export const UpdateExpenseCategorySchema = z.object({
  name: ExpenseCategoryNameSchema,
});

export type UpdateExpenseCategoryInput = z.infer<typeof UpdateExpenseCategorySchema>;
