import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInvoice, getInvoiceItems, getInvoicePayments, getInvoiceVoidEligibility, invoiceBalance } from "@/lib/invoices/dal";
import { INVOICE_STATUS } from "@/lib/invoices/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { formatMoney } from "@/lib/currency";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status-badge";
import { PaymentForm } from "@/components/invoices/payment-form";
import { PaymentHistoryTable } from "@/components/invoices/payment-history-table";
import { VoidInvoiceDialog } from "@/components/invoices/void-invoice-dialog";

export default async function InvoiceDetailPage({
  params,
}: PageProps<"/[businessId]/invoices/[invoiceId]">) {
  const { businessId, invoiceId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.INVOICES_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.INVOICES_MANAGE);
  const canRecordPayment = permissions.has(PERMISSION.PAYMENTS_RECORD);
  const canViewPayments = permissions.has(PERMISSION.PAYMENTS_VIEW);

  // Scoped by BOTH business_id and invoice_id — a forged/foreign
  // invoiceId renders identically to a nonexistent one (notFound()).
  const invoice = await getInvoice(businessId, invoiceId);
  const items = await getInvoiceItems(businessId, invoiceId);
  const payments = canViewPayments ? await getInvoicePayments(businessId, invoiceId) : [];
  const balance = invoiceBalance(invoice);
  const isVoid = invoice.status === INVOICE_STATUS.VOID;
  const isPaid = invoice.status === INVOICE_STATUS.PAID;
  // Codex adversarial review, remediation round 1, Low 6: `payments`
  // above is [] both when the invoice genuinely has none AND when
  // canViewPayments is false (the application-layer read is skipped
  // entirely) — inferring "no payments" from the LATTER case wrongly
  // showed a Void button void_invoice itself would always reject
  // (INVOICE_HAS_PAYMENTS). get_invoice_void_eligibility is authorized
  // on invoices.manage alone (never payments.view), and is the same
  // existence check void_invoice itself performs — a server-authoritative
  // answer, not an inference from a possibly-filtered array. Only called
  // at all when canManage && !isVoid (there is no eligibility question to
  // ask otherwise).
  const canVoid =
    canManage && !isVoid ? await getInvoiceVoidEligibility(businessId, invoiceId) : false;

  return (
    <div className="flex flex-col gap-6" data-testid="invoice-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoice_number}</h1>
          <p className="text-sm text-muted-foreground">
            Issued {new Date(invoice.issued_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <InvoiceStatusBadge status={invoice.status} dueDate={invoice.due_date} balance={balance} />
          <Link href={`/${businessId}/invoices/${invoiceId}/print`} className={buttonVariants({ variant: "outline" })}>
            Print
          </Link>
          {canRecordPayment && !isVoid && !isPaid ? (
            <PaymentForm businessId={businessId} invoiceId={invoiceId} balance={balance} />
          ) : null}
          {canVoid ? (
            <VoidInvoiceDialog businessId={businessId} invoiceId={invoiceId} invoiceNumber={invoice.invoice_number} />
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Bill to</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {/* Rendered from the invoice's OWN historical snapshot —
                never a join to the live customers row. A later customer
                rename never changes what this page shows. */}
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Customer</dt>
              <dd className="font-medium">{invoice.customer_name_snapshot}</dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd>{invoice.customer_phone_snapshot ?? "—"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{invoice.customer_email_snapshot ?? "—"}</dd>
              <dt className="text-muted-foreground">Branch</dt>
              <dd>{invoice.branch_name_snapshot}</dd>
              <dt className="text-muted-foreground">Due date</dt>
              <dd>{invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : "—"}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Total</dt>
              <dd className="font-medium">{formatMoney(invoice.total_amount, "NGN")}</dd>
              <dt className="text-muted-foreground">Paid</dt>
              <dd>{formatMoney(invoice.amount_paid, "NGN")}</dd>
              <dt className="font-medium">Balance</dt>
              <dd className="font-medium">{formatMoney(balance, "NGN")}</dd>
              {isVoid ? (
                <>
                  <dt className="text-muted-foreground">Voided</dt>
                  <dd>{invoice.voided_at ? new Date(invoice.voided_at).toLocaleString() : "—"}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 pr-4 font-normal">Item</th>
                  <th className="py-2 pr-4 font-normal">Quantity</th>
                  <th className="py-2 pr-4 font-normal">Unit price</th>
                  <th className="py-2 font-normal">Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <p className="font-medium">{item.description}</p>
                      {item.sku_snapshot ? <p className="text-xs text-muted-foreground">{item.sku_snapshot}</p> : null}
                    </td>
                    <td className="py-2 pr-4">{item.quantity}</td>
                    <td className="py-2 pr-4">{formatMoney(item.unit_price, "NGN")}</td>
                    <td className="py-2">{formatMoney(item.line_total, "NGN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {invoice.notes ? (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{invoice.notes}</CardContent>
        </Card>
      ) : null}

      {canViewPayments ? (
        <Card data-testid="payment-history">
          <CardHeader>
            <CardTitle>Payment history</CardTitle>
          </CardHeader>
          <CardContent>
            <PaymentHistoryTable payments={payments} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
