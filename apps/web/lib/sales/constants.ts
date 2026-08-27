// Verified against the exact CHECK-constrained domains in
// supabase/migrations/20260826090400_create_sales_and_sale_items.sql.
// The DRAFT/CANCELLED status values remain valid in the database's own
// domain for future compatibility, but Phase 1D's create_sale RPC never
// produces either as a committed row — this application layer has no UI
// for them, matching the approved database contract exactly (no
// complete_sale, no cancel_sale, no draft editing).

export const SALE_STATUS = {
  COMPLETED: "COMPLETED",
} as const;

export type SaleStatus = (typeof SALE_STATUS)[keyof typeof SALE_STATUS];

export const PAYMENT_STATUS = {
  UNPAID: "UNPAID",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  [PAYMENT_STATUS.UNPAID]: "Unpaid",
  [PAYMENT_STATUS.PARTIALLY_PAID]: "Partially paid",
  [PAYMENT_STATUS.PAID]: "Paid",
};

export const PAYMENT_METHOD = {
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  CARD: "CARD",
  OTHER: "OTHER",
} as const;

export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  [PAYMENT_METHOD.CASH]: "Cash",
  [PAYMENT_METHOD.BANK_TRANSFER]: "Bank transfer",
  [PAYMENT_METHOD.CARD]: "Card",
  [PAYMENT_METHOD.OTHER]: "Other",
};

// The database's own hard maximum (create_sale rejects TOO_MANY_SALE_ITEMS
// past this) — mirrored here so client-side validation matches exactly.
export const MAX_SALE_ITEMS = 100;
