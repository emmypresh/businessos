"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateProductSchema, UpdateProductSchema } from "@/lib/validation/products";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import { getBranchCanonicalLocation } from "@/lib/inventory/dal";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

// Every Server Action here is an independently callable mutation
// boundary — it authenticates and re-checks the specific permission it
// needs itself, on every call, regardless of what any page already
// rendered or hid. A hidden "New Product" button is a UX courtesy; this
// check is the actual gate.
export async function createProduct(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || !businessId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PRODUCTS_MANAGE)) {
    return PERMISSION_DENIED;
  }
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  const parsed = CreateProductSchema.safeParse({
    creationKey: formData.get("creationKey"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    sku: formData.get("sku") || undefined,
    barcode: formData.get("barcode") || undefined,
    category: formData.get("category") || undefined,
    unit: formData.get("unit") || undefined,
    costPrice: canSeeCost ? formData.get("costPrice") || undefined : undefined,
    sellingPrice: formData.get("sellingPrice") || undefined,
    trackInventory: formData.get("trackInventory") ?? false,
    lowStockThreshold: formData.get("lowStockThreshold") || undefined,
    openingQuantity: formData.get("openingQuantity") || undefined,
    branchId: formData.get("branchId") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Cost write permission: a caller lacking inventory.view_cost must not
  // supply a client-controlled cost price, even defensively — re-checked
  // here independent of whatever the form did or didn't render, and
  // independent of whatever ended up in `parsed.data` (which the schema
  // parse above already left undefined for such a caller, since the
  // costPrice key was deliberately omitted before parsing).
  const costPrice = canSeeCost ? parsed.data.costPrice : undefined;

  // Phase 1G: opening stock is branch-aware. No opening stock (0/absent)
  // needs no branch/location at all. When opening stock IS requested AND
  // the caller explicitly chose a branch (the NEW UI's own path), that
  // branch (never trusted blindly) is resolved to its real, current
  // canonical location HERE, server-side — never a client-supplied
  // location id. A branch that doesn't resolve to a real, ACTIVE
  // canonical location (foreign, or — structurally near-impossible —
  // missing one) fails as a controlled, field-scoped error before the RPC
  // is ever called. When opening stock is requested but NO branch was
  // selected (a legacy caller of this action, predating this UI —
  // Codex adversarial review, application-layer round 2, Blocker 5),
  // p_opening_location_id is left undefined entirely, exactly
  // reproducing this action's own pre-Phase-1G calling shape — that
  // omission is what lets create_product's own approved compatibility
  // contract (Medium 2B: resolve via the caller's active primary branch)
  // run, rather than this action rejecting the request before the RPC
  // ever sees it.
  let openingLocationId: string | undefined;
  if (parsed.data.openingQuantity && parsed.data.openingQuantity > 0 && parsed.data.branchId) {
    const location = await getBranchCanonicalLocation(businessId, parsed.data.branchId);
    if (!location) {
      return { fieldErrors: { branchId: ["This branch is not available."] } };
    }
    openingLocationId = location.id;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_name: parsed.data.name,
    p_description: parsed.data.description,
    p_sku: parsed.data.sku,
    p_barcode: parsed.data.barcode,
    p_category: parsed.data.category,
    p_unit: parsed.data.unit,
    p_cost_price: costPrice,
    p_selling_price: parsed.data.sellingPrice,
    p_track_inventory: parsed.data.trackInventory,
    p_low_stock_threshold: parsed.data.lowStockThreshold,
    p_opening_quantity: parsed.data.openingQuantity,
    // Explicitly resolved above from the caller's own selected branch when
    // opening stock is requested; omitted (create_product's own primary-
    // branch fallback) only for the "no opening stock at all" case, where
    // it is never read regardless.
    p_opening_location_id: openingLocationId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // Narrow, deliberate extraction: only `id` is ever read off the RPC's
  // response — `data` (which also carries cost_price, creation_key, and
  // every other column via RETURNING *) is never spread, logged, or
  // otherwise forwarded beyond this one field. See lib/errors.ts's own
  // header and the RBAC-implication note in tests for why this matters
  // even when the CURRENT caller is allowed to see cost: the contract
  // must hold regardless.
  const productId = data.id;

  revalidatePath(`/${businessId}/products`);
  redirect(`/${businessId}/products/${productId}`);
}

export async function updateProduct(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  const productId = formData.get("productId");
  if (typeof businessId !== "string" || !businessId || typeof productId !== "string" || !productId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PRODUCTS_MANAGE)) {
    return PERMISSION_DENIED;
  }
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  const parsed = UpdateProductSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    sku: formData.get("sku") || undefined,
    barcode: formData.get("barcode") || undefined,
    category: formData.get("category") || undefined,
    unit: formData.get("unit"),
    costPrice: canSeeCost ? formData.get("costPrice") || undefined : undefined,
    sellingPrice: formData.get("sellingPrice"),
    lowStockThreshold: formData.get("lowStockThreshold") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Cost write permission, built as a conditional spread: the key is
  // either present with the new value, or ABSENT from the object
  // literal entirely — never present with `null`, never a hidden field
  // preserving the old value. An absent key in a Postgres UPDATE simply
  // never touches that column, leaving the stored value untouched.
  const supabase = await createClient();
  const { error } = await supabase
    .from("products")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      sku: parsed.data.sku ?? null,
      barcode: parsed.data.barcode ?? null,
      category: parsed.data.category ?? null,
      unit: parsed.data.unit,
      selling_price: parsed.data.sellingPrice,
      low_stock_threshold: parsed.data.lowStockThreshold ?? null,
      ...(canSeeCost && parsed.data.costPrice !== undefined
        ? { cost_price: parsed.data.costPrice }
        : {}),
    })
    .eq("id", productId)
    .eq("business_id", businessId);

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/products`);
  revalidatePath(`/${businessId}/products/${productId}`);
  redirect(`/${businessId}/products/${productId}`);
}

export async function archiveProduct(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  const productId = formData.get("productId");
  if (typeof businessId !== "string" || !businessId || typeof productId !== "string" || !productId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PRODUCTS_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("products")
    .update({ status: "archived" })
    .eq("id", productId)
    .eq("business_id", businessId);

  if (error) {
    // CANNOT_ARCHIVE_WITH_STOCK surfaces here with its dedicated message
    // — this is the one path where the caller needs to actually act on
    // the specific error, so it's returned as ActionState.error rather
    // than only logged.
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/products`);
  revalidatePath(`/${businessId}/products/${productId}`);
  redirect(`/${businessId}/products/${productId}`);
}
