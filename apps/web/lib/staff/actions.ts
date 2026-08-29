"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import {
  InviteStaffSchema,
  ChangeRoleSchema,
  ReplaceMemberBranchesSchema,
  IdSchema,
} from "@/lib/validation/staff";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

// Mirrors lib/expenses/actions.ts's/lib/branches/actions.ts's own
// getValidId exactly.
function getValidId(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  return IdSchema.safeParse(value).success ? value : null;
}

function getBranchIds(formData: FormData): string[] {
  return formData.getAll("branchIds").filter((v): v is string => typeof v === "string");
}

// Every Server Action here independently re-authenticates and
// re-checks the specific permission it needs — never trusts what any
// page already rendered or hid. Mirrors lib/expenses/actions.ts/
// lib/branches/actions.ts exactly. Backend RPC hierarchy
// (CANNOT_MANAGE_OWNER/CANNOT_MANAGE_SELF/CANNOT_ASSIGN_OWNER_ROLE/
// LAST_OWNER_REQUIRED) is the FINAL authority for OWNER/ADMIN
// relationships — nothing here re-derives or second-guesses it; every
// one of those codes is simply mapped to a safe message via
// lib/errors.ts and returned as-is.

export async function inviteStaff(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  if (!businessId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_INVITE)) {
    return PERMISSION_DENIED;
  }

  const parsed = InviteStaffSchema.safeParse({
    creationKey: formData.get("creationKey"),
    email: formData.get("email"),
    role: formData.get("role"),
    branchIds: getBranchIds(formData),
    primaryBranchId: formData.get("primaryBranchId"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction: ONLY the approved logical inputs
  // are ever sent — never invited_by, status, expires_at, or accepted
  // state. The database owns every one of those.
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_business_invitation", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_branch_ids: parsed.data.branchIds,
    p_primary_branch_id: parsed.data.primaryBranchId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/invitations`);

  // staff.invite does NOT imply staff.view — a caller who can send an
  // invitation but not view the staff roster must never be redirected to
  // a route that independently requires staff.view (that route would
  // just 404 them). Mirrors createExpense's/createBranch's own
  // manage-without-view redirect exactly. Codex adversarial review,
  // application-layer round 2: the invite-only destination is now the
  // real, independent /staff/invitations route (staff.invite-gated only)
  // — not a generic banner on the invite form — since that route
  // genuinely shows the invitation that was just created.
  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff?tab=invitations`);
  }
  redirect(`/${businessId}/staff/invitations`);
}

export async function revokeInvitation(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const invitationId = getValidId(formData, "invitationId");
  if (!businessId || !invitationId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_INVITE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_business_invitation", {
    p_business_id: businessId,
    p_invitation_id: invitationId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/invitations`);

  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff?tab=invitations`);
  }
  redirect(`/${businessId}/staff/invitations`);
}

export async function changeMemberRole(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const memberId = getValidId(formData, "memberId");
  if (!businessId || !memberId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = ChangeRoleSchema.safeParse({ role: formData.get("role") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("change_member_role", {
    p_business_id: businessId,
    p_member_id: memberId,
    p_role: parsed.data.role,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/${memberId}`);

  // staff.manage does NOT imply staff.view — reachable in principle (a
  // custom permission fixture could grant one without the other), even
  // though the UI path to this action normally passes through the
  // staff.view-gated detail page. `/${businessId}` (the business
  // dashboard root) requires only active membership, which every caller
  // here already has — a universally safe fallback, never a route that
  // would 404 them.
  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff/${memberId}`);
  }
  redirect(`/${businessId}`);
}

export async function replaceMemberBranches(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const memberId = getValidId(formData, "memberId");
  if (!businessId || !memberId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = ReplaceMemberBranchesSchema.safeParse({
    branchIds: getBranchIds(formData),
    primaryBranchId: formData.get("primaryBranchId"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("replace_member_branches", {
    p_business_id: businessId,
    p_member_id: memberId,
    p_branch_ids: parsed.data.branchIds,
    p_primary_branch_id: parsed.data.primaryBranchId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/${memberId}`);

  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff/${memberId}`);
  }
  redirect(`/${businessId}`);
}

export async function suspendMember(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const memberId = getValidId(formData, "memberId");
  if (!businessId || !memberId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("suspend_member", {
    p_business_id: businessId,
    p_member_id: memberId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/${memberId}`);

  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff/${memberId}`);
  }
  redirect(`/${businessId}`);
}

export async function reactivateMember(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const memberId = getValidId(formData, "memberId");
  if (!businessId || !memberId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.STAFF_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reactivate_member", {
    p_business_id: businessId,
    p_member_id: memberId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/staff`);
  revalidatePath(`/${businessId}/staff/${memberId}`);

  if (permissions.has(PERMISSION.STAFF_VIEW)) {
    redirect(`/${businessId}/staff/${memberId}`);
  }
  redirect(`/${businessId}`);
}

// Invitation acceptance ---------------------------------------------------
//
// Security-critical — see app/invitations/[invitationId]/page.tsx's own
// header comment for the full privacy contract this action must uphold.
// Deliberately takes ONLY the invitation id, mirroring
// accept_business_invitation's own single-argument signature exactly —
// there is no field here through which a caller could influence role,
// branches, business, or email.
export async function acceptInvitation(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const invitationId = getValidId(formData, "invitationId");
  if (!invitationId) {
    return MALFORMED_REQUEST;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_business_invitation", {
    p_invitation_id: invitationId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // accept_business_invitation returns the joined business's id.
  const businessId = data;
  redirect(`/${businessId}`);
}
