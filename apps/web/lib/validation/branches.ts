import { z } from "zod";
import {
  BRANCH_NAME_MIN_LENGTH,
  BRANCH_NAME_MAX_LENGTH,
  BRANCH_CODE_MAX_LENGTH,
  BRANCH_ADDRESS_MAX_LENGTH,
  BRANCH_PHONE_MAX_LENGTH,
} from "@/lib/branches/constants";

/**
 * Client-side feedback only — create_business_branch's/update_business_branch's
 * own validation (supabase/migrations/20260828080300_business_branch_rpcs.sql)
 * remains the actual authority, including the RPC's own whitespace
 * canonicalization (private.canonicalize_branch_name) applied server-side
 * regardless of what's typed here.
 */

// Shared UUID identifier check for every Phase 1F Server Action's
// businessId/branchId/memberId/invitationId form fields — mirrors
// lib/validation/expenses.ts's IdSchema exactly (same reasoning: a
// non-empty-but-malformed identifier is rejected before any permission
// lookup or database call).
export const IdSchema = z.uuid();

// Not whitespace-collapsed here — the RPC does that server-side
// (private.canonicalize_branch_name); this only rejects a name that's too
// short/long BEFORE trimming, matching the RPC's own order (canonicalize,
// then length-check the canonical form). A client showing "2-100
// characters" against the raw typed length is a reasonable approximation
// of that same rule for immediate feedback.
export const BranchNameSchema = z
  .string()
  .trim()
  .min(BRANCH_NAME_MIN_LENGTH, { error: `Name must be at least ${BRANCH_NAME_MIN_LENGTH} characters.` })
  .max(BRANCH_NAME_MAX_LENGTH, { error: `Name must be ${BRANCH_NAME_MAX_LENGTH} characters or fewer.` });

// Codes reject internal whitespace outright (never collapsed), matching
// business_branches.code's own CHECK constraint exactly.
export const BranchCodeSchema = z
  .string()
  .trim()
  .max(BRANCH_CODE_MAX_LENGTH, { error: `Code must be ${BRANCH_CODE_MAX_LENGTH} characters or fewer.` })
  .refine((v) => !/\s/.test(v), { error: "Code cannot contain spaces." })
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalTrimmed = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} must be ${max} characters or fewer.` })
    .optional()
    .transform((v) => (v ? v : undefined));

export const BranchCountryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, { error: "Enter a valid 2-letter country code." })
  .optional()
  .transform((v) => (v ? v : undefined));

export const BranchPhoneSchema = optionalTrimmed(BRANCH_PHONE_MAX_LENGTH, "Phone");

export const CreateBranchSchema = z.object({
  creationKey: z.uuid(),
  name: BranchNameSchema,
  code: BranchCodeSchema,
  addressLine1: optionalTrimmed(BRANCH_ADDRESS_MAX_LENGTH, "Address line 1"),
  addressLine2: optionalTrimmed(BRANCH_ADDRESS_MAX_LENGTH, "Address line 2"),
  city: optionalTrimmed(BRANCH_ADDRESS_MAX_LENGTH, "City"),
  state: optionalTrimmed(BRANCH_ADDRESS_MAX_LENGTH, "State"),
  countryCode: BranchCountryCodeSchema,
  phone: BranchPhoneSchema,
});

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;

// Update carries the exact same field shape — status/is_default are never
// part of this schema at all (they're each their own dedicated action:
// setDefaultBranch, deactivateBranch, reactivateBranch), matching
// update_business_branch's own RPC signature, which has no p_status/
// p_is_default parameter for a caller to even attempt setting.
export const UpdateBranchSchema = CreateBranchSchema.omit({ creationKey: true });

export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;

export const BranchStatusFilterSchema = z.enum(["ACTIVE", "INACTIVE"]);

export const BranchFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: BranchStatusFilterSchema.optional(),
});

export type BranchFilterInput = z.infer<typeof BranchFilterSchema>;

// Mirrors lib/validation/expenses.ts's parseExpenseListFilters exactly:
// per-field, lenient parsing — a malformed value in one field is silently
// dropped rather than invalidating the whole filter set.
export function parseBranchListFilters(
  query: Record<string, string | string[] | undefined>
): BranchFilterInput {
  const pick = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" ? value : undefined;
  };

  const search = BranchFilterSchema.shape.search.safeParse(pick("search"));
  const status = BranchFilterSchema.shape.status.safeParse(pick("status"));

  return {
    search: search.success ? search.data : undefined,
    status: status.success ? status.data : undefined,
  };
}
