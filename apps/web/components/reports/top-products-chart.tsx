import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatIntegerTick } from "@/lib/reports/sales-trend-chart";

// Phase 1N-C3 — one meaningful visualization for the Inventory report
// (spec §27): Top Products by Units Sold. Same horizontal-bar-list
// pattern as TopCustomersChart — capped at 5, exact value always printed
// as text, reuses this report's own already-fetched rows.
export function TopProductsChart({ rows }: { rows: { productId: string; name: string; unitsSold: number }[] }) {
  const top = rows.slice(0, 5);
  const maxUnits = Math.max(1, ...top.map((r) => r.unitsSold));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top products by units sold</CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No units sold in this range.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Top products by units sold">
            {top.map((row) => (
              <li key={row.productId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground">{row.name}</span>
                  <span className="text-muted-foreground">{formatIntegerTick(row.unitsSold)} units</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                  <div
                    className="h-full rounded-full bg-kpi-purple-fg"
                    style={{ width: `${Math.max(2, (row.unitsSold / maxUnits) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
