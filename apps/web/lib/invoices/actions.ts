"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import {
  CreateInvoiceSchema,
  RecordInvoicePaymentSchema,
  IdSchema,
} from "@/lib/validation/invoices";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";
import { MAX_SEARCH_LENGTH } from "@/lib/invoices/constants";

// Codex security audit, INFO-01: a cheap, deterministic bound — never a
// rate-limiting subsystem — applied to every search string before it
// reaches a picker RPC. Truncates rather than rejects: a search box is a
// live, as-you-type filter, not a form field with a validation error to
// show, so silently narrowing an absurdly long paste to its first 200
// characters is the correct behavior, not a hard failure.
function boundSearch(search: string): string {
  return search.slice(0, MAX_SEARCH_LENGTH);
}

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

// Extracts a required identifier field from FormData and validates it is
// a syntactically well-formed UUID — never merely "a non-empty string".
// Mirrors lib/expenses/actions.ts's own getValidId exactly.
function getValidId(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  return IdSchema.safeParse(value).success ? value : null;
}

export type InvoiceProductOption = { id: string; name: string; sku: string | null; sellingPrice: number };

// Read-only, called directly from the client product picker
// (components/invoices/invoice-form.tsx) as it types — independently
// authenticates and re-checks invoices.manage itself.
//
// Codex adversarial review, remediation round 1, Medium 2: this used to
// wrap searchProductsForSale, which reads public.products through
// PostgREST — independently re-enforcing THAT table's own SELECT policy,
// gated on products.view, a permission invoices.manage does not imply.
// A caller with invoices.manage but no products.view could reach the
// "New invoice" page at all (see the branch picker fix below) but never
// see a single product to add. Fixed via a NEW, additive RPC
// (get_invoice_product_options, 20260831080700_invoice_picker_rpcs.sql)
// authorized on invoices.manage alone — never products.view, and never
// granting products.view to invoices.manage-only callers either.
export async function searchProductsForInvoiceAction(
  businessId: string,
  search: string
): Promise<InvoiceProductOption[]> {
  await requireUser();
  // Codex adversarial review, remediation round 2, Low 3: a malformed
  // businessId (e.g. "not-a-uuid") must never reach getPermissions()/the
  // RPC — validated here, before any permission lookup or database call,
  // exactly like createInvoice's own IdSchema-based check.
  if (!IdSchema.safeParse(businessId).success) {
    return [];
  }
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVOICES_MANAGE)) {
    return [];
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_invoice_product_options", {
    p_business_id: businessId,
    p_search: search ? boundSearch(search) : undefined,
  });
  if (error) return [];
  return (data ?? []).map((row: { id: string; name: string; sku: string | null; selling_price: number }) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    sellingPrice: row.selling_price,
  }));
}

export type InvoiceCustomerOption = { id: string; name: string };

// Codex adversarial review, remediation round 1, Medium 2: this used to
// wrap listCustomers, which reads public.customers through PostgREST —
// independently re-enforcing THAT table's own SELECT policy, gated on
// customers.view, a permission invoices.manage does not imply. Fixed via
// a NEW, additive RPC (get_invoice_customer_options,
// 20260831080700_invoice_picker_rpcs.sql) authorized on invoices.manage
// alone — never customers.view.
export async function searchCustomersForInvoiceAction(
  businessId: string,
  search: string
): Promise<InvoiceCustomerOption[]> {
  await requireUser();
  // Codex adversarial review, remediation round 2, Low 3: see
  // searchProductsForInvoiceAction's own identical comment above.
  if (!IdSchema.safeParse(businessId).success) {
    return [];
  }
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVOICES_MANAGE)) {
    return [];
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_invoice_customer_options", {
    p_business_id: businessId,
    p_search: search ? boundSearch(search) : undefined,
  });
  if (error) return [];
  return (data ?? []).map((row: { id: string; name: string }) => ({ id: row.id, name: row.name }));
}

export type PayableInvoiceOption = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  branchName: string;
  totalAmount: number;
  amountPaid: number;
  status: string;
};

// Backs the dedicated payment-recording surface's own invoice picker
// (/[businessId]/payments/record — components/invoices/payable-invoice-picker.tsx).
// Codex adversarial review, remediation round 1, Medium 4: a
// payments.record-only caller (no invoices.view) previously had no way
// to even find an invoice to pay against — the only existing surface,
// the invoice detail page's own PaymentForm, independently requires
// invoices.view just to load at all. Authorized on payments.record
// alone via get_payable_invoice_options (20260831080700_invoice_picker_rpcs.sql)
// — never invoices.view, and never granting it either.
export async function searchPayableInvoicesAction(
  businessId: string,
  search: string
): Promise<PayableInvoiceOption[]> {
  await requireUser();
  // Codex adversarial review, remediation round 2, Low 3: see
  // searchProductsForInvoiceAction's own identical comment above.
  if (!IdSchema.safeParse(businessId).success) {
    return [];
  }
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PAYMENTS_RECORD)) {
    return [];
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_payable_invoice_options", {
    p_business_id: businessId,
    p_search: search ? boundSearch(search) : undefined,
  });
  if (error) return [];
  return (data ?? []).map(
    (row: {
      id: string;
      invoice_number: string;
      customer_name_snapshot: string;
      branch_name_snapshot: string;
      total_amount: number;
      amount_paid: number;
      status: string;
    }) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      customerName: row.customer_name_snapshot,
      branchName: row.branch_name_snapshot,
      totalAmount: row.total_amount,
      amountPaid: row.amount_paid,
      status: row.status,
    })
  );
}

// Independently authenticates and re-checks invoices.manage on every
// call — never relies on the "New invoice" page/button having been
// hidden. Mirrors createSale/createExpense's own exact shape.
export async function createInvoice(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  // Codex adversarial review, remediation round 1, Low 2: a non-empty
  // but MALFORMED businessId (e.g. "not-a-uuid") must never reach
  // getPermissions()/a raw Postgres ::uuid cast — validated here as a
  // real UUID, before any permission lookup or database call, mirroring
  // getValidId's own IdSchema-based check below (used by
  // recordInvoicePayment/voidInvoice) exactly.
  const rawBusinessId = formData.get("businessId");
  if (typeof rawBusinessId !== "string" || !IdSchema.safeParse(rawBusinessId).success) {
    return MALFORMED_REQUEST;
  }
  const businessId = rawBusinessId;

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVOICES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  // The line-item array is serialized to a single hidden JSON field by
  // the client (components/invoices/invoice-form.tsx) — parsed safely
  // here, never trusted to already be well-formed.
  let rawItems: unknown;
  try {
    const itemsJson = formData.get("items");
    rawItems = typeof itemsJson === "string" ? JSON.parse(itemsJson) : undefined;
  } catch {
    return { fieldErrors: { items: ["Something went wrong with the item list. Please try again."] } };
  }

  const parsed = CreateInvoiceSchema.safeParse({
    creationKey: formData.get("creationKey"),
    customerId: formData.get("customerId"),
    branchId: formData.get("branchId"),
    items: rawItems,
    dueDate: formData.get("dueDate") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction, one shape per line kind: a
  // product-linked line sends ONLY product_id and quantity — never
  // unit_price (server-authoritative, the current selling_price, exactly
  // like create_sale's own items); a custom line sends description,
  // quantity, AND unit_price (there is no product row for either to be
  // derived from). Neither shape has a field a forged product price
  // could even populate.
  const rpcItems = parsed.data.items.map((item) =>
    item.productId
      ? { product_id: item.productId, quantity: item.quantity }
      : { description: item.description, quantity: item.quantity, unit_price: item.unitPrice }
  );

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_invoice", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_customer_id: parsed.data.customerId,
    p_branch_id: parsed.data.branchId,
    p_items: rpcItems,
    p_due_date: parsed.data.dueDate,
    p_notes: parsed.data.notes,
  });

  if (error || !data) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/invoices`);

  // Codex adversarial review, remediation round 1, Medium 2: a caller
  // with invoices.manage but WITHOUT invoices.view (a real, intended
  // permission split — see 20260831080600_invoice_payment_permissions.sql's
  // own header comment) would otherwise be redirected straight to the
  // detail page they cannot access, which independently requires
  // invoices.view and would 404 them. Checked against the SAME
  // `permissions` set already fetched above — never inferred from
  // create_invoice having succeeded. Mirrors createSale's own identical
  // fix (lib/sales/actions.ts) exactly, including the `?created=1`
  // success-banner convention on the fallback destination.
  if (permissions.has(PERMISSION.INVOICES_VIEW)) {
    redirect(`/${businessId}/invoices/${data}`);
  }
  redirect(`/${businessId}/invoices/new?created=1`);
}

// Independently authenticates and re-checks payments.record on every
// call. The invoice's own branch is NEVER a caller-supplied value here —
// there is no branchId field on this form at all (see
// record_invoice_payment_rpc.sql's own header comment: the payment's
// branch is always derived server-side from the locked invoice row).
export async function recordInvoicePayment(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const invoiceId = getValidId(formData, "invoiceId");
  if (!businessId || !invoiceId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PAYMENTS_RECORD)) {
    return PERMISSION_DENIED;
  }

  const parsed = RecordInvoicePaymentSchema.safeParse({
    creationKey: formData.get("creationKey"),
    invoiceId,
    amount: formData.get("amount"),
    paymentMethod: formData.get("paymentMethod"),
    paidAt: formData.get("paidAt"),
    reference: formData.get("reference") || undefined,
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("record_invoice_payment", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_invoice_id: parsed.data.invoiceId,
    p_amount: parsed.data.amount,
    p_payment_method: parsed.data.paymentMethod,
    // Codex adversarial review, remediation round 1, Medium 5: paidAt now
    // ARRIVES already converted to a UTC ISO instant, computed in the
    // BROWSER from the visible datetime-local value
    // (components/invoices/payment-form.tsx's own paidAtIso, mirroring
    // components/expenses/expense-form.tsx's own identical
    // incurredAtIso pattern) — never re-parsed here. The previous
    // `new Date(parsed.data.paidAt).toISOString()` ran on the SERVER,
    // parsing a bare datetime-local string against the SERVER's own
    // runtime timezone (not the submitting user's), silently shifting
    // the recorded instant whenever the two differ.
    p_paid_at: parsed.data.paidAt,
    p_reference: parsed.data.reference,
    p_note: parsed.data.note,
  });

  if (error) {
    return toActionState(mapDatabaseError(error, "invoice_payment"));
  }

  revalidatePath(`/${businessId}/invoices/${invoiceId}`);
  revalidatePath(`/${businessId}/payments`);

  // Codex adversarial review, remediation round 1, Medium 4: a caller
  // with payments.record but WITHOUT invoices.view (recording from the
  // dedicated /payments/record surface) would otherwise be redirected
  // straight to the invoice detail page they cannot access. Every caller
  // reaching this action FROM the invoice detail page's own PaymentForm
  // already holds invoices.view (that page independently requires it to
  // load at all), so this branch is a strict generalization, never a
  // regression for the existing surface.
  if (permissions.has(PERMISSION.INVOICES_VIEW)) {
    redirect(`/${businessId}/invoices/${invoiceId}`);
  }
  redirect(`/${businessId}/payments/record?created=1`);
}

// Independently authenticates and re-checks invoices.manage on every
// call. Mirrors voidExpense's own exact shape.
export async function voidInvoice(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const invoiceId = getValidId(formData, "invoiceId");
  if (!businessId || !invoiceId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVOICES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("void_invoice", {
    p_business_id: businessId,
    p_invoice_id: invoiceId,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/invoices`);
  revalidatePath(`/${businessId}/invoices/${invoiceId}`);
  redirect(`/${businessId}/invoices/${invoiceId}`);
}
