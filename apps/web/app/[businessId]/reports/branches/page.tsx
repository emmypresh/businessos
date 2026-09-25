import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, LineChart, ArrowUpDown, Building2, ShoppingBag, Users2, Gauge, Boxes, Wallet } from "lucide-react";
import { z } from "zod";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { buildReportRangeSearchParams, parseReportRangeQuery } from "@/lib/reports/report-range-query";
import { getBranchDetailReport, parseBranchReportQuery, type BranchReportSortKey } from "@/lib/reports/branch-report";
import { listReportBranchOptions } from "@/lib/branches/dal";
import { buildReportSortHref, buildReportPageHref, type ReportTableLinkState } from "@/lib/reports/report-table-links";
import { DateRangePicker } from "@/components/reports/date-range-picker";
import { BranchTrendChart } from "@/components/reports/branch-trend-chart";
import { TopProductsChart } from "@/components/reports/top-products-chart";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/dashboard/page-header";
import { formatMoney } from "@/lib/currency";

function PaginationLink({ href, disabled, children }: { href: string; disabled: boolean; children: ReactNode }) {
  if (disabled) {
    return (
      <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      {children}
    </Link>
  );
}

const BranchParamSchema = z.uuid();

const SORT_LABEL: Record<BranchReportSortKey, string> = {
  revenue: "Revenue",
  name: "Branch",
  sales_count: "Completed sales",
  average_order_value: "Avg order value",
  active_customers: "Active customers",
  units_sold: "Units sold",
  last_sale: "Last sale (all time)",
};

// Phase 1N-C4 — Branch Detailed Report. Server-gated by reports.view ALONE
// (requirePermissionOrNotFound), the same convention every other /reports
// route uses — never branches.view. All data comes from
// get_branch_detail_report (via getBranchDetailReport), which independently
// re-checks reports.view server-side (defense in depth). No raw
// business_branches/sales/expenses table is ever queried from this route.
//
// The branch selector below (DateRangePicker's own `branch` control,
// already shared with the Customers/Inventory reports) doubles as this
// report's own selected-branch drilldown: "Company-wide" (no branch
// selected) renders the full comparison table; picking a branch renders
// that branch's own detail section beneath the table. See
// lib/branches/dal.ts's listReportBranchOptions — business-wide, includes
// INACTIVE branches, exactly matching this page's own authorization
// decision (see the RPC migration's header comment for why no
// has_branch_access narrowing is applied here).
export default async function BranchReportPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/reports/branches">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.REPORTS_VIEW);

  const allBranches = await listReportBranchOptions(businessId);
  const rawBranchParam = typeof query.branch === "string" ? query.branch : undefined;
  const branchParamParsed = rawBranchParam ? BranchParamSchema.safeParse(rawBranchParam) : undefined;
  const selectedBranch = branchParamParsed?.success ? allBranches.find((b) => b.id === branchParamParsed.data) : undefined;
  const branchId = selectedBranch?.id;

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

  const reportQuery = parseBranchReportQuery({
    search: typeof query.q === "string" ? query.q : undefined,
    sort: typeof query.sort === "string" ? query.sort : undefined,
    direction: typeof query.dir === "string" ? query.dir : undefined,
    page: typeof query.page === "string" ? query.page : undefined,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <PageHeader
          title="Branches"
          description={`Branch performance${rangeQuery.status === "ok" ? ` for ${rangeQuery.query.label}` : ""}.`}
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
      </div>

      <DateRangePicker branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))} />

      {rangeQuery.status === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{rangeQuery.message}</AlertDescription>
        </Alert>
      ) : rangeQuery.status === "pending" ? (
        <p className="text-muted-foreground">Choose a start and end date to see the report.</p>
      ) : (
        <BranchReportContent
          businessId={businessId}
          from={rangeQuery.query.range.from}
          to={rangeQuery.query.range.to}
          rangeLabel={rangeQuery.query.label}
          preset={rangeQuery.query.preset}
          dateFrom={rangeQuery.query.custom?.dateFrom}
          dateTo={rangeQuery.query.custom?.dateTo}
          branchId={branchId}
          search={reportQuery.search}
          sort={reportQuery.sort}
          direction={reportQuery.direction}
          page={reportQuery.page}
        />
      )}
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  // Deterministic, UTC-based — never Intl.DateTimeFormat(undefined, ...)/
  // toLocaleDateString() in this SSR+hydrated path.
  return iso.slice(0, 10);
}

async function BranchReportContent({
  businessId,
  from,
  to,
  rangeLabel,
  preset,
  dateFrom,
  dateTo,
  branchId,
  search,
  sort,
  direction,
  page,
}: {
  businessId: string;
  from: string;
  to: string;
  rangeLabel: string;
  preset: string;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  branchId: string | undefined;
  search: string | undefined;
  sort: BranchReportSortKey;
  direction: "asc" | "desc";
  page: number;
}) {
  const report = await getBranchDetailReport(businessId, from, to, { branchId, search, sort, direction, page });

  const currencyCode = report.currencyCode;
  const totalPages = Math.max(1, Math.ceil(report.totalCount / report.pageSize));

  const linkState: ReportTableLinkState = { preset, dateFrom, dateTo, branch: branchId, search, sort, direction };
  function sortHref(key: BranchReportSortKey) {
    return buildReportSortHref(linkState, key, sort === key && direction === "desc" ? "asc" : "desc");
  }
  function pageHref(nextPage: number) {
    return buildReportPageHref(linkState, nextPage);
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="branch-summary-heading" className="flex flex-col gap-3">
        <h2 id="branch-summary-heading" className="text-lg font-semibold tracking-tight">
          Summary
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <KpiCard testId="kpi-branch-total" label="Total branches" value={String(report.kpis.totalBranches)} icon={Building2} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
          <KpiCard testId="kpi-branch-active" label="Active in period" value={String(report.kpis.activeBranches)} icon={ShoppingBag} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
          <KpiCard testId="kpi-branch-sales" label="Completed sales" value={String(report.kpis.completedSales)} icon={ShoppingBag} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
          <KpiCard testId="kpi-branch-revenue" label="Revenue" value={formatMoney(report.kpis.revenue, currencyCode, { display: "symbol" })} icon={LineChart} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
          <KpiCard testId="kpi-branch-aov" label="Avg order value" value={formatMoney(report.kpis.averageOrderValue, currencyCode, { display: "symbol" })} icon={Gauge} tile="bg-kpi-orange-bg text-kpi-orange-fg" />
          <KpiCard testId="kpi-branch-units" label="Units sold" value={String(report.kpis.unitsSold)} icon={Boxes} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
          <KpiCard testId="kpi-branch-customers" label="Active customers" value={String(report.kpis.activeCustomers)} icon={Users2} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
          <KpiCard testId="kpi-branch-expenses" label="Expense total" value={formatMoney(report.kpis.expenseTotal, currencyCode, { display: "symbol" })} icon={Wallet} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
        </div>
      </section>

      <section aria-labelledby="branch-table-heading" className="flex flex-col gap-3">
        <h2 id="branch-table-heading" className="sr-only">
          Branch detail
        </h2>
        <Card>
          <CardHeader className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Branch detail</CardTitle>
            <form className="flex items-center gap-2" action="" method="get">
              {preset ? <input type="hidden" name="preset" value={preset} /> : null}
              {dateFrom ? <input type="hidden" name="dateFrom" value={dateFrom} /> : null}
              {dateTo ? <input type="hidden" name="dateTo" value={dateTo} /> : null}
              {branchId ? <input type="hidden" name="branch" value={branchId} /> : null}
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={direction} />
              <label htmlFor="branch-search" className="sr-only">
                Search branches by name or code
              </label>
              <Input
                id="branch-search"
                name="q"
                defaultValue={search ?? ""}
                placeholder="Search name, code…"
                maxLength={200}
                className="h-9 w-full sm:w-56"
              />
              <Button type="submit" size="sm" variant="secondary">
                Search
              </Button>
            </form>
          </CardHeader>
          <CardContent>
            {report.rows.length === 0 ? (
              <Alert>
                <AlertDescription>
                  {search
                    ? `No branches match "${search}".`
                    : "No active branches exist for this business yet."}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Branch performance, sorted by {SORT_LABEL[sort]} ({direction === "asc" ? "ascending" : "descending"})
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <SortableHeader label="Branch" sortKey="name" activeSort={sort} direction={direction} href={sortHref("name")} />
                      <SortableHeader label="Completed sales" sortKey="sales_count" activeSort={sort} direction={direction} href={sortHref("sales_count")} />
                      <SortableHeader label="Revenue" sortKey="revenue" activeSort={sort} direction={direction} href={sortHref("revenue")} />
                      <SortableHeader label="Avg order value" sortKey="average_order_value" activeSort={sort} direction={direction} href={sortHref("average_order_value")} />
                      <SortableHeader label="Active customers" sortKey="active_customers" activeSort={sort} direction={direction} href={sortHref("active_customers")} />
                      <SortableHeader label="Units sold" sortKey="units_sold" activeSort={sort} direction={direction} href={sortHref("units_sold")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Inventory movements
                      </th>
                      <SortableHeader label="Last sale (all time)" sortKey="last_sale" activeSort={sort} direction={direction} href={sortHref("last_sale")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.branchId} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-foreground">
                          <Link
                            href={buildReportPageHref({ ...linkState, branch: row.branchId }, 1)}
                            className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                          >
                            {row.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{row.completedSales}</td>
                        <td className="px-3 py-2">{formatMoney(row.revenue, currencyCode, { display: "symbol" })}</td>
                        <td className="px-3 py-2">{formatMoney(row.averageOrderValue, currencyCode, { display: "symbol" })}</td>
                        <td className="px-3 py-2">{row.activeCustomers}</td>
                        <td className="px-3 py-2">{row.unitsSold}</td>
                        <td className="px-3 py-2">{row.movementCount}</td>
                        <td className="px-3 py-2">{fmtDate(row.lastSale)}</td>
                        <td className="px-3 py-2">
                          {row.isActiveInPeriod ? (
                            <span className="rounded-full bg-kpi-emerald-bg px-2 py-0.5 text-xs font-medium text-kpi-emerald-fg">Active</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">No activity this period</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.totalCount > report.pageSize ? (
              <nav aria-label="Branch report pagination" className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {report.page} of {totalPages} ({report.totalCount} branches)
                </span>
                <div className="flex gap-2">
                  <PaginationLink href={pageHref(Math.max(1, report.page - 1))} disabled={report.page <= 1}>
                    Previous
                  </PaginationLink>
                  <PaginationLink href={pageHref(Math.min(totalPages, report.page + 1))} disabled={report.page >= totalPages}>
                    Next
                  </PaginationLink>
                </div>
              </nav>
            ) : null}
          </CardContent>
        </Card>
      </section>

      {report.selectedBranch ? (
        <section aria-labelledby="branch-selected-heading" className="flex flex-col gap-3">
          <h2 id="branch-selected-heading" className="text-lg font-semibold tracking-tight">
            {report.selectedBranch.name}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <KpiCard testId="kpi-selected-sales" label="Completed sales" value={String(report.selectedBranch.completedSales)} icon={ShoppingBag} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
            <KpiCard testId="kpi-selected-revenue" label="Revenue" value={formatMoney(report.selectedBranch.revenue, currencyCode, { display: "symbol" })} icon={LineChart} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
            <KpiCard testId="kpi-selected-aov" label="Avg order value" value={formatMoney(report.selectedBranch.averageOrderValue, currencyCode, { display: "symbol" })} icon={Gauge} tile="bg-kpi-orange-bg text-kpi-orange-fg" />
            <KpiCard testId="kpi-selected-customers" label="Active customers" value={String(report.selectedBranch.activeCustomers)} icon={Users2} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
            <KpiCard testId="kpi-selected-units" label="Units sold" value={String(report.selectedBranch.unitsSold)} icon={Boxes} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
          </div>
          <p className="text-sm text-muted-foreground">Last completed sale (all time): {fmtDate(report.selectedBranch.lastSale)}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            <BranchTrendChart points={report.selectedBranch.trend} currencyCode={currencyCode} rangeLabel={rangeLabel} />
            <TopProductsChart rows={report.selectedBranch.topProducts} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeSort,
  direction,
  href,
}: {
  label: string;
  sortKey: BranchReportSortKey;
  activeSort: BranchReportSortKey;
  direction: "asc" | "desc";
  href: string;
}) {
  const isActive = sortKey === activeSort;
  return (
    <th scope="col" className="px-3 py-2 font-medium">
      <Link
        href={href}
        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        aria-label={`Sort by ${label}${isActive ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
      >
        {label}
        <ArrowUpDown className={`size-3 ${isActive ? "text-foreground" : "text-muted-foreground/50"}`} aria-hidden="true" />
      </Link>
    </th>
  );
}

function KpiCard({
  testId,
  label,
  value,
  icon: Icon,
  tile,
}: {
  testId: string;
  label: string;
  value: string;
  icon: typeof Building2;
  tile: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <CardAction>
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tile}`}>
            <Icon className="size-4.5" aria-hidden="true" />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold tracking-tight text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}
