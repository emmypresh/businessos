/**
 * Verified against the exact CHECK constraints in
 * supabase/migrations/20260902090000_create_audit_events.sql and the
 * exact action strings the Phase 1J instrumentation migration
 * (20260902100000_instrument_core_audit_events.sql) actually produces —
 * not guessed.
 */

export const AUDIT_CATEGORY = {
  COMMERCE: "COMMERCE",
  INVENTORY: "INVENTORY",
  FINANCE: "FINANCE",
  CUSTOMER: "CUSTOMER",
  ORGANIZATION: "ORGANIZATION",
  SECURITY: "SECURITY",
  SYSTEM: "SYSTEM",
} as const;

export type AuditCategory = (typeof AUDIT_CATEGORY)[keyof typeof AUDIT_CATEGORY];

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  COMMERCE: "Commerce",
  INVENTORY: "Inventory",
  FINANCE: "Finance",
  CUSTOMER: "Customer",
  ORGANIZATION: "Organization",
  SECURITY: "Security",
  SYSTEM: "System",
};

export const AUDIT_OUTCOME = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  DENIED: "DENIED",
} as const;

export type AuditOutcome = (typeof AUDIT_OUTCOME)[keyof typeof AUDIT_OUTCOME];

// Every action key the current instrumentation round actually produces.
// A future, not-yet-known action is rendered via normalizeActionLabel's
// own safe fallback below — never left unhandled.
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "sale.created": "Sale created",
  "return.created": "Return created",
  "expense.posted": "Expense posted",
  "invoice.created": "Invoice created",
  "payment.recorded": "Payment recorded",
  "inventory.adjusted": "Inventory adjusted",
  "customer.created": "Customer created",
  "branch.created": "Branch created",
  "branch.deactivated": "Branch deactivated",
  "staff.invited": "Staff invited",
  "product.created": "Product created",
};

/**
 * A future action this application doesn't yet recognize is rendered as
 * plain, safely-normalized text — never raw dot/underscore-separated
 * machine syntax, and never dangerously interpreted as markup (this
 * returns plain text; the caller renders it as a text node, never via
 * dangerouslySetInnerHTML — see components/activity/action-label.tsx).
 */
export function normalizeActionLabel(action: string): string {
  const known = AUDIT_ACTION_LABEL[action];
  if (known) return known;
  const words = action
    .replace(/[._]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Activity";
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  sale: "Sale",
  sale_return: "Return",
  expense: "Expense",
  invoice: "Invoice",
  invoice_payment: "Payment",
  product: "Product",
  customer: "Customer",
  branch: "Branch",
  staff_invitation: "Invitation",
};

// Codex security review, INFO-01 carryover: a cheap, deterministic bound
// — never a rate-limiting subsystem — matching every other Phase 1C-1J
// search schema's own identical bound.
export const MAX_SEARCH_LENGTH = 200;

export const DEFAULT_ACTIVITY_PAGE_SIZE = 25;
