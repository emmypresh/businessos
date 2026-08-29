import { z } from "zod";
import { ROLE_NAME } from "@/lib/business/constants";
import { MAX_ASSIGNABLE_BRANCHES } from "@/lib/staff/constants";

/**
 * Client-side feedback only — the actual authority is each RPC's own
 * validation: create_business_invitation/replace_member_branches
 * (branch-set + primary invariant), change_member_role (role name),
 * suspend_member/reactivate_member (no body beyond ids). See
 * supabase/migrations/20260828080300_business_branch_rpcs.sql,
 * 20260828080500_member_management_rpcs.sql, and
 * 20260828080700_business_invitation_rpcs.sql.
 */

export const IdSchema = z.uuid();

export const RoleSchema = z.enum(Object.values(ROLE_NAME) as [string, ...string[]], {
  error: "Choose a valid role.",
});

// Both create_business_invitation and replace_member_branches share the
// EXACT same invariant (Codex adversarial review round-3 LOCKED
// INVARIANT): at least one branch, and exactly one of the selected
// branches marked primary. Encoded once here and reused for both the
// invite form and the branch-access editor, mirroring the RPC layer's own
// "one invariant, two call sites" shape.
const BranchAssignmentSchema = z
  .object({
    branchIds: z
      .array(z.uuid())
      .min(1, { error: "Select at least one branch." })
      .max(MAX_ASSIGNABLE_BRANCHES, { error: "Too many branches selected." })
      .refine((ids) => new Set(ids).size === ids.length, { error: "Each branch can only be selected once." }),
    primaryBranchId: z.uuid({ error: "Choose a primary branch." }),
  })
  .refine((v) => v.branchIds.includes(v.primaryBranchId), {
    error: "The primary branch must be one of the selected branches.",
    path: ["primaryBranchId"],
  });

export const InviteStaffSchema = z
  .object({
    creationKey: z.uuid(),
    email: z.email({ error: "Enter a valid email address." }).max(254),
    role: RoleSchema,
  })
  .and(BranchAssignmentSchema);

export type InviteStaffInput = z.infer<typeof InviteStaffSchema>;

export const ReplaceMemberBranchesSchema = BranchAssignmentSchema;

export type ReplaceMemberBranchesInput = z.infer<typeof ReplaceMemberBranchesSchema>;

export const ChangeRoleSchema = z.object({
  role: RoleSchema,
});

export type ChangeRoleInput = z.infer<typeof ChangeRoleSchema>;

// Staff list filters ----------------------------------------------------

export const StaffFilterSchema = z.object({
  role: RoleSchema.optional(),
  status: z.enum(["active", "suspended"]).optional(),
  branchId: z.uuid().optional(),
});

export type StaffFilterInput = z.infer<typeof StaffFilterSchema>;

export function parseStaffListFilters(query: Record<string, string | string[] | undefined>): StaffFilterInput {
  const pick = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" ? value : undefined;
  };

  const role = StaffFilterSchema.shape.role.safeParse(pick("role"));
  const status = StaffFilterSchema.shape.status.safeParse(pick("status"));
  const branchId = StaffFilterSchema.shape.branchId.safeParse(pick("branchId"));

  return {
    role: role.success ? role.data : undefined,
    status: status.success ? status.data : undefined,
    branchId: branchId.success ? branchId.data : undefined,
  };
}
