/**
 * Verified against the exact CHECK constraints in
 * supabase/migrations/20260828080000_create_business_branches.sql — every
 * bound here mirrors that table's own constraints exactly, so client-side
 * validation (lib/validation/branches.ts) and the database's own
 * authoritative checks never disagree about what's allowed.
 */
export const BRANCH_NAME_MIN_LENGTH = 2;
export const BRANCH_NAME_MAX_LENGTH = 100;
export const BRANCH_CODE_MAX_LENGTH = 20;
export const BRANCH_ADDRESS_MAX_LENGTH = 200;
export const BRANCH_PHONE_MAX_LENGTH = 32;
export const DEFAULT_COUNTRY_CODE = "NG";

export const BRANCH_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;

export type BranchStatus = (typeof BRANCH_STATUS)[keyof typeof BRANCH_STATUS];

export const BRANCH_STATUS_LABEL: Record<BranchStatus, string> = {
  [BRANCH_STATUS.ACTIVE]: "Active",
  [BRANCH_STATUS.INACTIVE]: "Inactive",
};
