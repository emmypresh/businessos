import { CircleDollarSign, Receipt, Gauge } from "lucide-react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
//
// UI3: icon accent tiles use the exact same --kpi-*-bg/-fg tokens and
// icon choices as management-overview.tsx's KPI_ACCENTS (revenue/sales/
// aov), so this report's summary row reads as the same dashboard KPI
// language rather than a plainer, un-accented card style.
function KpiIcon({ icon: Icon, tile }: { icon: typeof CircleDollarSign; tile: string }) {
  return (
    <CardAction>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tile}`}>
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
    </CardAction>
  );
}

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
    // UI3: sm:grid-cols-3 let 3 columns activate as early as 640px, which
    // inside the persistent dashboard shell (240px sidebar + shell padding)
    // left populated cards only ~144px wide at 768px — too narrow for
    // formatted revenue/AOV values, causing horizontal clipping. 3 columns
    // now wait for xl (1280px), where the shell has verified room; sm/md
    // tablet widths get 2 columns instead, with the AOV card spanning both
    // so the row reads as an intentional 2-then-1 layout rather than an
    // awkward orphaned third card.
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Sales and revenue summary">
      <Card data-testid="kpi-sales-revenue">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Completed-sales revenue</CardTitle>
          <KpiIcon icon={CircleDollarSign} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
        </CardHeader>
        <CardContent>
          <p className="min-w-0 text-2xl font-semibold tracking-tight tabular-nums">{money(revenue)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-completed-sales">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Completed sales</CardTitle>
          <KpiIcon icon={Receipt} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{salesCount}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-average-order-value" className="sm:col-span-2 xl:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Average order value</CardTitle>
          <KpiIcon icon={Gauge} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
        </CardHeader>
        <CardContent>
          <p className="min-w-0 text-2xl font-semibold tracking-tight tabular-nums">{money(averageOrderValue)}</p>
        </CardContent>
      </Card>
    </div>
  );
}
