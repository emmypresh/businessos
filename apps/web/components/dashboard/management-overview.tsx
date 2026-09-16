import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary, ManagementReportingAggregate } from "@/lib/reports/dal";
import { formatComparison } from "@/lib/reports/comparison";
import { buildSalesTrendChartModel } from "@/lib/reports/sales-trend-chart";
import { SalesTrendChart } from "@/components/dashboard/sales-trend-chart";
import { CustomerInsights } from "@/components/dashboard/customer-insights";
import { InventoryInsights } from "@/components/dashboard/inventory-insights";

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

function ComparisonCard({ label, value, current, previous }: { label: string; value: string; current: number; previous: number }) {
  const comparison = formatComparison(current, previous);
  return <Card>
    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
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
    <section className="flex flex-col justify-between gap-4 rounded-2xl bg-primary p-6 text-primary-foreground shadow-sm sm:flex-row sm:items-end">
      <div>
        <p className="text-sm font-medium text-primary-foreground/75">Business overview</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{businessName}</h1>
        <p className="mt-2 max-w-xl text-sm text-primary-foreground/80">Your financial position and transparent operational indicators for the last 30 days (UTC).</p>
      </div>
      <Link href={`/${businessId}/reports`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-background px-5 text-sm font-semibold text-foreground transition-colors hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-primary">
        Financial overview <ArrowUpRight className="size-4" aria-hidden="true" />
      </Link>
    </section>
    <section aria-labelledby="performance-heading">
      <div className="mb-3"><h2 id="performance-heading" className="text-lg font-semibold tracking-tight">Performance comparison</h2><p className="text-sm text-muted-foreground">Last 30 days (UTC) compared with the immediately preceding 30 days.</p></div>
      <div aria-label="Last 30 days financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ComparisonCard label="Completed-sales revenue" value={money(currentSales.revenue)} current={currentSales.revenue} previous={priorSales.revenue} />
        <ComparisonCard label="Completed sales" value={String(currentSales.salesCount)} current={currentSales.salesCount} previous={priorSales.salesCount} />
        <ComparisonCard label="Average order value" value={money(currentSales.averageOrderValue)} current={currentSales.averageOrderValue} previous={priorSales.averageOrderValue} />
        <ComparisonCard label="Cash collected" value={money(summary.cashCollected)} current={summary.cashCollected} previous={previousSummary.cashCollected} />
        <ComparisonCard label="Net cash flow" value={money(summary.netCashFlow)} current={summary.netCashFlow} previous={previousSummary.netCashFlow} />
      </div>
    </section>
    <section aria-labelledby="sales-trend-heading">
      <h2 id="sales-trend-heading" className="sr-only">Sales and revenue trend</h2>
      <SalesTrendChart businessId={businessId} points={chartModel.points} hasActivity={chartModel.hasActivity} currencyCode={summary.currencyCode} rangeLabel="Last 30 days (UTC)" />
    </section>
    <section aria-label="Customer and inventory insights" className="grid gap-4 lg:grid-cols-2">
      <CustomerInsights businessId={businessId} canViewCustomers={canViewCustomers} current={reporting.customerSummary} previous={previousReporting.customerSummary} />
      <InventoryInsights businessId={businessId} canViewInventory={canViewInventory} current={reporting.inventoryRisk} />
      {reporting.whatsappFollowUpCount !== null ? <Card className="lg:col-span-2"><CardHeader><CardTitle>WhatsApp follow-up</CardTitle></CardHeader><CardContent><p className="text-sm"><span className="font-semibold tabular-nums">{reporting.whatsappFollowUpCount}</span> open conversations where the last recorded message direction is inbound</p></CardContent></Card> : null}
    </section>
  </div>;
}
