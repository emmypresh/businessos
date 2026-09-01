import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listInvoicePaymentsForViewer } from "@/lib/invoices/dal";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PaymentHistorySearch } from "@/components/invoices/payment-history-search";
import { PaymentHistoryListTable } from "@/components/invoices/payment-history-list-table";
import { Wallet } from "lucide-react";

/**
 * Codex adversarial review, remediation round 1, Medium 4: a
 * payments.view-only caller previously had no usable surface at all —
 * public.invoice_payments' own SELECT policy is already gated on
 * payments.view directly (no RLS gap there), but there was no route that
 * read it, and reading it usefully means joining to invoices for
 * invoice_number/customer/branch, which a payments.view-only caller
 * cannot do through an ordinary PostgREST embed (invoices' own SELECT
 * policy is gated on the DIFFERENT invoices.view permission). Resolved
 * through list_invoice_payments_for_viewer
 * (20260831080700_invoice_picker_rpcs.sql), authorized on payments.view
 * alone.
 */
export default async function PaymentsPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/payments">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.PAYMENTS_VIEW);

  const search = typeof query.search === "string" ? query.search : undefined;
  const payments = await listInvoicePaymentsForViewer(businessId, search);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payments" />
      <PaymentHistorySearch />
      {payments.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={search ? "No payments match your search." : "No payments recorded yet."}
        />
      ) : (
        <PaymentHistoryListTable payments={payments} />
      )}
    </div>
  );
}
