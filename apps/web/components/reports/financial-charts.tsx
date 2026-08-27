import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary } from "@/lib/reports/dal";

// Phase 1E's approved RPC (get_financial_summary) returns only aggregate
// totals for the selected range — no period buckets/time series. Per the
// approved plan, this deliberately does NOT fabricate a time series from
// that shape; it renders simple aggregate comparison bars instead (no
// charting library dependency added — Recharts is not installed in this
// project, and adding one is outside the application-layer scope of this
// phase). A true time-series chart would require a database change and
// is called out as a future enhancement in the implementation report,
// never silently worked around here.

function ComparisonBar({
  label,
  value,
  currencyCode,
  max,
  tone = "default",
}: {
  label: string;
  value: number;
  currencyCode: string;
  max: number;
  tone?: "default" | "negative";
}) {
  const magnitude = Math.abs(value);
  const widthPct = max > 0 ? Math.min(100, (magnitude / max) * 100) : 0;
  const isNegative = value < 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={"font-medium " + (isNegative || tone === "negative" ? "text-destructive" : "")}>
          {formatMoney(value, currencyCode)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={"h-full rounded-full " + (isNegative || tone === "negative" ? "bg-destructive" : "bg-primary")}
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

export function FinancialCharts({ summary }: { summary: FinancialSummary }) {
  const cashFlowMax = Math.max(
    Math.abs(summary.cashCollected),
    Math.abs(summary.expenses),
    Math.abs(summary.netCashFlow),
    1
  );
  const salesMax = Math.max(summary.grossSales, summary.cashCollected, Math.abs(summary.outstandingSales), 1);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cash flow comparison</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ComparisonBar
            label="Cash collected"
            value={summary.cashCollected}
            currencyCode={summary.currencyCode}
            max={cashFlowMax}
          />
          <ComparisonBar
            label="Expenses"
            value={summary.expenses}
            currencyCode={summary.currencyCode}
            max={cashFlowMax}
            tone="negative"
          />
          <ComparisonBar
            label="Net cash flow"
            value={summary.netCashFlow}
            currencyCode={summary.currencyCode}
            max={cashFlowMax}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sales collection state</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ComparisonBar
            label="Gross sales"
            value={summary.grossSales}
            currencyCode={summary.currencyCode}
            max={salesMax}
          />
          <ComparisonBar
            label="Cash collected"
            value={summary.cashCollected}
            currencyCode={summary.currencyCode}
            max={salesMax}
          />
          <ComparisonBar
            label="Outstanding sales"
            value={summary.outstandingSales}
            currencyCode={summary.currencyCode}
            max={salesMax}
          />
        </CardContent>
      </Card>
    </div>
  );
}
