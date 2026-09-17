import Link from "next/link";
import { ArrowUpRight, Building2, CircleDollarSign, Receipt, Gauge, Wallet, TrendingUp } from "lucide-react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary, ManagementReportingAggregate } from "@/lib/reports/dal";
import { formatComparison } from "@/lib/reports/comparison";
import { buildSalesTrendChartModel } from "@/lib/reports/sales-trend-chart";
import { SalesTrendChart } from "@/components/dashboard/sales-trend-chart";
import { CustomerInsights } from "@/components/dashboard/customer-insights";
import { InventoryInsights } from "@/components/dashboard/inventory-insights";
import { BranchPerformance } from "@/components/dashboard/branch-performance";
import { WhatsAppFollowUp } from "@/components/dashboard/whatsapp-follow-up";

// ArchitectUI-style KPI accent-icon treatment. One color family per
// metric (never a single reused green) so the KPI row reads as the
// reference's colored-icon-tile grid. Uses the --kpi-*-bg/-fg tokens
// (globals.css) rather than Tailwind `dark:` utilities: this app's dark
// palette activates two ways (the `.dark` class AND OS-level
// prefers-color-scheme with no toggle in the UI at all), but
// `@custom-variant dark (&:is(.dark *))` only ever matches the `.dark`
// class — a `dark:` utility here would silently never apply for an
// OS-dark-mode visitor. The token pair is defined for both activation
// paths in globals.css, exactly like every other color in this app.
const KPI_ACCENTS = {
  revenue: { icon: CircleDollarSign, tile: "bg-kpi-blue-bg text-kpi-blue-fg" },
  sales: { icon: Receipt, tile: "bg-kpi-emerald-bg text-kpi-emerald-fg" },
  aov: { icon: Gauge, tile: "bg-kpi-purple-bg text-kpi-purple-fg" },
  cash: { icon: Wallet, tile: "bg-kpi-cyan-bg text-kpi-cyan-fg" },
  netCashFlow: { icon: TrendingUp, tile: "bg-kpi-orange-bg text-kpi-orange-fg" },
} as const;

type Props = {
  businessId: string;
  businessName: string;
  summary: FinancialSummary;
  previousSummary: FinancialSummary;
  reporting: ManagementReportingAggregate;
  previousReporting: ManagementReportingAggregate;
  canViewCustomers: boolean;
  canViewInventory: boolean;
};

function reportingSales(reporting: ManagementReportingAggregate) {
  const revenue = reporting.salesTrend.reduce((total, day) => total + day.revenue, 0);
  const salesCount = reporting.salesTrend.reduce((total, day) => total + day.orderCount, 0);
  return { revenue, salesCount, averageOrderValue: salesCount === 0 ? 0 : revenue / salesCount };
}

function ComparisonCard({
  label,
  value,
  current,
  previous,
  accent,
}: {
  label: string;
  value: string;
  current: number;
  previous: number;
  accent: (typeof KPI_ACCENTS)[keyof typeof KPI_ACCENTS];
}) {
  const comparison = formatComparison(current, previous);
  const Icon = accent.icon;
  return <Card>
    <CardHeader className="pb-2">
      <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      <CardAction>
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accent.tile}`}>
          <Icon className="size-4.5" aria-hidden="true" />
        </span>
      </CardAction>
    </CardHeader>
    <CardContent>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground" aria-label={`${label}: ${comparison.label}`}>{comparison.label}</p>
    </CardContent>
  </Card>;
}

export function ManagementOverview({ businessId, businessName, summary, previousSummary, reporting, previousReporting, canViewCustomers, canViewInventory }: Props) {
  const money = (amount: number) => formatMoney(amount, summary.currencyCode);
  const currentSales = reportingSales(reporting);
  const priorSales = reportingSales(previousReporting);
  const chartModel = buildSalesTrendChartModel(reporting.salesTrend);

  return <div className="flex flex-col gap-6">
    {/* Compact ArchitectUI-style page heading — replaces the previous
        full-width saturated-blue hero banner. Reuses the shared
        PageHeader (same component every other Phase 1F+ route uses) so
        this stays the page's one real <h1>, with the real "Financial
        overview" link as PageHeader's `actions` slot instead of a
        bespoke pill button. */}
    <PageHeader
      title={businessName}
      description="Financial position and operational indicators for the last 30 days (UTC)."
      icon={<Building2 aria-hidden="true" />}
      actions={
        <Link
          href={`/${businessId}/reports`}
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Financial overview <ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>
      }
    />
    <section aria-labelledby="performance-heading">
      <div className="mb-3"><h2 id="performance-heading" className="text-lg font-semibold tracking-tight">Performance comparison</h2><p className="text-sm text-muted-foreground">Last 30 days (UTC) compared with the immediately preceding 30 days.</p></div>
      <div aria-label="Last 30 days financial summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ComparisonCard label="Completed-sales revenue" value={money(currentSales.revenue)} current={currentSales.revenue} previous={priorSales.revenue} accent={KPI_ACCENTS.revenue} />
        <ComparisonCard label="Completed sales" value={String(currentSales.salesCount)} current={currentSales.salesCount} previous={priorSales.salesCount} accent={KPI_ACCENTS.sales} />
        <ComparisonCard label="Average order value" value={money(currentSales.averageOrderValue)} current={currentSales.averageOrderValue} previous={priorSales.averageOrderValue} accent={KPI_ACCENTS.aov} />
        <ComparisonCard label="Cash collected" value={money(summary.cashCollected)} current={summary.cashCollected} previous={previousSummary.cashCollected} accent={KPI_ACCENTS.cash} />
        <ComparisonCard label="Net cash flow" value={money(summary.netCashFlow)} current={summary.netCashFlow} previous={previousSummary.netCashFlow} accent={KPI_ACCENTS.netCashFlow} />
      </div>
    </section>
    <section aria-labelledby="sales-trend-heading">
      <h2 id="sales-trend-heading" className="sr-only">Sales and revenue trend</h2>
      <SalesTrendChart businessId={businessId} points={chartModel.points} hasActivity={chartModel.hasActivity} currencyCode={summary.currencyCode} rangeLabel="Last 30 days (UTC)" />
    </section>
    <section aria-label="Customer and inventory insights" className="grid gap-4 lg:grid-cols-2">
      <CustomerInsights businessId={businessId} canViewCustomers={canViewCustomers} current={reporting.customerSummary} previous={previousReporting.customerSummary} />
      <InventoryInsights businessId={businessId} canViewInventory={canViewInventory} current={reporting.inventoryRisk} />
      {reporting.whatsappFollowUpCount !== null ? (
        <div className="lg:col-span-2"><WhatsAppFollowUp businessId={businessId} followUpCount={reporting.whatsappFollowUpCount} /></div>
      ) : null}
    </section>
    <BranchPerformance branches={reporting.branchPerformance} currencyCode={summary.currencyCode} />
  </div>;
}
