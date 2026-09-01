import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import { MAX_SEARCH_LENGTH, type InvoiceStatus } from "./constants";

// Codex adversarial review, application-layer round 1, Low 3 precedent
// (lib/branches/dal.ts's own UUID_PATTERN convention): a malformed route
// identifier must never reach Postgres as a raw comparison value.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Explicit column list — never select("*").
const INVOICE_COLUMNS =
  "id, business_id, invoice_number, customer_id, " +
  "customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, " +
  "branch_id, branch_name_snapshot, " +
  "status, issued_at, due_date, total_amount, amount_paid, notes, " +
  "created_by, created_at, updated_at, voided_at, voided_by";

export type InvoiceRow = {
  id: string;
  business_id: string;
  invoice_number: string;
  customer_id: string;
  customer_name_snapshot: string;
  customer_phone_snapshot: string | null;
  customer_email_snapshot: string | null;
  branch_id: string;
  branch_name_snapshot: string;
  status: string;
  issued_at: string;
  due_date: string | null;
  total_amount: number;
  amount_paid: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  voided_by: string | null;
};

// balance_due is NEVER stored (see create_invoices_and_invoice_items.sql's
// own header comment) — every reader derives it identically, here, once.
export function invoiceBalance(invoice: Pick<InvoiceRow, "total_amount" | "amount_paid">): number {
  return Number(invoice.total_amount) - Number(invoice.amount_paid);
}

export const listInvoices = cache(
  async (
    businessId: string,
    options: { search?: string; status?: InvoiceStatus; branchId?: string; cursor?: string } = {}
  ): Promise<{ rows: InvoiceRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("invoices")
      .select(INVOICE_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    if (options.status) {
      query = query.eq("status", options.status);
    }
    if (options.branchId) {
      query = query.eq("branch_id", options.branchId);
    }
    if (options.search) {
      const value = buildImatchSearchValue(options.search);
      query = query.or(`invoice_number.imatch.${value},customer_name_snapshot.imatch.${value}`);
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load invoices: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as InvoiceRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

export const getInvoice = cache(async (businessId: string, invoiceId: string): Promise<InvoiceRow> => {
  await requireUser();
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(invoiceId)) {
    notFound();
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load invoice: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as InvoiceRow;
});

export type InvoiceItemRow = {
  id: string;
  business_id: string;
  invoice_id: string;
  product_id: string | null;
  product_name_snapshot: string | null;
  sku_snapshot: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  position: number;
  created_at: string;
};

// Codex adversarial review, remediation round 1, Low 5: ordered by the
// new `position` column (assigned by create_invoice from the caller's
// own submitted item order — see 20260831080100_create_invoices_and_invoice_items.sql's
// own header comment on that column) instead of created_at, which
// cannot reliably reconstruct submission order — two lines inserted in
// the same statement/transaction can share an identical, or even
// out-of-order, timestamp depending on clock resolution.
export const getInvoiceItems = cache(async (businessId: string, invoiceId: string): Promise<InvoiceItemRow[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("invoice_items")
    .select("id, business_id, invoice_id, product_id, product_name_snapshot, sku_snapshot, description, quantity, unit_price, line_total, position, created_at")
    .eq("business_id", businessId)
    .eq("invoice_id", invoiceId)
    .order("position", { ascending: true });

  if (error) {
    throw new Error(`Failed to load invoice items: ${error.message}`);
  }
  return (data ?? []) as unknown as InvoiceItemRow[];
});

export type InvoicePaymentRow = {
  id: string;
  business_id: string;
  invoice_id: string;
  branch_id: string;
  amount: number;
  payment_method: string;
  reference: string | null;
  note: string | null;
  paid_at: string;
  recorded_by: string;
  created_at: string;
};

export const getInvoicePayments = cache(async (businessId: string, invoiceId: string): Promise<InvoicePaymentRow[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("invoice_payments")
    .select("id, business_id, invoice_id, branch_id, amount, payment_method, reference, note, paid_at, recorded_by, created_at")
    .eq("business_id", businessId)
    .eq("invoice_id", invoiceId)
    .order("paid_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load invoice payments: ${error.message}`);
  }
  return (data ?? []) as unknown as InvoicePaymentRow[];
});

// invoice_branch_options (Phase 1H remediation, Medium 2) -----------------
//
// Backs invoice creation's branch picker, authorized on invoices.manage
// ALONE via get_invoice_branch_options
// (20260831080700_invoice_picker_rpcs.sql) — deliberately NOT
// getOperationalBranchOptions' own 'operations' scope (sales.create OR
// products.manage OR inventory.adjust), which the "New invoice" page used
// before this fix and which would have silently required one of those
// three UNRELATED permissions for a caller who genuinely only holds
// invoices.manage. Same shape as OperationalBranchOptions (id, name,
// code, isPrimary, isDefault / primaryBranchId) so InvoiceForm's own
// props barely change.
export type InvoiceBranchOption = {
  id: string;
  name: string;
  code: string | null;
  isPrimary: boolean;
  isDefault: boolean;
};

export type InvoiceBranchOptions = {
  options: InvoiceBranchOption[];
  primaryBranchId: string | null;
};

export const getInvoiceBranchOptions = cache(
  async (businessId: string): Promise<InvoiceBranchOptions> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_invoice_branch_options", { p_business_id: businessId });
    if (error) {
      throw new Error(`Failed to load invoice branch options: ${error.message}`);
    }
    const rows = (data ?? []) as { id: string; name: string; code: string | null; is_default: boolean; is_primary: boolean }[];
    const options: InvoiceBranchOption[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      isPrimary: r.is_primary,
      isDefault: r.is_default,
    }));
    const primaryBranchId = options.find((o) => o.isPrimary)?.id ?? null;
    return { options, primaryBranchId };
  }
);

// Payment history surface (Phase 1H remediation, Medium 4) -----------------
//
// Backs /[businessId]/payments, authorized on payments.view ALONE via
// list_invoice_payments_for_viewer (20260831080700_invoice_picker_rpcs.sql)
// — a BYPASSRLS read across the invoices/invoice_payments boundary (see
// that RPC's own header comment for why a plain PostgREST embed cannot
// do this for a payments.view-only caller with no invoices.view).
export type InvoicePaymentHistoryRow = {
  id: string;
  paid_at: string;
  invoice_number: string;
  customer_name_snapshot: string;
  branch_name_snapshot: string;
  amount: number;
  payment_method: string;
  reference: string | null;
};

export const listInvoicePaymentsForViewer = cache(
  async (businessId: string, search?: string): Promise<InvoicePaymentHistoryRow[]> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_invoice_payments_for_viewer", {
      p_business_id: businessId,
      // Codex security audit, INFO-01: a cheap, deterministic bound —
      // never a rate-limiting subsystem — matching the identical
      // truncation lib/invoices/actions.ts's own three search actions
      // apply.
      p_search: search ? search.slice(0, MAX_SEARCH_LENGTH) : undefined,
    });
    if (error) {
      throw new Error(`Failed to load payment history: ${error.message}`);
    }
    return (data ?? []) as InvoicePaymentHistoryRow[];
  }
);

// Void-button eligibility (Phase 1H remediation, Low 6) --------------------
//
// Backs the invoice detail page's Void button, authorized on
// invoices.manage ALONE via get_invoice_void_eligibility
// (20260831080700_invoice_picker_rpcs.sql). Deliberately NOT inferred
// from `payments.length === 0` — that array is [] both when an invoice
// genuinely has no payments AND when the caller merely lacks
// payments.view (the application-layer read is skipped entirely in that
// case), which previously caused a false "eligible to void" button for
// an invoices.manage caller without payments.view.
export const getInvoiceVoidEligibility = cache(
  async (businessId: string, invoiceId: string): Promise<boolean> => {
    await requireUser();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_invoice_void_eligibility", {
      p_business_id: businessId,
      p_invoice_id: invoiceId,
    });
    if (error) return false;
    return Boolean(data);
  }
);

export type { Cursor };
