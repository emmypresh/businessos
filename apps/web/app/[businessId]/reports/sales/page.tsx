import Link from "next/link";
import { ArrowLeft, LineChart } from "lucide-react";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary, getManagementReportingAggregate } from "@/lib/reports/dal";
import { buildReportRangeSearchParams, parseReportRangeQuery } from "@/lib/reports/report-range-query";
import { buildSalesTrendChartModel } from "@/lib/reports/sales-trend-chart";
import { SalesSummaryCards } from "@/components/reports/sales-summary-cards";
import { SalesTrendReportChart } from "@/components/reports/sales-trend-report-chart";
import { SalesDailyTable } from "@/components/reports/sales-daily-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/dashboard/page-header";

// Phase 1N-C2 — Sales & Revenue detailed report.
//
// Server-gated by reports.view ALONE (requirePermissionOrNotFound), the
// exact same convention /[businessId]/reports/page.tsx already uses — no
// role name, no subscription tier, no sales.view requirement. The range
// is resolved through the frozen C1 helper
// (lib/reports/report-range-query.ts's parseReportRangeQuery) — never a
// second date parser — and all data comes from the frozen Phase 1N
// get_management_reporting_aggregate RPC (via getManagementReportingAggregate)
// plus get_financial_summary (via getFinancialSummary, called ONLY for its
// currency_code field — get_management_reporting_aggregate has none —
// mirroring components/dashboard/management-overview.tsx's own identical
// dual-call precedent exactly). No raw sales/sale_items/payments table is
// ever queried from this route.
//
// Branch filtering is deliberately OMITTED: get_management_reporting_aggregate
// has no p_branch_id parameter (unlike get_financial_summary), so there is
// no branch-safe way to scope its daily sales_trend to a single branch
// without changing that frozen aggregate's semantics — out of C2's scope.
// See the C2 build report for the full architecture decision.
export default async function SalesReportPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/reports/sales">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.REPORTS_VIEW);

  const rangeQueryInput = {
    preset: typeof query.preset === "string" ? query.preset : undefined,
    dateFrom: typeof query.dateFrom === "string" ? query.dateFrom : undefined,
    dateTo: typeof query.dateTo === "string" ? query.dateTo : undefined,
  };
  const rangeQuery = parseReportRangeQuery(rangeQueryInput);
  const backHref = `/${businessId}/reports${(() => {
    const search = buildReportRangeSearchParams(rangeQueryInput).toString();
    return search ? `?${search}` : "";
  })()}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        {/* Same compact ArchitectUI-style PageHeader every other route
            uses (Reports workspace, dashboard) — the "Back to Reports"
            affordance rides in the breadcrumbs slot above the h1 so it
            stays a real, range-preserving link with the exact accessible
            name E2E asserts against, not a bespoke header. */}
        <PageHeader
          title="Sales & Revenue"
          description={`Completed-sales performance${rangeQuery.status === "ok" ? ` for ${rangeQuery.query.label}` : ""}.`}
          icon={<LineChart aria-hidden="true" />}
          breadcrumbs={
            <Link
              href={backHref}
              className="inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" /> Back to Reports
            </Link>
          }
        />
        {rangeQuery.status === "ok" ? (
          <p className="text-sm text-muted-foreground" data-testid="active-report-range">
            {rangeQuery.query.label}
          </p>
        ) : null}
      </div>

      {rangeQuery.status === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{rangeQuery.message}</AlertDescription>
        </Alert>
      ) : rangeQuery.status === "pending" ? (
        <p className="text-muted-foreground">Choose a start and end date to see the report.</p>
      ) : (
        <SalesReportContent businessId={businessId} from={rangeQuery.query.range.from} to={rangeQuery.query.range.to} rangeLabel={rangeQuery.query.label} />
      )}
    </div>
  );
}

async function SalesReportContent({
  businessId,
  from,
  to,
  rangeLabel,
}: {
  businessId: string;
  from: string;
  to: string;
  rangeLabel: string;
}) {
  // Both calls are intentionally unfiltered by branch — see this file's
  // own header comment.
  const [summary, reporting] = await Promise.all([
    getFinancialSummary(businessId, from, to),
    getManagementReportingAggregate(businessId, from, to),
  ]);

  // Period totals are the exact sum of the frozen aggregate's own daily
  // buckets — never a second, independently-computed revenue number —
  // matching components/dashboard/management-overview.tsx's reportingSales()
  // exactly. Period AOV is period revenue / period completed sales
  // (never an average of daily AOVs), safely 0 when count is 0.
  const revenue = reporting.salesTrend.reduce((total, day) => total + day.revenue, 0);
  const salesCount = reporting.salesTrend.reduce((total, day) => total + day.orderCount, 0);
  const averageOrderValue = salesCount === 0 ? 0 : revenue / salesCount;

  const chartModel = buildSalesTrendChartModel(reporting.salesTrend);

  return (
    <div className="flex flex-col gap-8">
      {!chartModel.hasActivity ? (
        <Alert>
          <AlertDescription>No completed sales were recorded in this period.</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="sales-summary-heading" className="flex flex-col gap-3">
        <h2 id="sales-summary-heading" className="text-lg font-semibold tracking-tight">
          Summary
        </h2>
        <SalesSummaryCards
          revenue={revenue}
          salesCount={salesCount}
          averageOrderValue={averageOrderValue}
          currencyCode={summary.currencyCode}
        />
      </section>

      <section aria-labelledby="sales-trend-heading" className="flex flex-col gap-3">
        <h2 id="sales-trend-heading" className="sr-only">
          Daily trend
        </h2>
        <SalesTrendReportChart
          points={chartModel.points}
          hasActivity={chartModel.hasActivity}
          currencyCode={summary.currencyCode}
          rangeLabel={rangeLabel}
        />
      </section>

      <section aria-labelledby="sales-daily-heading" className="flex flex-col gap-3">
        {/* Visible heading now lives in SalesDailyTable's own CardTitle
            (same pattern sales-trend-heading/SalesTrendReportChart already
            uses) — this sr-only h2 keeps exactly one real heading in the
            accessibility tree per section, with no duplicate id/text. */}
        <h2 id="sales-daily-heading" className="sr-only">
          Daily breakdown
        </h2>
        <SalesDailyTable points={chartModel.points} currencyCode={summary.currencyCode} />
      </section>
    </div>
  );
}
