import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StockStateBadge } from "@/components/inventory/low-stock-badge";
import type { ProductListRow } from "@/lib/products/dal";

export function ProductListTable({
  businessId,
  products,
}: {
  businessId: string;
  products: ProductListRow[];
}) {
  if (products.length === 0) return null;

  // No cost column here, deliberately, regardless of inventory.view_cost:
  // fetching cost for every row on a list page has the same N+1 shape
  // flagged for inventory history (get_product_cost is single-row), and
  // a column that's always "—" would be more confusing than no column at
  // all. Cost is shown on the product detail page (one product, one
  // fetch) instead — see app/[businessId]/products/[productId]/page.tsx.
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Selling price</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Stock</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <TableRow key={product.id}>
            <TableCell>
              <Link href={`/${businessId}/products/${product.id}`} className="font-medium hover:underline">
                {product.name}
              </Link>
              {product.sku ? <p className="text-xs text-muted-foreground">{product.sku}</p> : null}
            </TableCell>
            <TableCell>
              {product.currency_code} {product.selling_price.toFixed(2)}
            </TableCell>
            <TableCell>
              <Badge variant={product.status === "active" ? "default" : "outline"}>{product.status}</Badge>
            </TableCell>
            <TableCell>
              {product.track_inventory ? (
                <div className="flex items-center gap-2">
                  <span>{product.quantity}</span>
                  <StockStateBadge
                    trackInventory={product.track_inventory}
                    quantity={product.quantity}
                    lowStockThreshold={product.low_stock_threshold}
                  />
                </div>
              ) : (
                <StockStateBadge trackInventory={false} quantity={0} lowStockThreshold={null} />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
