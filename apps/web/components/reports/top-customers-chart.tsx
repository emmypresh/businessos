import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";

// Phase 1N-C3 — one meaningful visualization for the Customer report
// (spec §26): Top Customers by Revenue. Deliberately a horizontal bar
// list, not a second hand-rolled SVG chart engine — reuses this report's
// own already-fetched, revenue-sorted rows (never a second unbounded
// query), capped at the top 5 so it never competes with the detail table
// below it. Every bar's exact value is also printed as text, so the chart
// is its own accessible "table" — no separate data-table fallback needed
// (matches sales-trend-report-chart.tsx's own "value always printed as
// text, never bar-length-only" convention).
export function TopCustomersChart({
  rows,
  currencyCode,
}: {
  rows: { customerId: string; name: string; revenue: number }[];
  currencyCode: string;
}) {
  const top = rows.slice(0, 5);
  const maxRevenue = Math.max(1, ...top.map((r) => r.revenue));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top customers by revenue</CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customer revenue in this range.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Top customers by revenue">
            {top.map((row) => (
              <li key={row.customerId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground">{row.name}</span>
                  <span className="text-muted-foreground">{formatMoney(row.revenue, currencyCode, { display: "symbol" })}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                  <div
                    className="h-full rounded-full bg-kpi-blue-fg"
                    style={{ width: `${Math.max(2, (row.revenue / maxRevenue) * 100)}%` }}
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
