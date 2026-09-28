import { z } from "zod";
import type { NextRequest } from "next/server";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseReportRangeQuery } from "@/lib/reports/report-range-query";
import { getBranchDetailReport, parseBranchReportQuery, type BranchReportRow } from "@/lib/reports/branch-report";
import { listReportBranchOptions } from "@/lib/branches/dal";
import {
  collectAllReportRows,
  csvResponse,
  jsonErrorResponse,
  serializeCsv,
  safeCsvFilename,
  isoDateOnly,
  inclusiveEndDateOnly,
  ReportExportTooLargeError,
  REPORT_EXPORT_FETCH_PAGE_SIZE,
  type CsvColumn,
} from "@/lib/reports/csv";
import { mapDatabaseError } from "@/lib/errors";

export const runtime = "nodejs";

const BranchParamSchema = z.uuid();

// Phase 1N-C5 — Branch report CSV export. Same architecture as the
// Customers/Inventory export routes. Note: unlike those two reports,
// get_branch_detail_report's own `branch` parameter is a single-branch
// DRILLDOWN selector, not a row filter — the comparison table it returns
// always lists every ACTIVE branch regardless of p_branch_id (see that
// RPC's own tmp_branch_report query, which has no branch_id predicate).
// A `branch` query param is still validated here (same-business,
// rejected if foreign/unknown) for defense in depth and to keep this
// route's behavior predictable, even though it never narrows the
// exported row set.
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

    let branchId: string | undefined;
    const rawBranchParam = search.get("branch") ?? undefined;
    if (rawBranchParam) {
      const parsedBranch = BranchParamSchema.safeParse(rawBranchParam);
      if (!parsedBranch.success) return jsonErrorResponse(400, "Invalid branch selection.");
      const allBranches = await listReportBranchOptions(businessId);
      const match = allBranches.find((b) => b.id === parsedBranch.data);
      if (!match) return jsonErrorResponse(400, "Invalid branch selection.");
      branchId = match.id;
    }

    const reportQuery = parseBranchReportQuery({
      search: search.get("q") ?? undefined,
      sort: search.get("sort") ?? undefined,
      direction: search.get("dir") ?? undefined,
    });

    let currencyCode = "";
    const rows = await collectAllReportRows(async (page) => {
      const result = await getBranchDetailReport(businessId, rangeQuery.query.range.from, rangeQuery.query.range.to, {
        branchId,
        search: reportQuery.search,
        sort: reportQuery.sort,
        direction: reportQuery.direction,
        page,
        pageSize: REPORT_EXPORT_FETCH_PAGE_SIZE,
      });
      currencyCode = result.currencyCode;
      return { rows: result.rows, totalCount: result.totalCount, pageSize: result.pageSize };
    });

    const columns: CsvColumn<BranchReportRow>[] = [
      { header: "Branch", value: (r) => r.name, userText: true },
      { header: "Code", value: (r) => r.code ?? "", userText: true },
      { header: "Completed Sales", value: (r) => r.completedSales },
      { header: "Revenue", value: (r) => r.revenue },
      { header: "Average Order Value", value: (r) => r.averageOrderValue },
      { header: "Active Customers", value: (r) => r.activeCustomers },
      { header: "Units Sold", value: (r) => r.unitsSold },
      { header: "Inventory Movements", value: (r) => r.movementCount },
      { header: "Expense Total", value: (r) => r.expenseTotal },
      { header: "Last Sale (All Time)", value: (r) => (r.lastSale ? isoDateOnly(r.lastSale) : "") },
      { header: "Status", value: (r) => (r.isActiveInPeriod ? "Active" : "No activity this period") },
      { header: "Currency", value: () => currencyCode },
    ];

    const csv = serializeCsv(columns, rows);
    const filename = safeCsvFilename([
      "businessos",
      "branches",
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
    console.error("[reports/branches/export]", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? mapDatabaseError({ message: error.message }).message : "Something went wrong. Please try again.";
    return jsonErrorResponse(500, message);
  }
}
