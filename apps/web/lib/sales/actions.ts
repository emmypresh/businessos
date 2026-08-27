"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateSaleSchema } from "@/lib/validation/sales";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import { searchProductsForSale, type SaleProductOption } from "@/lib/sales/dal";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

// Read-only, called directly from the client product picker
// (components/sales/product-picker.tsx) as it types — independently
// authenticates and re-checks sales.create itself, exactly like every
// mutation here, even though it mutates nothing. Never queries
// cost_price and never calls a cost accessor RPC — Phase 1D's
// sale-creation UI has no cost/price-override surface.
export async function searchProductsForSaleAction(
  businessId: string,
  search: string
): Promise<SaleProductOption[]> {
  await requireUser();
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.SALES_CREATE)) {
    return [];
  }
  return searchProductsForSale(businessId, search || undefined);
}

// Independently authenticates and re-checks sales.create on every call —
// never relies on the "New sale" page/button having been hidden.
export async function createSale(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || !businessId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.SALES_CREATE)) {
    return PERMISSION_DENIED;
  }

  // The line-item array is serialized to a single hidden JSON field by
  // the client (components/sales/sale-form.tsx) — parsed safely here,
  // never trusted to already be well-formed. A malformed blob (tampered
  // field, JS bug) fails as a controlled field error, never a raw
  // JSON.parse exception bubbling out of the action.
  let rawItems: unknown;
  try {
    const itemsJson = formData.get("items");
    rawItems = typeof itemsJson === "string" ? JSON.parse(itemsJson) : undefined;
  } catch {
    return { fieldErrors: { items: ["Something went wrong with the item list. Please try again."] } };
  }

  const parsed = CreateSaleSchema.safeParse({
    creationKey: formData.get("creationKey"),
    customerId: formData.get("customerId") || undefined,
    items: rawItems,
    discount: formData.get("discount") || 0,
    paymentStatus: formData.get("paymentStatus"),
    paymentMethod: formData.get("paymentMethod") || undefined,
    amountPaid: formData.get("amountPaid") || 0,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction: each sale item contains ONLY
  // product_id and quantity — never unit_price, selling_price,
  // line_total, subtotal, total, cost_price, unit_cost_snapshot, or
  // inventory_location_id. The database derives every one of those
  // authoritatively; there is no field on this object for a forged value
  // to even populate.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_items: parsed.data.items.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
    })),
    p_customer_id: parsed.data.customerId,
    p_discount: parsed.data.discount,
    p_payment_status: parsed.data.paymentStatus,
    p_payment_method: parsed.data.paymentMethod,
    p_amount_paid: parsed.data.amountPaid,
    p_notes: parsed.data.notes,
  });

  if (error) {
    return toActionState(mapDatabaseError(error, "sale"));
  }

  // create_sale returns a bare uuid — `data` IS the sale id itself,
  // never a row/object to accidentally spread or forward. The
  // confirmation page re-fetches the sale through the normal,
  // RLS-governed, narrow-column DAL (lib/sales/dal.ts), which is what
  // actually renders the database-authoritative totals/snapshots.
  const saleId = data;

  revalidatePath(`/${businessId}/sales`);
  if (parsed.data.customerId) {
    revalidatePath(`/${businessId}/customers/${parsed.data.customerId}`);
  }

  // sales.create does NOT imply sales.view — a caller who can create a
  // sale but not view one must never be redirected to a route that
  // independently requires sales.view (that route would just 404 them).
  // Checked against the SAME `permissions` set already fetched above —
  // never inferred from sales.create having succeeded.
  if (permissions.has(PERMISSION.SALES_VIEW)) {
    redirect(`/${businessId}/sales/${saleId}`);
  }
  redirect(`/${businessId}/sales/new?created=1`);
}
