"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateSaleReturnSchema, IdSchema } from "@/lib/validation/returns";
import { MAX_SEARCH_LENGTH } from "@/lib/returns/constants";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

// Codex security audit, INFO-01 carryover: a cheap, deterministic bound —
// never a rate-limiting subsystem — applied to every search string before
// it reaches a picker RPC. Truncates rather than rejects, exactly
// mirroring lib/invoices/actions.ts's own boundSearch.
function boundSearch(search: string): string {
  return search.slice(0, MAX_SEARCH_LENGTH);
}

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

export type ReturnableSaleOption = {
  id: string;
  saleNumber: string;
  customerName: string | null;
  branchName: string;
  completedAt: string;
  total: number;
  amountPaid: number;
};

// Read-only, called directly from the client sale picker
// (components/returns/sale-picker.tsx) as it types — independently
// authenticates and re-checks returns.manage itself. Backed by
// get_returnable_sale_options (returns.manage-gated alone — see that
// RPC's own header comment for the exact permission-contract gap this
// closes: create_sale_return itself is authorized on returns.manage
// alone, but public.sales'/public.sale_items' own SELECT policies are
// gated on sales.view, a permission returns.manage does not imply).
export async function searchReturnableSalesAction(
  businessId: string,
  search: string
): Promise<ReturnableSaleOption[]> {
  await requireUser();
  if (!IdSchema.safeParse(businessId).success) {
    return [];
  }
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.RETURNS_MANAGE)) {
    return [];
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_returnable_sale_options", {
    p_business_id: businessId,
    p_search: search ? boundSearch(search) : undefined,
  });
  if (error) return [];
  return (data ?? []).map(
    (row: {
      id: string;
      sale_number: string;
      customer_name_snapshot: string | null;
      branch_name_snapshot: string;
      completed_at: string;
      total: number;
      amount_paid: number;
    }) => ({
      id: row.id,
      saleNumber: row.sale_number,
      customerName: row.customer_name_snapshot,
      branchName: row.branch_name_snapshot,
      completedAt: row.completed_at,
      total: row.total,
      amountPaid: row.amount_paid,
    })
  );
}

export type ReturnableSaleItem = {
  saleItemId: string;
  productName: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  alreadyReturned: number;
  remaining: number;
};

export type ReturnableSaleItemsResult =
  | { ok: true; items: ReturnableSaleItem[] }
  | { ok: false; error: string };

// Backs the create-return UI's item lookup, once a sale is chosen.
// Independently authenticates and re-checks returns.manage itself.
// Applies the SAME safe error mapping create_sale_return's own errors go
// through (mapDatabaseError) — a caller retrying a stale/now-ineligible
// sale selection sees the identical, non-disclosing message the create
// action itself would show, never a raw SQLSTATE.
export async function getReturnableSaleItemsAction(
  businessId: string,
  saleId: string
): Promise<ReturnableSaleItemsResult> {
  await requireUser();
  if (!IdSchema.safeParse(businessId).success || !IdSchema.safeParse(saleId).success) {
    return { ok: false, error: "Something went wrong. Please try again." };
  }
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.RETURNS_MANAGE)) {
    return { ok: false, error: "You don't have permission to do this." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_returnable_sale_items", {
    p_business_id: businessId,
    p_sale_id: saleId,
  });
  if (error) {
    return { ok: false, error: mapDatabaseError(error).message };
  }
  const rows = (data ?? []) as {
    sale_item_id: string;
    product_name_snapshot: string;
    sku_snapshot: string | null;
    quantity: number;
    unit_price: number;
    already_returned: number;
  }[];
  return {
    ok: true,
    items: rows.map((row) => ({
      saleItemId: row.sale_item_id,
      productName: row.product_name_snapshot,
      sku: row.sku_snapshot,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      alreadyReturned: Number(row.already_returned),
      remaining: Number(row.quantity) - Number(row.already_returned),
    })),
  };
}

// Independently authenticates and re-checks returns.manage on every call
// — never relies on the create-return page/button having been hidden.
// Mirrors createInvoice's own exact shape, including its
// manage-without-view redirect fix.
export async function createSaleReturn(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const rawBusinessId = formData.get("businessId");
  if (typeof rawBusinessId !== "string" || !IdSchema.safeParse(rawBusinessId).success) {
    return MALFORMED_REQUEST;
  }
  const businessId = rawBusinessId;

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.RETURNS_MANAGE)) {
    return PERMISSION_DENIED;
  }

  // The line-item array is serialized to a single hidden JSON field by
  // the client (components/returns/return-form.tsx) — parsed safely
  // here, never trusted to already be well-formed.
  let rawItems: unknown;
  try {
    const itemsJson = formData.get("items");
    rawItems = typeof itemsJson === "string" ? JSON.parse(itemsJson) : undefined;
  } catch {
    return { fieldErrors: { items: ["Something went wrong with the item list. Please try again."] } };
  }

  const rawRefundMethod = formData.get("refundMethod");
  const rawReason = formData.get("reason");

  const parsed = CreateSaleReturnSchema.safeParse({
    creationKey: formData.get("creationKey"),
    saleId: formData.get("saleId"),
    items: rawItems,
    refundAmount: formData.get("refundAmount") || "0",
    refundMethod: typeof rawRefundMethod === "string" && rawRefundMethod ? rawRefundMethod : undefined,
    reason: typeof rawReason === "string" && rawReason ? rawReason : undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction — exactly the shape
  // create_sale_return expects, never a caller-supplied product/price
  // snapshot (there is no such field on this schema at all).
  const rpcItems = parsed.data.items.map((item) => ({
    sale_item_id: item.saleItemId,
    quantity: item.quantity,
    restock: item.restock,
  }));

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_sale_return", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_sale_id: parsed.data.saleId,
    p_items: rpcItems,
    p_refund_amount: parsed.data.refundAmount,
    p_refund_method: parsed.data.refundMethod,
    p_reason: parsed.data.reason,
    p_notes: parsed.data.notes,
  });

  if (error || !data) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/returns`);

  // returns.manage does NOT imply returns.view (a real, intended
  // permission split — see 20260901080400_returns_permissions.sql's own
  // header comment) — a manage-only caller lands back on the create page
  // instead of the detail page they cannot access, which independently
  // requires returns.view and would 404 them. Checked against the SAME
  // `permissions` set already fetched above — never inferred from
  // create_sale_return having succeeded. Mirrors createInvoice's own
  // identical fix (lib/invoices/actions.ts), including the `?created=1`
  // success-banner convention on the fallback destination.
  if (permissions.has(PERMISSION.RETURNS_VIEW)) {
    redirect(`/${businessId}/returns/${data}`);
  }
  redirect(`/${businessId}/returns/new?created=1`);
}
