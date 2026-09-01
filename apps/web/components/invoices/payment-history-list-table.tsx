import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/invoices/constants";
import type { InvoicePaymentHistoryRow } from "@/lib/invoices/dal";

/**
 * Codex adversarial review, remediation round 1, Medium 4: the
 * payments.view-only history surface (/[businessId]/payments) — distinct
 * from components/invoices/payment-history-table.tsx (which shows ONE
 * invoice's own payments on its detail page); this shows every payment
 * across the business, so invoice number/customer/branch are included as
 * their own columns.
 */
export function PaymentHistoryListTable({ payments }: { payments: InvoicePaymentHistoryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Reference</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => (
            <TableRow key={payment.id}>
              <TableCell>{new Date(payment.paid_at).toLocaleString()}</TableCell>
              <TableCell className="font-medium">{payment.invoice_number}</TableCell>
              <TableCell>{payment.customer_name_snapshot}</TableCell>
              <TableCell>{payment.branch_name_snapshot}</TableCell>
              <TableCell className="font-medium">{formatMoney(payment.amount, "NGN")}</TableCell>
              <TableCell>{PAYMENT_METHOD_LABEL[payment.payment_method as PaymentMethod] ?? payment.payment_method}</TableCell>
              <TableCell>{payment.reference ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
