"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateSaleSchema, SaleProductIdsSchema } from "@/lib/validation/sales";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import { searchProductsForSale, type SaleProductOption } from "@/lib/sales/dal";
import { getBranchCanonicalLocation } from "@/lib/inventory/dal";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read-only, called directly from the client product picker
// (components/sales/product-picker.tsx) as it types — independently
// authenticates and re-checks sales.create itself, exactly like every
// mutation here, even though it mutates nothing. Never queries
// cost_price and never calls a cost accessor RPC — Phase 1D's
// sale-creation UI has no cost/price-override surface.
//
// Codex adversarial review, application-layer round 2, Blocker 2:
// availability must reflect stock at the SELECTED branch's own canonical
// location — the exact location create_sale itself deducts from — never
// a business-wide sum. `branchId` is resolved to that location HERE,
// server-side (never a client-supplied location id); an unrecognized/
// malformed branchId, or one with no canonical location, falls back to
// the unfiltered (business-wide) figure rather than failing the whole
// picker — this is a read-only display convenience, so a resolution
// failure degrades gracefully instead of blocking product search
// entirely. The actual sale is still independently validated and
// authorized against the real selected branch when it's submitted.
export async function searchProductsForSaleAction(
  businessId: string,
  search: string,
  branchId?: string
): Promise<SaleProductOption[]> {
  await requireUser();
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.SALES_CREATE)) {
    return [];
  }
  const location =
    branchId && UUID_PATTERN.test(branchId) ? await getBranchCanonicalLocation(businessId, branchId) : null;
  return searchProductsForSale(businessId, { search: search || undefined, locationId: location?.id });
}

// Codex adversarial review, application-layer round 3, Medium 1: the sale
// form captures each line's availableQuantity at the moment a product is
// ADDED (a plain snapshot in local state — see sale-form.tsx's own
// LineItem type) and never re-derives it afterward, so switching the
// selected branch left every already-added line showing its OLD branch's
// stock figure — stale and misleading, even though the product picker's
// own search results correctly refreshed. This batches a fresh
// availability lookup for every product ALREADY in the cart, at the
// NEWLY selected branch, in one request — never one request per line
// (the review's own explicit "avoid N+1" instruction) — so the sale form
// can refresh every existing line's displayed figure after a branch
// change without re-running a live search. Same authorization/branch-
// resolution shape as searchProductsForSaleAction exactly; still a
// read-only display convenience — create_sale remains the sole
// authoritative check.
//
// Codex adversarial review, application-layer round 3, Low 1: productIds
// is client-controlled (the sale form's own current cart, but a Server
// Action is reachable directly with an arbitrary payload regardless of
// what the UI ever sends) and previously reached
// searchProductsForSale's raw `.in("id", productIds)` uuid-column query
// completely unvalidated — a malformed id would surface as a raw
// Postgres uuid-syntax error instead of a controlled result. Validated
// here with the SAME SaleProductIdsSchema (z.uuid() + MAX_SALE_ITEMS
// cap) every other product/sale id in this app already uses — never a
// second validation approach. ANY invalid element (not just the bad one)
// fails the WHOLE array: this is a read-only batch lookup, not a form
// with per-field errors to report back, so "reject the batch, return
// nothing" is the safe, controlled outcome for a payload that could
// never have been produced by the real UI — mirroring
// searchProductsForSaleAction's own "insufficient permission -> []"
// pattern. Valid ids are deduplicated (via Set) before ever reaching the
// DAL — the cart can never legitimately ask about the same product
// twice, and a duplicate is harmless but wasteful to query for.
export async function getSaleProductAvailabilityAction(
  businessId: string,
  productIds: string[],
  branchId?: string
): Promise<SaleProductOption[]> {
  await requireUser();
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.SALES_CREATE)) {
    return [];
  }
  const parsed = SaleProductIdsSchema.safeParse(productIds);
  if (!parsed.success) {
    return [];
  }
  const uniqueProductIds = Array.from(new Set(parsed.data));
  if (uniqueProductIds.length === 0) {
    return [];
  }
  const location =
    branchId && UUID_PATTERN.test(branchId) ? await getBranchCanonicalLocation(businessId, branchId) : null;
  return searchProductsForSale(businessId, { productIds: uniqueProductIds, locationId: location?.id });
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
    branchId: formData.get("branchId") || undefined,
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
  // Phase 1G: the caller's OWN selection from the form (populated from
  // getOperationalBranchOptions) is sent as-is, never re-derived — but
  // NEVER fabricated when absent: p_branch_id is only included when
  // parsed.data.branchId is actually present, and `undefined` here is
  // dropped from the RPC payload entirely (never coerced to a fake
  // value), which create_sale's own trailing `default null` parameter
  // treats identically to an explicit NULL — its own approved
  // omitted-branch fallback (resolve via the caller's active primary
  // branch) runs exactly as it did before this UI existed. Either way,
  // create_sale independently re-validates that the resolved branch is
  // real, ACTIVE, belongs to this business, and that this caller has
  // operational access to it (private.has_branch_access) — the same
  // authorization boundary this action already relies on everywhere
  // else. A client-forged branch id from a different business, an
  // inactive branch, or one this caller has no assignment to are all
  // rejected by the database itself.
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
    p_branch_id: parsed.data.branchId,
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
