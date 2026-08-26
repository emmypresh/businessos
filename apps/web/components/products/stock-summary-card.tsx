import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { StockStateBadge } from "@/components/inventory/low-stock-badge";

export function StockSummaryCard({
  businessId,
  trackInventory,
  quantity,
  lowStockThreshold,
  locationName,
  canAdjust,
}: {
  businessId: string;
  trackInventory: boolean;
  quantity: number;
  lowStockThreshold: number | null;
  locationName: string;
  canAdjust: boolean;
}) {
  return (
    <Card data-testid="stock-summary-card">
      <CardHeader>
        <CardTitle>Stock</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {trackInventory ? (
          <>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight">{quantity}</span>
              <StockStateBadge
                trackInventory={trackInventory}
                quantity={quantity}
                lowStockThreshold={lowStockThreshold}
              />
            </div>
            <p className="text-sm text-muted-foreground">Location: {locationName}</p>
            {lowStockThreshold !== null ? (
              <p className="text-sm text-muted-foreground">Low-stock threshold: {lowStockThreshold}</p>
            ) : null}
            {canAdjust ? (
              <Link
                href={`/${businessId}/inventory/adjust`}
                className={buttonVariants({ variant: "outline", className: "w-fit" })}
              >
                Adjust stock
              </Link>
            ) : null}
          </>
        ) : (
          <StockStateBadge trackInventory={false} quantity={0} lowStockThreshold={null} />
        )}
      </CardContent>
    </Card>
  );
}
