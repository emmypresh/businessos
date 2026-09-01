import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/invoices/constants";
import type { InvoicePaymentRow } from "@/lib/invoices/dal";

export function PaymentHistoryTable({ payments }: { payments: InvoicePaymentRow[] }) {
  if (payments.length === 0) {
    return <p className="text-sm text-muted-foreground">No payments recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => (
            <TableRow key={payment.id}>
              <TableCell>{new Date(payment.paid_at).toLocaleString()}</TableCell>
              <TableCell className="font-medium">{formatMoney(payment.amount, "NGN")}</TableCell>
              <TableCell>{PAYMENT_METHOD_LABEL[payment.payment_method as PaymentMethod] ?? payment.payment_method}</TableCell>
              <TableCell>{payment.reference ?? "—"}</TableCell>
              <TableCell>{payment.note ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
