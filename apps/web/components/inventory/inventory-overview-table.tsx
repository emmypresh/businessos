import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StockStateBadge } from "@/components/inventory/low-stock-badge";
import type { InventoryOverviewRow } from "@/lib/inventory/dal";

export function InventoryOverviewTable({
  businessId,
  rows,
}: {
  businessId: string;
  rows: InventoryOverviewRow[];
}) {
  if (rows.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Current stock</TableHead>
          <TableHead>Low-stock threshold</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.productId}>
            <TableCell>
              <Link href={`/${businessId}/products/${row.productId}`} className="font-medium hover:underline">
                {row.name}
              </Link>
              {row.sku ? <p className="text-xs text-muted-foreground">{row.sku}</p> : null}
            </TableCell>
            <TableCell>{row.locationName}</TableCell>
            <TableCell>{row.quantity}</TableCell>
            <TableCell>{row.lowStockThreshold ?? "—"}</TableCell>
            <TableCell>
              <StockStateBadge
                trackInventory={row.trackInventory}
                quantity={row.quantity}
                lowStockThreshold={row.lowStockThreshold}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
