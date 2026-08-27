import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_STATUS, PAYMENT_STATUS_LABEL, type PaymentStatus } from "@/lib/sales/constants";
import type { SaleRow } from "@/lib/sales/dal";

function paymentStatusVariant(status: string) {
  if (status === PAYMENT_STATUS.PAID) return "default" as const;
  if (status === PAYMENT_STATUS.PARTIALLY_PAID) return "secondary" as const;
  return "outline" as const;
}

export function SaleListTable({
  businessId,
  sales,
  showCustomerColumn = true,
}: {
  businessId: string;
  sales: SaleRow[];
  showCustomerColumn?: boolean;
}) {
  if (sales.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Sale</TableHead>
          {showCustomerColumn ? <TableHead>Customer</TableHead> : null}
          <TableHead>Total</TableHead>
          <TableHead>Payment</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sales.map((sale) => (
          <TableRow key={sale.id}>
            <TableCell>
              <Link href={`/${businessId}/sales/${sale.id}`} className="font-medium hover:underline">
                {sale.sale_number}
              </Link>
            </TableCell>
            {showCustomerColumn ? (
              <TableCell>{sale.customer_name_snapshot ?? "Walk-in"}</TableCell>
            ) : null}
            <TableCell>
              {sale.currency_code} {sale.total.toFixed(2)}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Badge variant={paymentStatusVariant(sale.payment_status)}>
                  {PAYMENT_STATUS_LABEL[sale.payment_status as PaymentStatus] ?? sale.payment_status}
                </Badge>
                {sale.payment_method ? (
                  <span className="text-xs text-muted-foreground">{sale.payment_method}</span>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              {sale.completed_at ? new Date(sale.completed_at).toLocaleDateString() : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
