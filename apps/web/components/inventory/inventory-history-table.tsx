import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CostCell } from "@/components/inventory/cost-cell";
import { MOVEMENT_TYPE_LABEL } from "@/lib/inventory/constants";
import type { InventoryHistoryRow } from "@/lib/inventory/dal";

export function InventoryHistoryTable({
  businessId,
  rows,
  showCost,
  showProductColumn = true,
}: {
  businessId: string;
  rows: InventoryHistoryRow[];
  showCost: boolean;
  showProductColumn?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Timestamp</TableHead>
          {showProductColumn ? <TableHead>Product</TableHead> : null}
          <TableHead>Movement</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead>Balance after</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Reason</TableHead>
          {showCost ? <TableHead>Cost</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
              {new Date(row.createdAt).toLocaleString()}
            </TableCell>
            {showProductColumn ? (
              <TableCell>
                <Link href={`/${businessId}/products/${row.productId}`} className="hover:underline">
                  {row.productName}
                </Link>
                {row.productSku ? <p className="text-xs text-muted-foreground">{row.productSku}</p> : null}
              </TableCell>
            ) : null}
            <TableCell>{MOVEMENT_TYPE_LABEL[row.movementType]}</TableCell>
            <TableCell className={row.quantityDelta < 0 ? "text-destructive" : "text-emerald-600"}>
              {row.quantityDelta > 0 ? "+" : ""}
              {row.quantityDelta}
            </TableCell>
            <TableCell>{row.balanceAfter}</TableCell>
            <TableCell>{row.locationName}</TableCell>
            <TableCell>
              <p>{row.reason}</p>
              {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
            </TableCell>
            {showCost ? (
              <TableCell>
                <CostCell businessId={businessId} ledgerId={row.id} />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
