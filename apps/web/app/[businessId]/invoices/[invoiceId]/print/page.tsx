import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInvoice, getInvoiceItems, invoiceBalance } from "@/lib/invoices/dal";
import { formatMoney } from "@/lib/currency";
import { PrintButton } from "@/components/invoices/print-button";

/**
 * A plain, print-friendly rendering of the invoice — no PDF-generation
 * backend, matching this phase's own explicit "browser-print-friendly
 * route, not a complex PDF pipeline" scope. Every value here is rendered
 * through ordinary React text interpolation (never dangerouslySetInnerHTML)
 * — the invoice's own notes/customer snapshot fields are free-form
 * caller-entered text, and React already escapes all of it by default.
 *
 * The `<style>` tag below is scoped to THIS page's own lifetime (it
 * unmounts the moment the caller navigates away) and targets only the
 * two structural elements the shared [businessId] dashboard shell always
 * renders (`aside`, `main`) — this route cannot opt out of that shared
 * layout without editing dashboard-shell.tsx itself, which is
 * out-of-scope branding WIP this phase must not touch (see this phase's
 * own final report for the full reasoning). `@media print` means this
 * has zero effect on the screen — the sidebar renders completely
 * normally there — it only hides chrome when the browser's own print
 * dialog is actually used.
 */
export default async function InvoicePrintPage({
  params,
}: PageProps<"/[businessId]/invoices/[invoiceId]/print">) {
  const { businessId, invoiceId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.INVOICES_VIEW);

  const invoice = await getInvoice(businessId, invoiceId);
  const items = await getInvoiceItems(businessId, invoiceId);
  const balance = invoiceBalance(invoice);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 bg-white p-2 text-black print:p-0">
      <style>{`
        @media print {
          aside, header, nav { display: none !important; }
          main { padding: 0 !important; width: 100% !important; }
        }
      `}</style>

      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Invoice {invoice.invoice_number}</h1>
        <PrintButton />
      </div>

      <div className="flex items-start justify-between border-b pb-4">
        <div>
          <p className="text-lg font-semibold">Invoice {invoice.invoice_number}</p>
          <p className="text-sm text-gray-600">Issued {new Date(invoice.issued_at).toLocaleDateString()}</p>
          {invoice.due_date ? (
            <p className="text-sm text-gray-600">Due {new Date(invoice.due_date).toLocaleDateString()}</p>
          ) : null}
        </div>
        <div className="text-right text-sm">
          <p className="font-medium">{invoice.branch_name_snapshot}</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium uppercase text-gray-500">Bill to</p>
        <p className="font-medium">{invoice.customer_name_snapshot}</p>
        {invoice.customer_phone_snapshot ? <p className="text-sm">{invoice.customer_phone_snapshot}</p> : null}
        {invoice.customer_email_snapshot ? <p className="text-sm">{invoice.customer_email_snapshot}</p> : null}
      </div>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2 font-medium">Item</th>
            <th className="py-2 font-medium">Qty</th>
            <th className="py-2 font-medium">Unit price</th>
            <th className="py-2 text-right font-medium">Line total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b">
              <td className="py-2">{item.description}</td>
              <td className="py-2">{item.quantity}</td>
              <td className="py-2">{formatMoney(item.unit_price, "NGN")}</td>
              <td className="py-2 text-right">{formatMoney(item.line_total, "NGN")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ml-auto flex w-56 flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Total</span>
          <span className="font-medium">{formatMoney(invoice.total_amount, "NGN")}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Paid</span>
          <span>{formatMoney(invoice.amount_paid, "NGN")}</span>
        </div>
        <div className="flex justify-between border-t pt-1 font-medium">
          <span>Balance due</span>
          <span>{formatMoney(balance, "NGN")}</span>
        </div>
      </div>

      {invoice.notes ? (
        <div className="border-t pt-4 text-sm">
          <p className="text-xs font-medium uppercase text-gray-500">Notes</p>
          <p className="whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      ) : null}
    </div>
  );
}
