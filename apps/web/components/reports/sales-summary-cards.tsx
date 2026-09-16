import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";

// Phase 1N-C2. Deliberately restricted to exactly three facts BusinessOS
// can support accurately for a detail sales report: completed-sales
// revenue, completed sales count, and average order value — never
// "profit"/"income"/"earnings"/"net sales", and never cash-flow concepts
// (cash collected, expenses, net cash flow) which belong to the separate
// Financial overview report, not this one. Revenue/count are the exact
// sum of the frozen daily aggregate's own per-day values (never a raw
// table query); AOV is period revenue / period completed sales, safely
// zero (never NaN/Infinity) when count is 0 — mirrors
// components/dashboard/management-overview.tsx's reportingSales() exactly.
export function SalesSummaryCards({
  revenue,
  salesCount,
  averageOrderValue,
  currencyCode,
}: {
  revenue: number;
  salesCount: number;
  averageOrderValue: number;
  currencyCode: string;
}) {
  const money = (amount: number) => formatMoney(amount, currencyCode);

  return (
    <div className="grid gap-4 sm:grid-cols-3" aria-label="Sales and revenue summary">
      <Card data-testid="kpi-sales-revenue">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Completed-sales revenue</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(revenue)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-completed-sales">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Completed sales</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{salesCount}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-average-order-value">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Average order value</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(averageOrderValue)}</p>
        </CardContent>
      </Card>
    </div>
  );
}
