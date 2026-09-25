import { CircleDollarSign, Wallet, Clock, Receipt as ReceiptIcon, TrendingUp, Activity } from "lucide-react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary } from "@/lib/reports/dal";

// Every label here is deliberately restricted to the exact terminology
// the approved plan allows: gross sales, cash collected, outstanding
// sales, expenses, net cash flow, sales count, expense count. No
// card/label in this component ever says "profit", "gross profit", "net
// profit", or "margin" — net cash flow is never renamed to "profit", and
// the subtext under it exists specifically to keep that distinction
// explicit for the reader.
//
// ArchitectUI-style icon accent tile, same --kpi-*-bg/-fg token
// convention as the dashboard's own KPI cards (management-overview.tsx)
// — kept in sync intentionally, not copy-pasted coincidentally. See that
// file's own KPI_ACCENTS comment for why these are CSS tokens and not
// Tailwind `dark:` utilities.
function KpiIcon({ icon: Icon, tile }: { icon: typeof CircleDollarSign; tile: string }) {
  return (
    <CardAction>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tile}`}>
        <Icon className="size-4.5" aria-hidden="true" />
      </span>
    </CardAction>
  );
}

export function FinancialKpiCards({ summary }: { summary: FinancialSummary }) {
  const money = (amount: number) => formatMoney(amount, summary.currencyCode, { display: "symbol" });

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card data-testid="kpi-gross-sales">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Gross sales</CardTitle>
          <KpiIcon icon={CircleDollarSign} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(summary.grossSales)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-cash-collected">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Cash collected</CardTitle>
          <KpiIcon icon={Wallet} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(summary.cashCollected)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-outstanding-sales">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding sales</CardTitle>
          <KpiIcon icon={Clock} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(summary.outstandingSales)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-expenses">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Expenses</CardTitle>
          <KpiIcon icon={ReceiptIcon} tile="bg-kpi-orange-bg text-kpi-orange-fg" />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tracking-tight">{money(summary.expenses)}</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-net-cash-flow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Net cash flow</CardTitle>
          <KpiIcon icon={TrendingUp} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
        </CardHeader>
        <CardContent>
          <p
            className={
              "text-2xl font-semibold tracking-tight " +
              (summary.netCashFlow < 0 ? "text-destructive" : "")
            }
          >
            {money(summary.netCashFlow)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Net cash flow = cash collected − expenses</p>
        </CardContent>
      </Card>

      <Card data-testid="kpi-activity">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Activity</CardTitle>
          <KpiIcon icon={Activity} tile="bg-kpi-slate-bg text-kpi-slate-fg" />
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-muted-foreground">Sales</dt>
            <dd className="text-right font-medium">{summary.salesCount}</dd>
            <dt className="text-muted-foreground">Expenses</dt>
            <dd className="text-right font-medium">{summary.expenseCount}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
