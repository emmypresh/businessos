import Link from "next/link";
import { ArrowUpRight, BarChart3, ReceiptText, WalletCards } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { FinancialSummary, ManagementReportingAggregate } from "@/lib/reports/dal";

export function ManagementOverview({ businessId, businessName, summary, reporting }: { businessId: string; businessName: string; summary: FinancialSummary; reporting: ManagementReportingAggregate }) {
  const money = (amount: number) => formatMoney(amount, summary.currencyCode);
  const metrics = [
    { label: "Gross sales", value: money(summary.grossSales), icon: BarChart3 },
    { label: "Cash collected", value: money(summary.cashCollected), icon: WalletCards },
    { label: "Outstanding sales", value: money(summary.outstandingSales), icon: ReceiptText },
  ];

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
    <section aria-label="Last 30 days financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map(({ label, value, icon: Icon }) => <Card key={label}>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Icon className="size-4" aria-hidden="true" />{label}</CardTitle></CardHeader>
        <CardContent><p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p></CardContent>
      </Card>)}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Net cash flow</CardTitle></CardHeader>
        <CardContent><p className="text-2xl font-semibold tracking-tight tabular-nums">{money(summary.netCashFlow)}</p><p className="mt-1 text-xs text-muted-foreground">Cash collected − expenses</p></CardContent>
      </Card>
    </section>
    <Card>
      <CardHeader><CardTitle>Activity snapshot</CardTitle></CardHeader>
      <CardContent className="grid gap-4 text-sm sm:grid-cols-3"><p><span className="block text-2xl font-semibold tabular-nums">{summary.salesCount}</span><span className="text-muted-foreground">Sales recorded</span></p><p><span className="block text-2xl font-semibold tabular-nums">{summary.expenseCount}</span><span className="text-muted-foreground">Expenses recorded</span></p><p><span className="block text-2xl font-semibold tabular-nums">{money(summary.expenses)}</span><span className="text-muted-foreground">Expenses total</span></p></CardContent>
    </Card>
    <section aria-label="Management indicators" className="grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><CardTitle>Sales trend</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">{reporting.salesTrend.filter((day) => day.orderCount > 0).length} active sales days</p><p className="mt-2 text-sm">Latest daily AOV: <span className="font-semibold tabular-nums">{money(reporting.salesTrend.at(-1)?.averageOrderValue ?? 0)}</span></p></CardContent></Card>
      <Card><CardHeader><CardTitle>Customers</CardTitle></CardHeader><CardContent className="space-y-1 text-sm"><p><span className="font-semibold tabular-nums">{reporting.customerSummary.newCustomers}</span> new records</p><p><span className="font-semibold tabular-nums">{reporting.customerSummary.returningCustomers}</span> returning customers</p><p><span className="font-semibold tabular-nums">{reporting.customerSummary.repeatCustomers}</span> repeat customers</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Inventory risk</CardTitle></CardHeader><CardContent className="space-y-1 text-sm"><p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.outOfStockProducts}</span> out of stock</p><p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.lowStockProducts}</span> low stock</p><p><span className="font-semibold tabular-nums">{reporting.inventoryRisk.slowMovingProducts}</span> unsold with stock</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Branch performance</CardTitle></CardHeader><CardContent><p className="text-sm"><span className="font-semibold tabular-nums">{reporting.branchPerformance.length}</span> currently assigned active branches</p><p className="mt-1 text-xs text-muted-foreground">Only branches in your current branch assignment are included.</p></CardContent></Card>
      {reporting.whatsappFollowUpCount !== null ? <Card><CardHeader><CardTitle>WhatsApp follow-up</CardTitle></CardHeader><CardContent><p className="text-sm"><span className="font-semibold tabular-nums">{reporting.whatsappFollowUpCount}</span> open conversations where the last message is inbound</p></CardContent></Card> : null}
    </section>
  </div>;
}
