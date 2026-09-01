import { businessTodayDateString } from "@/lib/date/business-timezone";

/**
 * Verified against the exact CHECK constraint in
 * supabase/migrations/20260831080100_create_invoices_and_invoice_items.sql.
 * Deliberately four states, no DRAFT — see that migration's own header
 * comment for why. OVERDUE is never a member of this type: it is always
 * derived (see isInvoiceOverdue below), never a stored status value.
 */
export const INVOICE_STATUS = {
  ISSUED: "ISSUED",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
  VOID: "VOID",
} as const;

export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  ISSUED: "Issued",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  VOID: "Void",
};

/**
 * Verified against the exact CHECK constraint in
 * supabase/migrations/20260831080300_create_invoice_payments.sql. No
 * crypto/payment-gateway method exists in Phase 1H — every value here is
 * a manual, offline channel a Nigerian SME actually receives money
 * through.
 */
export const PAYMENT_METHOD = {
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  POS_CARD: "POS_CARD",
  OTHER: "OTHER",
} as const;

export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  POS_CARD: "POS/Card",
  OTHER: "Other",
};

export const MAX_INVOICE_ITEMS = 100;

// Codex security audit, INFO-01 ("No repository-level rate limit/
// search-length caps"): a cheap, deterministic input bound — never a
// rate-limiting subsystem (explicitly out of scope for Phase 1H; the
// audit's own recommendation defers that to Phase 1P production
// hardening). Matches every other Phase 1C-1H search schema's own
// identical bound (e.g. InvoiceFilterSchema.search,
// lib/validation/{customers,sales,branches,products,expenses}.ts) — used
// here specifically for the three NEW Phase 1H picker/search actions
// (searchProductsForInvoiceAction, searchCustomersForInvoiceAction,
// searchPayableInvoicesAction), whose search string previously reached
// get_invoice_product_options/get_invoice_customer_options/
// get_payable_invoice_options completely unbounded.
export const MAX_SEARCH_LENGTH = 200;

/**
 * OVERDUE is a derived, read-time-only fact — never a stored column, so
 * it can never drift out of sync with the truth it's supposed to
 * reflect (see create_invoices_and_invoice_items.sql's own header
 * comment). An invoice is overdue when it still carries a balance, has a
 * due date that has already passed, and is not VOID (a voided invoice is
 * cancelled, never "overdue" — and PAID is excluded implicitly, since a
 * PAID invoice's own balance is always zero).
 */
export function isInvoiceOverdue(
  invoice: {
    status: InvoiceStatus | string;
    dueDate: string | null;
    balance: number;
  },
  // Injectable purely for deterministic testing (see constants.test.ts's
  // own Lagos-boundary cases) — every real call site omits this and gets
  // the actual current instant.
  now: Date = new Date()
): boolean {
  if (invoice.status === INVOICE_STATUS.VOID || invoice.status === INVOICE_STATUS.PAID) return false;
  if (!invoice.dueDate) return false;
  if (invoice.balance <= 0) return false;
  // Compared as calendar dates, matching due_date's own `date` (not
  // timestamptz) column type — a due date of "today" is not yet overdue.
  // "Today" is Africa/Lagos's own calendar date (Codex adversarial
  // review, remediation round 1, Low 4), NOT the server runtime's own
  // UTC date — see businessTodayDateString's own header comment for why
  // a plain `new Date().toISOString().slice(0, 10)` here silently flags
  // the wrong day for part of every 24 hours.
  const today = businessTodayDateString(now);
  return invoice.dueDate < today;
}
