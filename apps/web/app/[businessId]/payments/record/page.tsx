import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { PayableInvoicePicker } from "@/components/invoices/payable-invoice-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Codex adversarial review, remediation round 1, Medium 4: a
 * payments.record-only caller (no invoices.view) previously had NO
 * surface to record a payment from at all — the only existing one, the
 * invoice detail page's own PaymentForm, independently requires
 * invoices.view just to load. This route requires payments.record ALONE,
 * and its own invoice picker (PayableInvoicePicker) resolves eligible
 * invoices through get_payable_invoice_options
 * (20260831080700_invoice_picker_rpcs.sql), likewise authorized on
 * payments.record alone.
 */
export default async function RecordPaymentPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/payments/record">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.PAYMENTS_RECORD);

  // A caller with payments.record but no invoices.view lands back here
  // after recording (see recordInvoicePayment's own redirect logic,
  // lib/invoices/actions.ts) — mirrors /invoices/new's own identical
  // `?created=1` pattern.
  const created = query.created === "1";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Record payment</h1>
      {created ? (
        <Alert data-testid="payment-recorded-banner">
          <AlertDescription>Payment recorded successfully.</AlertDescription>
        </Alert>
      ) : null}
      <PayableInvoicePicker businessId={businessId} />
    </div>
  );
}
