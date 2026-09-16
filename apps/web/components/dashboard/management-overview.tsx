import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary, ManagementReportingAggregate } from "@/lib/reports/dal";
import { formatComparison } from "@/lib/reports/comparison";

type Props = { businessId: string; businessName: string; summary: FinancialSummary; previousSummary: FinancialSummary; reporting: ManagementReportingAggregate; previousReporting: ManagementReportingAggregate };

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

function ComparisonRow({ label, current, previous }: { label: string; current: number; previous: number }) {
  const comparison = formatComparison(current, previous);
  return <div className="grid gap-1 border-t py-3 first:border-t-0 first:pt-0 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-x-4">
    <p className="text-sm font-medium">{label}</p>
    <p className="text-sm tabular-nums"><span className="font-semibold">{current}</span> <span className="text-muted-foreground">· {comparison.label}</span></p>
  </div>;
}

export function ManagementOverview({ businessId, businessName, summary, previousSummary, reporting, previousReporting }: Props) {
  const money = (amount: number) => formatMoney(amount, summary.currencyCode);
  const currentSales = reportingSales(reporting);
  const priorSales = reportingSales(previousReporting);

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
    <section aria-label="Customer and inventory indicators" className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Customers</CardTitle></CardHeader><CardContent>
        <ComparisonRow label="New customer records" current={reporting.customerSummary.newCustomers} previous={previousReporting.customerSummary.newCustomers} />
        <ComparisonRow label="Returning customers" current={reporting.customerSummary.returningCustomers} previous={previousReporting.customerSummary.returningCustomers} />
        <ComparisonRow label="Repeat customers" current={reporting.customerSummary.repeatCustomers} previous={previousReporting.customerSummary.repeatCustomers} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Current inventory status</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
        <p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.outOfStockProducts}</span> out-of-stock products</p>
        <p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.lowStockProducts}</span> low-stock products</p>
        <p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.slowMovingProducts}</span> unsold-with-stock products</p>
      </CardContent></Card>
      {reporting.whatsappFollowUpCount !== null ? <Card className="lg:col-span-2"><CardHeader><CardTitle>WhatsApp follow-up</CardTitle></CardHeader><CardContent><p className="text-sm"><span className="font-semibold tabular-nums">{reporting.whatsappFollowUpCount}</span> open conversations where the last recorded message direction is inbound</p></CardContent></Card> : null}
    </section>
  </div>;
}
