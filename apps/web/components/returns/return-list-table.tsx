import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { RETURN_REASON_LABEL, type ReturnReason } from "@/lib/returns/constants";
import type { ReturnListRow } from "@/lib/returns/dal";

export function ReturnListTable({ businessId, returns }: { businessId: string; returns: ReturnListRow[] }) {
  if (returns.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Return #</TableHead>
            <TableHead>Sale #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Refund</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {returns.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Link href={`/${businessId}/returns/${row.id}`} className="font-medium hover:underline">
                  {row.return_number}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{row.sale_number}</TableCell>
              <TableCell>{new Date(row.created_at).toLocaleDateString()}</TableCell>
              {/* Rendered from the return's OWN historical snapshot — never
                  a join to the live business_branches row. A later branch
                  rename never changes what this row shows. */}
              <TableCell className="text-muted-foreground">{row.branch_name_snapshot}</TableCell>
              <TableCell>{row.reason ? RETURN_REASON_LABEL[row.reason as ReturnReason] ?? row.reason : "—"}</TableCell>
              <TableCell>{formatMoney(row.refund_amount, "NGN")}</TableCell>
              <TableCell>
                <StatusBadge status={row.status} label="Completed" tone="success" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
