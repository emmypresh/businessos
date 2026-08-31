"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { StockAdjustmentSchema } from "@/lib/validation/inventory";
import { directionToMovementType } from "./constants";
import { getBranchCanonicalLocation, getDefaultInventoryLocation, getMovementCostIfAllowed } from "./dal";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

// Independently authenticates and re-checks inventory.adjust on every
// call — never relies on the adjustment page/button having been hidden.
export async function adjustStock(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || !businessId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVENTORY_ADJUST)) {
    return PERMISSION_DENIED;
  }

  const parsed = StockAdjustmentSchema.safeParse({
    idempotencyKey: formData.get("idempotencyKey"),
    productId: formData.get("productId"),
    branchId: formData.get("branchId") || undefined,
    direction: formData.get("direction"),
    quantity: formData.get("quantity"),
    reason: formData.get("reason"),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Phase 1G: when the caller explicitly selected a branch (the NEW UI's
  // own path), it's resolved to its real, current canonical location
  // HERE, server-side — mirroring createProduct's identical opening-stock
  // resolution exactly. When no branch was selected (a legacy caller of
  // this action, predating this UI — Codex adversarial review,
  // application-layer round 2, Blocker 5), this reproduces this action's
  // own pre-Phase-1G calling shape EXACTLY: the business-wide legacy
  // default location (not a branch-resolved one) is what's sent, which is
  // precisely the shape record_inventory_movement's own approved
  // Medium 2C compatibility alias exists to handle — it silently
  // redirects to the caller's own primary-branch canonical location when
  // they lack access to that legacy default, exactly as it always has.
  // Either way, record_inventory_movement independently re-verifies the
  // caller has operational access to whichever branch the resolved
  // location actually belongs to (private.has_branch_access) — this
  // resolution step is a UX/correctness convenience, never the security
  // boundary itself.
  const location = parsed.data.branchId
    ? await getBranchCanonicalLocation(businessId, parsed.data.branchId)
    : await getDefaultInventoryLocation(businessId);
  if (!location) {
    return { fieldErrors: { branchId: ["This branch is not available."] } };
  }
  const movementType = directionToMovementType(parsed.data.direction);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_inventory_movement", {
    p_business_id: businessId,
    p_product_id: parsed.data.productId,
    p_inventory_location_id: location.id,
    p_movement_type: movementType,
    p_quantity: parsed.data.quantity,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // Narrow extraction, same discipline as createProduct: only the
  // product_id is ever read off the RPC's response for the redirect
  // target — `data` (which also carries unit_cost, idempotency_key, and
  // every other ledger column via RETURNING *) is never spread or
  // forwarded.
  const productId = data.product_id;

  revalidatePath(`/${businessId}/inventory`);
  revalidatePath(`/${businessId}/inventory/history`);
  revalidatePath(`/${businessId}/products/${productId}`);

  // Redirect (not a remount-in-place) after a successful adjustment —
  // this is what guarantees one mounted form can never perform two
  // independent adjustments under the same idempotency key: the
  // component that held the key ceases to exist the moment this
  // succeeds, and the next visit to /inventory/adjust mounts a fresh
  // instance with a fresh key.
  redirect(`/${businessId}/inventory?adjusted=1`);
}

// On-demand cost reveal for a single history row (components/inventory/cost-cell.tsx).
// Deliberately NOT eager/bulk — get_movement_unit_cost is a single-row
// accessor RPC; fetching cost for every row on a page would mean one RPC
// call per row (a genuine N+1, flagged in the implementation plan as a
// database-layer change out of scope here). This keeps worst-case RPC
// calls bounded by how many rows a user actually asks about, not by page
// size. Independently re-verifies inventory.view_cost itself (via
// getMovementCostIfAllowed, which never calls the RPC at all when the
// permission is absent) rather than trusting that the button which
// triggered this call was only rendered for an authorized viewer.
export async function revealMovementCost(
  businessId: string,
  ledgerId: string
): Promise<{ cost: number | null } | { error: string }> {
  await requireUser();
  try {
    const cost = await getMovementCostIfAllowed(businessId, ledgerId);
    return { cost };
  } catch {
    return { error: "Could not load cost." };
  }
}
