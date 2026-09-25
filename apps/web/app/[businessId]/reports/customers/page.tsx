import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, LineChart, ArrowUpDown } from "lucide-react";
import { z } from "zod";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary } from "@/lib/reports/dal";
import { buildReportRangeSearchParams, parseReportRangeQuery } from "@/lib/reports/report-range-query";
import {
  getCustomerDetailReport,
  parseCustomerReportQuery,
  type CustomerReportSortKey,
} from "@/lib/reports/customer-report";
import { listReportBranchOptions } from "@/lib/branches/dal";
import { buildReportSortHref, buildReportPageHref, type ReportTableLinkState } from "@/lib/reports/report-table-links";
import { DateRangePicker } from "@/components/reports/date-range-picker";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
import { PageHeader } from "@/components/dashboard/page-header";
import { formatMoney } from "@/lib/currency";
import { TopCustomersChart } from "@/components/reports/top-customers-chart";
import { Users, ShoppingBag, UserPlus, Repeat, Gauge } from "lucide-react";

const BranchParamSchema = z.uuid();

const SORT_LABEL: Record<CustomerReportSortKey, string> = {
  revenue: "Revenue",
  orders: "Orders",
  last_purchase: "Last purchase",
  name: "Name",
};

// Phase 1N-C3 — Customer Detailed Report. Server-gated by reports.view
// ALONE (requirePermissionOrNotFound), the same convention every other
// /reports route uses — never customers.view, never sales.view. All data
// comes from get_customer_detail_report (via getCustomerDetailReport),
// which independently re-checks reports.view server-side (defense in
// depth). No raw customers/sales/sale_items table is ever queried from
// this route.
export default async function CustomerReportPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/reports/customers">) {
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

  const reportQuery = parseCustomerReportQuery({
    search: typeof query.q === "string" ? query.q : undefined,
    sort: typeof query.sort === "string" ? query.sort : undefined,
    direction: typeof query.dir === "string" ? query.dir : undefined,
    page: typeof query.page === "string" ? query.page : undefined,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <PageHeader
          title="Customers"
          description={`Customer performance${rangeQuery.status === "ok" ? ` for ${rangeQuery.query.label}` : ""}.`}
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
        <CustomerReportContent
          businessId={businessId}
          from={rangeQuery.query.range.from}
          to={rangeQuery.query.range.to}
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
  // toLocaleDateString() in this SSR+hydrated path (see this phase's own
  // "no repeated hydration mistakes" note).
  return iso.slice(0, 10);
}

async function CustomerReportContent({
  businessId,
  from,
  to,
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
  preset: string;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  branchId: string | undefined;
  search: string | undefined;
  sort: CustomerReportSortKey;
  direction: "asc" | "desc";
  page: number;
}) {
  // topReport is a SEPARATE, fixed revenue-desc/page-1 fetch — the chart
  // must always show the true top 5 by revenue regardless of the table's
  // own current sort/page/search, and React's cache() dedupes this
  // against `report` below for free when sort/search/page already match.
  const [summary, report, topReport] = await Promise.all([
    getFinancialSummary(businessId, from, to, branchId),
    getCustomerDetailReport(businessId, from, to, { branchId, search, sort, direction, page }),
    getCustomerDetailReport(businessId, from, to, { branchId, sort: "revenue", direction: "desc", page: 1 }),
  ]);

  const currencyCode = summary.currencyCode;
  const totalPages = Math.max(1, Math.ceil(report.totalCount / report.pageSize));

  // Canonical query state every sort/page link (and the search form's
  // hidden fields below) is built from — see
  // lib/reports/report-table-links.ts's own header comment for why this
  // must never be hand-rolled per link.
  const linkState: ReportTableLinkState = { preset, dateFrom, dateTo, branch: branchId, search, sort, direction };
  function sortHref(key: CustomerReportSortKey) {
    return buildReportSortHref(linkState, key, sort === key && direction === "desc" ? "asc" : "desc");
  }
  function pageHref(nextPage: number) {
    return buildReportPageHref(linkState, nextPage);
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="customer-summary-heading" className="flex flex-col gap-3">
        <h2 id="customer-summary-heading" className="text-lg font-semibold tracking-tight">
          Summary
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard testId="kpi-customer-total" label="Total customers" value={String(report.kpis.totalCustomers)} icon={Users} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
          <KpiCard testId="kpi-customer-active" label="Active in period" value={String(report.kpis.activeCustomers)} icon={ShoppingBag} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
          <KpiCard testId="kpi-customer-new" label="New" value={String(report.kpis.newCustomers)} icon={UserPlus} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
          <KpiCard testId="kpi-customer-returning" label="Returning" value={String(report.kpis.returningCustomers)} icon={Repeat} tile="bg-kpi-orange-bg text-kpi-orange-fg" />
          <KpiCard testId="kpi-customer-revenue" label="Revenue" value={formatMoney(report.kpis.revenue, currencyCode, { display: "symbol" })} icon={LineChart} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
          <KpiCard
            testId="kpi-customer-avg-revenue"
            label="Avg revenue / active customer"
            value={formatMoney(report.kpis.averageRevenuePerActiveCustomer, currencyCode, { display: "symbol" })}
            icon={Gauge}
            tile="bg-kpi-blue-bg text-kpi-blue-fg"
          />
        </div>
      </section>

      <section aria-labelledby="customer-chart-heading" className="flex flex-col gap-3">
        <h2 id="customer-chart-heading" className="sr-only">
          Top customers
        </h2>
        <TopCustomersChart rows={topReport.rows} currencyCode={currencyCode} />
      </section>

      <section aria-labelledby="customer-table-heading" className="flex flex-col gap-3">
        <h2 id="customer-table-heading" className="sr-only">
          Customer detail
        </h2>
        <Card>
          <CardHeader className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Customer detail</CardTitle>
            <form className="flex items-center gap-2" action="" method="get">
              {/* Preserve the active period/branch/sort — only `q` changes
                  and `page` is intentionally omitted so a new search
                  starts back at page 1. See lib/reports/report-table-links.ts. */}
              {preset ? <input type="hidden" name="preset" value={preset} /> : null}
              {dateFrom ? <input type="hidden" name="dateFrom" value={dateFrom} /> : null}
              {dateTo ? <input type="hidden" name="dateTo" value={dateTo} /> : null}
              {branchId ? <input type="hidden" name="branch" value={branchId} /> : null}
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={direction} />
              <label htmlFor="customer-search" className="sr-only">
                Search customers by name, phone, or email
              </label>
              <Input
                id="customer-search"
                name="q"
                defaultValue={search ?? ""}
                placeholder="Search name, phone, email…"
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
                    ? `No customers with activity in this period match "${search}".`
                    : branchId
                      ? "No customers made completed purchases at this branch in this period."
                      : "No customer activity in this period."}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Customer performance, sorted by {SORT_LABEL[sort]} ({direction === "asc" ? "ascending" : "descending"})
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <SortableHeader label="Customer" sortKey="name" activeSort={sort} direction={direction} href={sortHref("name")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Contact
                      </th>
                      <SortableHeader label="Orders" sortKey="orders" activeSort={sort} direction={direction} href={sortHref("orders")} />
                      <SortableHeader label="Revenue" sortKey="revenue" activeSort={sort} direction={direction} href={sortHref("revenue")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Avg order value
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        First purchase
                      </th>
                      <SortableHeader label="Last purchase" sortKey="last_purchase" activeSort={sort} direction={direction} href={sortHref("last_purchase")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.customerId} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-foreground">{row.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.phone ?? row.email ?? "—"}</td>
                        <td className="px-3 py-2">{row.totalOrders}</td>
                        <td className="px-3 py-2">{formatMoney(row.revenue, currencyCode, { display: "symbol" })}</td>
                        <td className="px-3 py-2">{formatMoney(row.averageOrderValue, currencyCode, { display: "symbol" })}</td>
                        <td className="px-3 py-2">{fmtDate(row.firstPurchase)}</td>
                        <td className="px-3 py-2">{fmtDate(row.lastPurchase)}</td>
                        <td className="px-3 py-2">
                          {row.isNew ? (
                            <span className="rounded-full bg-kpi-purple-bg px-2 py-0.5 text-xs font-medium text-kpi-purple-fg">New</span>
                          ) : row.isReturning ? (
                            <span className="rounded-full bg-kpi-orange-bg px-2 py-0.5 text-xs font-medium text-kpi-orange-fg">Returning</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.totalCount > report.pageSize ? (
              <nav aria-label="Customer report pagination" className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {report.page} of {totalPages} ({report.totalCount} customers)
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
  sortKey: CustomerReportSortKey;
  activeSort: CustomerReportSortKey;
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
  icon: typeof Users;
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
