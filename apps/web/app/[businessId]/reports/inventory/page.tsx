import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, LineChart, ArrowUpDown, Boxes, PackageCheck, PackageMinus, PackageX, TrendingUp, Activity } from "lucide-react";
import { z } from "zod";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary } from "@/lib/reports/dal";
import { buildReportRangeSearchParams, parseReportRangeQuery } from "@/lib/reports/report-range-query";
import {
  getInventoryDetailReport,
  parseInventoryReportQuery,
  type InventoryReportSortKey,
  type StockStatus,
} from "@/lib/reports/inventory-report";
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
import { TopProductsChart } from "@/components/reports/top-products-chart";

const BranchParamSchema = z.uuid();

const SORT_LABEL: Record<InventoryReportSortKey, string> = {
  units_sold: "Units sold",
  quantity: "Quantity",
  movements: "Movements",
  name: "Name",
};

const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};
const STOCK_STATUS_TILE: Record<StockStatus, string> = {
  in_stock: "bg-kpi-emerald-bg text-kpi-emerald-fg",
  low_stock: "bg-kpi-orange-bg text-kpi-orange-fg",
  out_of_stock: "bg-destructive/10 text-destructive",
};

// Phase 1N-C3 — Inventory Detailed Report. Server-gated by reports.view
// ALONE, the same convention every other /reports route uses — never
// inventory.view, never products.view. All data comes from
// get_inventory_detail_report (via getInventoryDetailReport), which
// independently re-checks reports.view server-side. No raw products/
// inventory_balances/inventory_ledger table is ever queried from this
// route. No inventory valuation (cost * quantity) is computed or shown —
// deferred per the approved plan.
export default async function InventoryReportPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/reports/inventory">) {
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

  const reportQuery = parseInventoryReportQuery({
    search: typeof query.q === "string" ? query.q : undefined,
    sort: typeof query.sort === "string" ? query.sort : undefined,
    direction: typeof query.dir === "string" ? query.dir : undefined,
    page: typeof query.page === "string" ? query.page : undefined,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <PageHeader
          title="Inventory"
          description={`Stock position and movement${rangeQuery.status === "ok" ? ` for ${rangeQuery.query.label}` : ""}.`}
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
        <InventoryReportContent
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
  return iso.slice(0, 10);
}

async function InventoryReportContent({
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
  sort: InventoryReportSortKey;
  direction: "asc" | "desc";
  page: number;
}) {
  // Called only for its currency_code field — mirrors sales/page.tsx's own
  // dual-call precedent; get_inventory_detail_report has no currency-bearing
  // field of its own to derive it from independently.
  const [summary, report, topReport] = await Promise.all([
    getFinancialSummary(businessId, from, to, branchId),
    getInventoryDetailReport(businessId, from, to, { branchId, search, sort, direction, page }),
    getInventoryDetailReport(businessId, from, to, { branchId, sort: "units_sold", direction: "desc", page: 1 }),
  ]);
  void summary;

  const totalPages = Math.max(1, Math.ceil(report.totalCount / report.pageSize));

  const linkState: ReportTableLinkState = { preset, dateFrom, dateTo, branch: branchId, search, sort, direction };
  function sortHref(key: InventoryReportSortKey) {
    return buildReportSortHref(linkState, key, sort === key && direction === "desc" ? "asc" : "desc");
  }
  function pageHref(nextPage: number) {
    return buildReportPageHref(linkState, nextPage);
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="inventory-summary-heading" className="flex flex-col gap-3">
        <h2 id="inventory-summary-heading" className="text-lg font-semibold tracking-tight">
          Summary
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard testId="kpi-inventory-total" label="Total products" value={String(report.kpis.totalProducts)} icon={Boxes} tile="bg-kpi-blue-bg text-kpi-blue-fg" />
          <KpiCard testId="kpi-inventory-in-stock" label="In stock" value={String(report.kpis.inStock)} icon={PackageCheck} tile="bg-kpi-emerald-bg text-kpi-emerald-fg" />
          <KpiCard testId="kpi-inventory-low-stock" label="Low stock" value={String(report.kpis.lowStock)} icon={PackageMinus} tile="bg-kpi-orange-bg text-kpi-orange-fg" />
          <KpiCard testId="kpi-inventory-out-of-stock" label="Out of stock" value={String(report.kpis.outOfStock)} icon={PackageX} tile="bg-destructive/10 text-destructive" />
          <KpiCard testId="kpi-inventory-units-sold" label="Units sold" value={String(report.kpis.unitsSold)} icon={TrendingUp} tile="bg-kpi-purple-bg text-kpi-purple-fg" />
          <KpiCard testId="kpi-inventory-movements" label="Movements" value={String(report.kpis.movements)} icon={Activity} tile="bg-kpi-cyan-bg text-kpi-cyan-fg" />
        </div>
      </section>

      <section aria-labelledby="inventory-chart-heading" className="flex flex-col gap-3">
        <h2 id="inventory-chart-heading" className="sr-only">
          Top products
        </h2>
        <TopProductsChart rows={topReport.rows} />
      </section>

      <section aria-labelledby="inventory-table-heading" className="flex flex-col gap-3">
        <h2 id="inventory-table-heading" className="sr-only">
          Inventory detail
        </h2>
        <Card>
          <CardHeader className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Inventory detail</CardTitle>
            <form className="flex items-center gap-2" action="" method="get">
              {preset ? <input type="hidden" name="preset" value={preset} /> : null}
              {dateFrom ? <input type="hidden" name="dateFrom" value={dateFrom} /> : null}
              {dateTo ? <input type="hidden" name="dateTo" value={dateTo} /> : null}
              {branchId ? <input type="hidden" name="branch" value={branchId} /> : null}
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={direction} />
              <label htmlFor="inventory-search" className="sr-only">
                Search products by name or SKU
              </label>
              <Input
                id="inventory-search"
                name="q"
                defaultValue={search ?? ""}
                placeholder="Search name, SKU…"
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
                    ? `No products match "${search}" in this range.`
                    : branchId
                      ? "No tracked products with stock at this branch."
                      : "No tracked products found."}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Inventory position, sorted by {SORT_LABEL[sort]} ({direction === "asc" ? "ascending" : "descending"})
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <SortableHeader label="Product" sortKey="name" activeSort={sort} direction={direction} href={sortHref("name")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        SKU
                      </th>
                      <SortableHeader label="Quantity" sortKey="quantity" activeSort={sort} direction={direction} href={sortHref("quantity")} />
                      <SortableHeader label="Units sold" sortKey="units_sold" activeSort={sort} direction={direction} href={sortHref("units_sold")} />
                      <SortableHeader label="Movements" sortKey="movements" activeSort={sort} direction={direction} href={sortHref("movements")} />
                      <th scope="col" className="px-3 py-2 font-medium">
                        Last movement
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Stock status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.productId} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-foreground">{row.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.sku ?? "—"}</td>
                        <td className="px-3 py-2">{row.currentQuantity}</td>
                        <td className="px-3 py-2">{row.unitsSold}</td>
                        <td className="px-3 py-2">{row.movementCount}</td>
                        <td className="px-3 py-2">{fmtDate(row.lastMovement)}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STOCK_STATUS_TILE[row.stockStatus]}`}>
                            {STOCK_STATUS_LABEL[row.stockStatus]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.totalCount > report.pageSize ? (
              <nav aria-label="Inventory report pagination" className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {report.page} of {totalPages} ({report.totalCount} products)
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
  sortKey: InventoryReportSortKey;
  activeSort: InventoryReportSortKey;
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
  icon: typeof Boxes;
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
