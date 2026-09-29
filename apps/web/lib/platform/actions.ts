"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { hasPlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import {
  SuspendBusinessSchema,
  ReactivateBusinessSchema,
  ExtendTrialSchema,
} from "@/lib/validation/platform-actions";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = { error: "You don't have permission to do this." };

// Every action here independently re-authenticates (requireUser) and
// re-checks its own narrow platform permission (hasPlatformPermission) —
// never trusts that the UI only rendered this action's button for an
// authorized caller. Each underlying RPC ALSO independently re-derives
// the caller's identity and re-checks the identical permission again at
// the database layer (see 20261001080000_platform_controlled_actions.sql)
// — this Server Action layer is a fast, safe-message-mapping convenience,
// never the actual authorization boundary.
//
// The idempotency key is generated HERE, server-side, via randomUUID() —
// never accepted as free-text client input — exactly once per form
// submission. A double-submit (double-click, network retry) resubmits the
// SAME hidden-field value, so the RPC's own idempotency check collapses
// it into a safe replay rather than a duplicate action; a genuinely new
// submission (the page having been reloaded, producing a new hidden-field
// value from a fresh initial render) is a new, independent action.

export async function suspendBusinessAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const canSuspend = await hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_SUSPEND);
  if (!canSuspend) {
    return PERMISSION_DENIED;
  }

  const parsed = SuspendBusinessSchema.safeParse({
    businessId: formData.get("businessId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_suspend_business", {
    p_business_id: parsed.data.businessId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/internal/admin/businesses/${parsed.data.businessId}`);
  return { success: true };
}

export async function reactivateBusinessAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const canReactivate = await hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_REACTIVATE);
  if (!canReactivate) {
    return PERMISSION_DENIED;
  }

  const parsed = ReactivateBusinessSchema.safeParse({
    businessId: formData.get("businessId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_reactivate_business", {
    p_business_id: parsed.data.businessId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/internal/admin/businesses/${parsed.data.businessId}`);
  return { success: true };
}

export async function extendTrialAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const canExtend = await hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL);
  if (!canExtend) {
    return PERMISSION_DENIED;
  }

  const parsed = ExtendTrialSchema.safeParse({
    businessId: formData.get("businessId"),
    days: formData.get("days"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_extend_trial", {
    p_business_id: parsed.data.businessId,
    p_days: parsed.data.days,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/internal/admin/businesses/${parsed.data.businessId}`);
  return { success: true };
}
