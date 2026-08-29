"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateBranchSchema, UpdateBranchSchema, IdSchema } from "@/lib/validation/branches";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

// Mirrors lib/expenses/actions.ts's own getValidId exactly — extracts a
// required identifier from FormData and validates it is a syntactically
// well-formed UUID, never merely "a non-empty string". A well-formed but
// foreign/nonexistent id is a separate, expected case handled further
// down by the RPC's own tenant-scoped checks.
function getValidId(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  return IdSchema.safeParse(value).success ? value : null;
}

// Every Server Action here is an independently callable mutation boundary
// — it authenticates and re-checks the specific permission it needs
// itself, on every call, regardless of what any page already rendered or
// hid. Mirrors lib/expenses/actions.ts/lib/products/actions.ts exactly.

export async function createBranch(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  if (!businessId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.BRANCHES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = CreateBranchSchema.safeParse({
    creationKey: formData.get("creationKey"),
    name: formData.get("name"),
    code: formData.get("code") || undefined,
    addressLine1: formData.get("addressLine1") || undefined,
    addressLine2: formData.get("addressLine2") || undefined,
    city: formData.get("city") || undefined,
    state: formData.get("state") || undefined,
    countryCode: formData.get("countryCode") || undefined,
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction: ONLY the approved logical inputs
  // are ever sent — never business_id-as-target-tenant beyond the scoped
  // argument, created_by, is_default, or status. The database owns every
  // one of those; there is no field here for a forged value to even
  // populate.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_business_branch", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_name: parsed.data.name,
    p_code: parsed.data.code,
    p_address_line1: parsed.data.addressLine1,
    p_address_line2: parsed.data.addressLine2,
    p_city: parsed.data.city,
    p_state: parsed.data.state,
    p_country_code: parsed.data.countryCode,
    p_phone: parsed.data.phone,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // create_business_branch returns a bare uuid — `data` IS the branch id
  // itself, never a row/object to accidentally spread or forward.
  const branchId = data;

  revalidatePath(`/${businessId}/branches`);

  // branches.manage does NOT imply branches.view — a caller who can
  // create a branch but not view one must never be redirected to a route
  // that independently requires branches.view (that route would just
  // 404 them). Checked against the SAME `permissions` set already fetched
  // above — never inferred from branches.manage having succeeded. Mirrors
  // createExpense's/createSale's own manage-without-view redirect exactly.
  if (permissions.has(PERMISSION.BRANCHES_VIEW)) {
    redirect(`/${businessId}/branches/${branchId}`);
  }
  redirect(`/${businessId}/branches/new?created=1`);
}

export async function updateBranch(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const branchId = getValidId(formData, "branchId");
  if (!businessId || !branchId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.BRANCHES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = UpdateBranchSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code") || undefined,
    addressLine1: formData.get("addressLine1") || undefined,
    addressLine2: formData.get("addressLine2") || undefined,
    city: formData.get("city") || undefined,
    state: formData.get("state") || undefined,
    countryCode: formData.get("countryCode") || undefined,
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_business_branch", {
    p_business_id: businessId,
    p_branch_id: branchId,
    p_name: parsed.data.name,
    p_code: parsed.data.code,
    p_address_line1: parsed.data.addressLine1,
    p_address_line2: parsed.data.addressLine2,
    p_city: parsed.data.city,
    p_state: parsed.data.state,
    p_country_code: parsed.data.countryCode,
    p_phone: parsed.data.phone,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/branches`);
  revalidatePath(`/${businessId}/branches/${branchId}`);

  // Codex adversarial review, application-layer round 2, Medium 2:
  // branches.manage does NOT imply branches.view — a manage-only caller
  // must never be redirected to the detail page, which independently
  // requires branches.view and would 404 them. Mirrors createBranch's own
  // manage-without-view split exactly, reusing the SAME accessible
  // generic-success surface (/branches/new) createBranch already lands
  // manage-only callers on, rather than inventing a second one.
  if (permissions.has(PERMISSION.BRANCHES_VIEW)) {
    redirect(`/${businessId}/branches/${branchId}`);
  }
  redirect(`/${businessId}/branches/new?updated=1`);
}

export async function setDefaultBranch(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const branchId = getValidId(formData, "branchId");
  if (!businessId || !branchId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.BRANCHES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_default_business_branch", {
    p_business_id: businessId,
    p_branch_id: branchId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/branches`);
  revalidatePath(`/${businessId}/branches/${branchId}`);

  if (permissions.has(PERMISSION.BRANCHES_VIEW)) {
    redirect(`/${businessId}/branches/${branchId}`);
  }
  redirect(`/${businessId}/branches/new?defaulted=1`);
}

export async function deactivateBranch(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const branchId = getValidId(formData, "branchId");
  if (!businessId || !branchId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.BRANCHES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("deactivate_business_branch", {
    p_business_id: businessId,
    p_branch_id: branchId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/branches`);
  revalidatePath(`/${businessId}/branches/${branchId}`);

  if (permissions.has(PERMISSION.BRANCHES_VIEW)) {
    redirect(`/${businessId}/branches/${branchId}`);
  }
  redirect(`/${businessId}/branches/new?deactivated=1`);
}

export async function reactivateBranch(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const branchId = getValidId(formData, "branchId");
  if (!businessId || !branchId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.BRANCHES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reactivate_business_branch", {
    p_business_id: businessId,
    p_branch_id: branchId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/branches`);
  revalidatePath(`/${businessId}/branches/${branchId}`);

  if (permissions.has(PERMISSION.BRANCHES_VIEW)) {
    redirect(`/${businessId}/branches/${branchId}`);
  }
  redirect(`/${businessId}/branches/new?reactivated=1`);
}
