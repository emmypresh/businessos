import { z } from "zod";
import type { NextRequest } from "next/server";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseReportRangeQuery } from "@/lib/reports/report-range-query";
import { getCustomerDetailReport, parseCustomerReportQuery, type CustomerReportRow } from "@/lib/reports/customer-report";
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

// Phase 1N-C5 — Customer report CSV export. Node runtime (no Edge-only
// need, matches the app's other authenticated server work).
export const runtime = "nodejs";

const BranchParamSchema = z.uuid();

// Phase 1N-C5. Authenticated GET file download: reports.view enforced
// independently of the screen (requirePermissionOrNotFound — the exact
// same helper /reports/customers's own page uses, so direct URL access
// gets the identical fail-closed 404 a foreign/unauthorized business ID
// already gets on the page). All row data comes from
// getCustomerDetailReport (the frozen C3 DAL/RPC) — never a raw query —
// paged up to REPORT_EXPORT_ROW_LIMIT via collectAllReportRows.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
): Promise<Response> {
  const { businessId } = await params;

  // Outside the try/catch below: notFound() throws a Next.js control-flow
  // signal that must propagate unchanged, never be caught and turned into
  // a generic 500.
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

    // Branch narrowing: unlike the screen (which silently ignores an
    // unmatched branch id), a direct export request rejects a foreign/
    // invalid branch outright — export must never silently broaden to
    // "all branches" when the caller asked for one specific branch.
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

    const reportQuery = parseCustomerReportQuery({
      search: search.get("q") ?? undefined,
      sort: search.get("sort") ?? undefined,
      direction: search.get("dir") ?? undefined,
    });

    let currencyCode = "";
    const rows = await collectAllReportRows(async (page) => {
      const result = await getCustomerDetailReport(businessId, rangeQuery.query.range.from, rangeQuery.query.range.to, {
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

    // Deliberately no auth user ID, raw metadata, tokens, or
    // password-related fields — only the same customer contact fields
    // the frozen C3 screen already shows.
    const columns: CsvColumn<CustomerReportRow>[] = [
      { header: "Customer Name", value: (r) => r.name, userText: true },
      { header: "Phone", value: (r) => r.phone ?? "", userText: true },
      { header: "Email", value: (r) => r.email ?? "", userText: true },
      { header: "Completed Orders", value: (r) => r.totalOrders },
      { header: "Revenue", value: (r) => r.revenue },
      { header: "Average Order Value", value: (r) => r.averageOrderValue },
      { header: "First Purchase", value: (r) => (r.firstPurchase ? isoDateOnly(r.firstPurchase) : "") },
      { header: "Last Purchase", value: (r) => (r.lastPurchase ? isoDateOnly(r.lastPurchase) : "") },
      { header: "New Customer", value: (r) => (r.isNew ? "Yes" : "No") },
      { header: "Returning Customer", value: (r) => (r.isReturning ? "Yes" : "No") },
      { header: "Currency", value: () => currencyCode },
    ];

    const csv = serializeCsv(columns, rows);
    const filename = safeCsvFilename([
      "businessos",
      "customers",
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
    console.error("[reports/customers/export]", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? mapDatabaseError({ message: error.message }).message : "Something went wrong. Please try again.";
    return jsonErrorResponse(500, message);
  }
}
