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
  className,
}: {
  label: string;
  value: string;
  current: number;
  previous: number;
  accent: (typeof KPI_ACCENTS)[keyof typeof KPI_ACCENTS];
  className?: string;
}) {
  const comparison = formatComparison(current, previous);
  const Icon = accent.icon;
  return <Card className={className}>
    <CardHeader className="pb-2">
      <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      <CardAction>
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accent.tile}`}>
          <Icon className="size-4.5" aria-hidden="true" />
        </span>
      </CardAction>
    </CardHeader>
    <CardContent className="min-w-0">
      {/* Deliberately NOT break-words: overflow-wrap:break-word lets the
          browser insert a break at ANY character once a "word" overflows,
          which split large NGN values inside their digit groups (e.g.
          "1,020,057,00" / "0.00"). The default wrap behavior only breaks
          at whitespace, and formatMoney's output has exactly one space —
          between the currency code and the number — so the worst case for
          a huge value is two lines split at that safe boundary ("NGN" /
          "1,234,567,890.00"), never a break inside the digits themselves.
          `min-w-0` (here and on the Card content column) lets the value
          shrink to the grid column's actual width instead of forcing it
          wide. The formatter itself (lib/currency.ts) is untouched; only
          the wrapping behavior of its output changes here. */}
      <p className="min-w-0 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
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
      {/* kpi-5col:grid-cols-5 (a registered custom breakpoint at 1440px,
          see the --breakpoint-kpi-5col token in globals.css) lets all five
          real KPIs share one row only once there's genuinely room for the
          largest NGN amounts (option C from the UI2 brief). Tailwind's xl
          breakpoint (1280px) was measured with a headless-browser fixture
          (tmp-kpi-fixture, see PHASE 1N-UI2 remediation) to be unsafe:
          with the persistent 240px sidebar, card gaps and padding, each
          KPI value content box is ~150-176px wide at 1280-1400px while the
          largest formatted amount ("NGN 1,234,567,890.00" at text-2xl)
          measures ~177px, so five columns clip the number there. A
          min-[1440px]: ARBITRARY variant was tried first and silently
          failed: Tailwind appends arbitrary variants at their source
          position rather than sorting them by width, so lg:grid-cols-4
          (compiled later) kept overriding it even past 1440px — a
          registered --breakpoint-* token is required to sort correctly
          against lg/xl — and even after registering it, Tailwind v4 does
          NOT merge a custom --breakpoint-* extension into the same sorted
          media-query order as the core sm/md/lg/xl/2xl scale, so its
          block still compiled before lg's and kept losing. The `!`
          (important) modifier is the fix that actually wins regardless of
          source order, verified via the same fixture reading computed
          grid-template-columns at 1440px. The value content box first
          clears 177px at ~1405px in the fixture; 1440px was chosen
          instead of that hairline cutoff to leave margin for
          font-rendering differences across browsers/OS and because it was
          already verified safe in the original bug report. Below that,
          four columns leaves the fifth card as an awkward single-column
          orphan, so it spans both of the last row's two lg columns instead
          (option A) rather than introducing a sixth placeholder card. */}
      <div aria-label="Last 30 days financial summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 kpi-5col:grid-cols-5!">
        <ComparisonCard label="Completed-sales revenue" value={money(currentSales.revenue)} current={currentSales.revenue} previous={priorSales.revenue} accent={KPI_ACCENTS.revenue} />
        <ComparisonCard label="Completed sales" value={String(currentSales.salesCount)} current={currentSales.salesCount} previous={priorSales.salesCount} accent={KPI_ACCENTS.sales} />
        <ComparisonCard label="Average order value" value={money(currentSales.averageOrderValue)} current={currentSales.averageOrderValue} previous={priorSales.averageOrderValue} accent={KPI_ACCENTS.aov} />
        <ComparisonCard label="Cash collected" value={money(summary.cashCollected)} current={summary.cashCollected} previous={previousSummary.cashCollected} accent={KPI_ACCENTS.cash} />
        <ComparisonCard
          label="Net cash flow"
          value={money(summary.netCashFlow)}
          current={summary.netCashFlow}
          previous={previousSummary.netCashFlow}
          accent={KPI_ACCENTS.netCashFlow}
          className="sm:col-span-2 lg:col-span-2 kpi-5col:col-span-1!"
        />
      </div>
    </section>
    <section aria-labelledby="sales-trend-heading">
      <h2 id="sales-trend-heading" className="sr-only">Sales and revenue trend</h2>
      <SalesTrendChart businessId={businessId} points={chartModel.points} hasActivity={chartModel.hasActivity} currencyCode={summary.currencyCode} rangeLabel="Last 30 days (UTC)" />
    </section>
    {/* Three same-height cards side by side once WhatsApp is authorized
        (reporting.whatsappFollowUpCount !== null), matching the
        reference's [Customer][Inventory][WhatsApp] row; falls back to two
        columns — with no gap left behind — when whatsappFollowUpCount is
        null (not authorized), exactly as UI1/B6 already required. */}
    <section aria-label="Customer and inventory insights" className={`grid gap-4 lg:grid-cols-2 ${reporting.whatsappFollowUpCount !== null ? "xl:grid-cols-3" : ""}`}>
      <CustomerInsights businessId={businessId} canViewCustomers={canViewCustomers} current={reporting.customerSummary} previous={previousReporting.customerSummary} />
      <InventoryInsights businessId={businessId} canViewInventory={canViewInventory} current={reporting.inventoryRisk} />
      {reporting.whatsappFollowUpCount !== null ? (
        // At lg (2-col, before the 3-col row applies at xl) this is the
        // row's third card, so it spans both columns rather than sitting
        // alone beside an empty gap; at xl it reverts to a normal 1/3.
        <div className="lg:col-span-2 xl:col-span-1"><WhatsAppFollowUp businessId={businessId} followUpCount={reporting.whatsappFollowUpCount} /></div>
      ) : null}
    </section>
    <BranchPerformance branches={reporting.branchPerformance} currencyCode={summary.currencyCode} />
  </div>;
}
