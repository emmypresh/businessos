import Link from "next/link";
import { ArrowUpRight, AlertTriangle, PackageSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ManagementReportingAggregate } from "@/lib/reports/dal";

type InventoryRisk = ManagementReportingAggregate["inventoryRisk"];

type Props = {
  businessId: string;
  canViewInventory: boolean;
  current: InventoryRisk;
};

/**
 * Text only reflects the three frozen inventory-aggregate definitions
 * (get_management_reporting_aggregate, 20260916090000_management_reporting_aggregates.sql).
 * No inventory value, reorder quantity, days-until-stockout, or demand
 * forecast is computed — none exist in the aggregate. Comparisons are
 * intentionally omitted here: these are risk-attention counts, and an
 * increase must never read as a positive/success signal the way a
 * revenue increase does, so no delta styling is attached to them.
 */
function InventoryMetricRow({
  icon: Icon,
  label,
  definition,
  zeroText,
  nonZeroText,
  current,
}: {
  icon: typeof AlertTriangle;
  label: string;
  definition: string;
  zeroText: string;
  nonZeroText: string;
  current: number;
}) {
  return (
    <div className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-sm tabular-nums">{current === 0 ? zeroText : nonZeroText}</p>
          <p className="mt-1 text-xs text-muted-foreground">{definition}</p>
        </div>
      </div>
    </div>
  );
}

export function InventoryInsights({ businessId, canViewInventory, current }: Props) {
  return (
    <Card role="region" aria-labelledby="inventory-insights-heading">
      <CardHeader>
        <CardTitle id="inventory-insights-heading">Inventory insights</CardTitle>
        <p className="text-sm text-muted-foreground">Current stock status, plus product activity for the last 30 days (UTC).</p>
      </CardHeader>
      <CardContent>
        <InventoryMetricRow
          icon={AlertTriangle}
          label="Out of stock (current)"
          definition="Aggregate stock across active locations is zero."
          zeroText="No products are currently out of stock."
          nonZeroText={`${current.outOfStockProducts} product${current.outOfStockProducts === 1 ? "" : "s"} out of stock`}
          current={current.outOfStockProducts}
        />
        <InventoryMetricRow
          icon={AlertTriangle}
          label="Low stock (current)"
          definition="Stock is above zero but at or below the product's configured low-stock threshold."
          zeroText="No products are currently at or below their low-stock threshold."
          nonZeroText={`${current.lowStockProducts} product${current.lowStockProducts === 1 ? "" : "s"} at or below their low-stock threshold`}
          current={current.lowStockProducts}
        />
        <InventoryMetricRow
          icon={PackageSearch}
          label="Unsold with stock (this period)"
          definition="Stock is positive and no completed sale was recorded for the product in this period."
          zeroText="No stocked products went unsold in this period."
          nonZeroText={`${current.slowMovingProducts} stocked product${current.slowMovingProducts === 1 ? "" : "s"} had no completed sale in this period`}
          current={current.slowMovingProducts}
        />
        {canViewInventory ? (
          <Link
            href={`/${businessId}/inventory`}
            className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            View inventory <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
