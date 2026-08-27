// Verified against the exact CHECK-constrained domains in
// supabase/migrations/20260827080200_create_expenses.sql and
// supabase/migrations/20260827080000_create_expense_categories.sql.

export const EXPENSE_STATUS = {
  POSTED: "POSTED",
  VOIDED: "VOIDED",
} as const;

export type ExpenseStatus = (typeof EXPENSE_STATUS)[keyof typeof EXPENSE_STATUS];

export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  [EXPENSE_STATUS.POSTED]: "Posted",
  [EXPENSE_STATUS.VOIDED]: "Voided",
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

export const EXPENSE_CATEGORY_STATUS = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;

export type ExpenseCategoryStatus =
  (typeof EXPENSE_CATEGORY_STATUS)[keyof typeof EXPENSE_CATEGORY_STATUS];

export const EXPENSE_CATEGORY_STATUS_LABEL: Record<ExpenseCategoryStatus, string> = {
  [EXPENSE_CATEGORY_STATUS.ACTIVE]: "Active",
  [EXPENSE_CATEGORY_STATUS.ARCHIVED]: "Archived",
};

// Phase 1E is explicitly NGN-only — expenses.currency_code is a fixed
// literal at the database layer (create_expense hardcodes it, and the
// CHECK constraint on public.expenses.currency_code rejects anything
// else). Mirrored here only for display; the client never sends a
// currency to create_expense at all.
export const EXPENSE_CURRENCY_CODE = "NGN";

// The exact maximum representable value of a numeric(14,2) column
// (precision 14, scale 2), mirroring create_expense's own v_max_money
// exactly.
export const MAX_EXPENSE_AMOUNT = 999_999_999_999.99;

// expense_categories.name's exact CHECK bounds (length(btrim(name))
// between 2 and 100).
export const CATEGORY_NAME_MIN_LENGTH = 2;
export const CATEGORY_NAME_MAX_LENGTH = 100;

// expenses.payee / .reference / .notes and void_reason's exact CHECK
// bounds, mirrored one-for-one from create_expenses.sql and
// void_expense_rpc.sql.
export const PAYEE_MAX_LENGTH = 200;
export const REFERENCE_MAX_LENGTH = 100;
export const NOTES_MAX_LENGTH = 2000;
export const VOID_REASON_MAX_LENGTH = 500;
