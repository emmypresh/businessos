import { z } from "zod";
import type { NextRequest } from "next/server";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseReportRangeQuery } from "@/lib/reports/report-range-query";
import { getFinancialSummary, getManagementReportingAggregate } from "@/lib/reports/dal";
import { buildSalesTrendChartModel, type SalesTrendChartPoint } from "@/lib/reports/sales-trend-chart";
import {
  csvResponse,
  jsonErrorResponse,
  serializeCsv,
  safeCsvFilename,
  isoDateOnly,
  inclusiveEndDateOnly,
  REPORT_EXPORT_ROW_LIMIT,
  ReportExportTooLargeError,
  type CsvColumn,
} from "@/lib/reports/csv";
import { mapDatabaseError } from "@/lib/errors";

export const runtime = "nodejs";

// Phase 1N-C5 — Sales & Revenue report CSV export.
//
// Architecture note (deliberate deviation from a naive "export the sales
// list" reading): the frozen C2 Sales & Revenue report has no row-level,
// paginated, sortable, or branch-filterable data source at all — it
// renders exclusively from get_management_reporting_aggregate's own
// UTC-day-bucketed sales_trend (see lib/reports/dal.ts and this file's
// sibling page.tsx header comment: "Branch filtering is deliberately
// OMITTED... no branch-safe way to scope [the aggregate] to a single
// branch"). There is no per-sale-transaction RPC anywhere in this
// codebase to reuse, and C5's own architectural rule is to reuse
// existing report RPC/data-layer primitives rather than invent new
// business logic or a new migration for an export-only concern (see the
// approved C5 plan's "Architectural rule" and "Migration policy"
// sections). Exporting a new per-sale RPC's transaction-level columns
// (sale number, customer, branch, status, subtotal, discount) would
// require adding exactly that new query surface this phase's own
// migration policy discourages absent a real need — so this export
// instead reuses the exact same daily rows the screen already shows:
// one row per UTC calendar day in the selected period, zero-activity
// days included (matching buildSalesTrendChartModel's own documented
// behavior), which is at most MAX_REPORT_RANGE_DAYS (366) rows — always
// far under REPORT_EXPORT_ROW_LIMIT, so no pagination/looping is needed
// here at all.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
): Promise<Response> {
  const { businessId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.REPORTS_VIEW);

  try {
    const search = request.nextUrl.searchParams;

    const rangeQuery = parseReportRangeQuery({
      preset: search.get("preset") ?? undefined,
      dateFrom: search.get("dateFrom") ?? undefined,
      dateTo: search.get("dateTo") ?? undefined,
    });
    if (rangeQuery.status === "error") {
      return jsonErrorResponse(400, rangeQuery.message);
    }
    if (rangeQuery.status === "pending") {
      return jsonErrorResponse(400, "Choose a start and end date to export.");
    }

    const [summary, reporting] = await Promise.all([
      getFinancialSummary(businessId, rangeQuery.query.range.from, rangeQuery.query.range.to),
      getManagementReportingAggregate(businessId, rangeQuery.query.range.from, rangeQuery.query.range.to),
    ]);

    const chartModel = buildSalesTrendChartModel(reporting.salesTrend);

    // Defensive, not load-bearing today (MAX_REPORT_RANGE_DAYS already
    // caps this at 366 rows) — kept so a future range-cap change can
    // never silently produce an unbounded export.
    if (chartModel.points.length > REPORT_EXPORT_ROW_LIMIT) {
      throw new ReportExportTooLargeError(chartModel.points.length);
    }

    const currencyCode = summary.currencyCode;
    const columns: CsvColumn<SalesTrendChartPoint>[] = [
      { header: "Date", value: (p) => p.date },
      { header: "Revenue", value: (p) => p.revenue },
      { header: "Sales Count", value: (p) => p.salesCount },
      { header: "Average Order Value", value: (p) => p.averageOrderValue },
      { header: "Currency", value: () => currencyCode },
    ];

    const csv = serializeCsv(columns, chartModel.points);
    const filename = safeCsvFilename([
      "businessos",
      "sales",
      isoDateOnly(rangeQuery.query.range.from),
      "to",
      inclusiveEndDateOnly(rangeQuery.query.range.to),
    ]);
    return csvResponse(csv, filename);
  } catch (error) {
    if (error instanceof ReportExportTooLargeError) {
      return jsonErrorResponse(413, error.message);
    }
    if (error instanceof z.ZodError) {
      return jsonErrorResponse(400, "Invalid report filters.");
    }
    console.error("[reports/sales/export]", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? mapDatabaseError({ message: error.message }).message : "Something went wrong. Please try again.";
    return jsonErrorResponse(500, message);
  }
}
