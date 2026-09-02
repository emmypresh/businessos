/**
 * Verified against the exact CHECK constraints in
 * supabase/migrations/20260901080100_create_sale_returns_and_items.sql.
 * Every comparison against sale_returns.refund_method/reason/status goes
 * through these constants, never a bare string literal.
 */

// A single fixed value — Phase 1I has no draft/edit/cancel/void workflow
// at all (see that migration's own header comment: "STATUS MODEL").
export const RETURN_STATUS = {
  COMPLETED: "COMPLETED",
} as const;

export type ReturnStatus = (typeof RETURN_STATUS)[keyof typeof RETURN_STATUS];

// Shares the exact same four values as invoices'/payments'
// PAYMENT_METHOD (lib/invoices/constants.ts) — same real-world channels a
// refund actually moves through — but kept as its own, separate constant:
// a return's refund_method and an invoice's payment_method are different
// columns on different tables with independently evolvable domains, even
// though today's value sets happen to coincide.
export const REFUND_METHOD = {
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  POS_CARD: "POS_CARD",
  OTHER: "OTHER",
} as const;

export type RefundMethod = (typeof REFUND_METHOD)[keyof typeof REFUND_METHOD];

export const REFUND_METHOD_LABEL: Record<RefundMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  POS_CARD: "POS/Card",
  OTHER: "Other",
};

export const RETURN_REASON = {
  CUSTOMER_RETURN: "CUSTOMER_RETURN",
  DAMAGED: "DAMAGED",
  WRONG_ITEM: "WRONG_ITEM",
  DEFECTIVE: "DEFECTIVE",
  OTHER: "OTHER",
} as const;

export type ReturnReason = (typeof RETURN_REASON)[keyof typeof RETURN_REASON];

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  CUSTOMER_RETURN: "Customer return",
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong item",
  DEFECTIVE: "Defective",
  OTHER: "Other",
};

// Matches create_sale_return's own v_max_items constant
// (20260901080300_create_sale_return_rpc.sql) — the client-side guard
// mirrors the RPC's own limit, never invents a different one.
export const MAX_RETURN_ITEMS = 100;

// Codex security audit, INFO-01 carryover (Phase 1I product brief): a
// cheap, deterministic input bound — never a rate-limiting subsystem —
// applied to every search string reaching a Phase 1I picker/list RPC.
// Matches every other phase's own identical bound
// (lib/invoices/constants.ts's own MAX_SEARCH_LENGTH, etc.).
export const MAX_SEARCH_LENGTH = 200;
