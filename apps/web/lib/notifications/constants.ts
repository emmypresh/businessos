/**
 * Verified against the exact CHECK constraints in
 * supabase/migrations/20260903080000_create_notifications.sql and the
 * exact notification_type strings the Phase 1K application-layer
 * instrumentation migration
 * (20260903090000_notification_instrumentation.sql) actually produces —
 * not guessed.
 */

export const NOTIFICATION_CATEGORY = {
  COMMERCE: "COMMERCE",
  INVENTORY: "INVENTORY",
  FINANCE: "FINANCE",
  CUSTOMER: "CUSTOMER",
  ORGANIZATION: "ORGANIZATION",
  SECURITY: "SECURITY",
  SYSTEM: "SYSTEM",
} as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORY)[keyof typeof NOTIFICATION_CATEGORY];

export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, string> = {
  COMMERCE: "Commerce",
  INVENTORY: "Inventory",
  FINANCE: "Finance",
  CUSTOMER: "Customer",
  ORGANIZATION: "Organization",
  SECURITY: "Security",
  SYSTEM: "System",
};

export const NOTIFICATION_SEVERITY = {
  INFO: "INFO",
  SUCCESS: "SUCCESS",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
} as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITY)[keyof typeof NOTIFICATION_SEVERITY];

export const NOTIFICATION_SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  INFO: "Info",
  SUCCESS: "Success",
  WARNING: "Warning",
  CRITICAL: "Critical",
};

// Every notification_type this round's own instrumentation
// (20260903090000_notification_instrumentation.sql) actually produces. A
// future, not-yet-known type is rendered via normalizeNotificationTypeLabel's
// own safe fallback below — never left unhandled. Mirrors
// lib/audit/constants.ts's own AUDIT_ACTION_LABEL exactly, for the
// identical reason (notification_type is regex-validated, not a closed
// enum — see the DB foundation's own header comment).
export const NOTIFICATION_TYPE_LABEL: Record<string, string> = {
  "payment.recorded": "Payment recorded",
  "return.completed": "Return completed",
  "expense.posted": "Expense posted",
  "staff.invited": "Staff invitation",
  "branch.deactivated": "Branch deactivated",
};

/**
 * A future notification_type this application doesn't yet recognize is
 * rendered as plain, safely-normalized text — never raw dot/underscore-
 * separated machine syntax, and never interpreted as markup (this
 * returns plain text; every caller renders it as a text node, never via
 * dangerouslySetInnerHTML). Mirrors lib/audit/constants.ts's own
 * normalizeActionLabel exactly.
 */
export function normalizeNotificationTypeLabel(type: string): string {
  const known = NOTIFICATION_TYPE_LABEL[type];
  if (known) return known;
  const words = type
    .replace(/[._]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Notification";
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

// The exact, fixed set of notification_type values this round's
// instrumentation actually produces (20260903090000_notification_
// instrumentation.sql) — the ONLY types the preferences UI ever shows a
// toggle for, per this phase's own explicit "Only show notification
// types actually supported by this round" instruction. A future type
// added by a later round's own instrumentation gets its own toggle by
// being added here, never by this list attempting to be exhaustive of
// every type the regex-validated column could theoretically hold.
export const SUPPORTED_NOTIFICATION_TYPES = [
  "payment.recorded",
  "return.completed",
  "expense.posted",
  "staff.invited",
  "branch.deactivated",
] as const;

export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  invoice_payment: "Payment",
  sale_return: "Return",
  expense: "Expense",
  staff_invitation: "Invitation",
  branch: "Branch",
};

// Codex security review, INFO-01 carryover: a cheap, deterministic bound
// — never a rate-limiting subsystem — matching every other Phase 1C-1K
// search schema's own identical bound.
export const MAX_SEARCH_LENGTH = 200;

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 25;

// Bell dropdown: a small, fixed number of RECENT notifications, never the
// full history — this is a glance surface, not the inbox itself (see
// components/notifications/notification-bell.tsx).
export const BELL_RECENT_LIMIT = 8;

// Visual cap for the unread-count badge — matches this phase's own
// explicit "cap visual count if necessary, e.g. 99+" instruction. The
// underlying count query itself is never capped (COUNT(*) with a
// LIMIT-free index-backed query — see getUnreadNotificationCount), only
// the rendered text is.
export const UNREAD_BADGE_CAP = 99;
