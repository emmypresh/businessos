import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status-badge";
import { invoiceBalance, type InvoiceRow } from "@/lib/invoices/dal";

export function InvoiceListTable({
  businessId,
  invoices,
}: {
  businessId: string;
  invoices: InvoiceRow[];
}) {
  if (invoices.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Paid</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead>Due date</TableHead>
            <TableHead>Issued</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => {
            const balance = invoiceBalance(invoice);
            return (
              <TableRow key={invoice.id}>
                <TableCell>
                  <Link href={`/${businessId}/invoices/${invoice.id}`} className="font-medium hover:underline">
                    {invoice.invoice_number}
                  </Link>
                </TableCell>
                {/* Rendered from the invoice's OWN historical snapshot —
                    never a join to the live customers/business_branches
                    row. A later customer rename or branch rename never
                    changes what this row shows. */}
                <TableCell>{invoice.customer_name_snapshot}</TableCell>
                <TableCell className="text-muted-foreground">{invoice.branch_name_snapshot}</TableCell>
                <TableCell>
                  <InvoiceStatusBadge status={invoice.status} dueDate={invoice.due_date} balance={balance} />
                </TableCell>
                <TableCell className="font-medium">{formatMoney(invoice.total_amount, "NGN")}</TableCell>
                <TableCell>{formatMoney(invoice.amount_paid, "NGN")}</TableCell>
                <TableCell>{formatMoney(balance, "NGN")}</TableCell>
                <TableCell>{invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : "—"}</TableCell>
                <TableCell>{new Date(invoice.issued_at).toLocaleDateString()}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
