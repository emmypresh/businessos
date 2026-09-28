import { z } from "zod";
import type { NextRequest } from "next/server";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseReportRangeQuery } from "@/lib/reports/report-range-query";
import {
  getInventoryDetailReport,
  parseInventoryReportQuery,
  type InventoryReportRow,
  type StockStatus,
} from "@/lib/reports/inventory-report";
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

const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

// Phase 1N-C5 — Inventory report CSV export. Same architecture as the
// Customers export route (see its own header comment): reports.view
// enforced independently via requirePermissionOrNotFound, rows sourced
// from the frozen C3 getInventoryDetailReport DAL/RPC only, no
// inventory valuation column (the approved plan explicitly excludes
// cost * quantity, and the underlying report never computes it), no
// currency column (this report has no money field to attach one to).
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

    const reportQuery = parseInventoryReportQuery({
      search: search.get("q") ?? undefined,
      sort: search.get("sort") ?? undefined,
      direction: search.get("dir") ?? undefined,
    });

    const rows = await collectAllReportRows(async (page) => {
      const result = await getInventoryDetailReport(businessId, rangeQuery.query.range.from, rangeQuery.query.range.to, {
        branchId,
        search: reportQuery.search,
        sort: reportQuery.sort,
        direction: reportQuery.direction,
        page,
        pageSize: REPORT_EXPORT_FETCH_PAGE_SIZE,
      });
      return { rows: result.rows, totalCount: result.totalCount, pageSize: result.pageSize };
    });

    const columns: CsvColumn<InventoryReportRow>[] = [
      { header: "Product", value: (r) => r.name, userText: true },
      { header: "SKU", value: (r) => r.sku ?? "", userText: true },
      { header: "Current Quantity", value: (r) => r.currentQuantity },
      { header: "Units Sold", value: (r) => r.unitsSold },
      { header: "Movement Count", value: (r) => r.movementCount },
      { header: "Last Movement", value: (r) => (r.lastMovement ? isoDateOnly(r.lastMovement) : "") },
      { header: "Stock Status", value: (r) => STOCK_STATUS_LABEL[r.stockStatus] },
    ];

    const csv = serializeCsv(columns, rows);
    const filename = safeCsvFilename([
      "businessos",
      "inventory",
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
    console.error("[reports/inventory/export]", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? mapDatabaseError({ message: error.message }).message : "Something went wrong. Please try again.";
    return jsonErrorResponse(500, message);
  }
}
