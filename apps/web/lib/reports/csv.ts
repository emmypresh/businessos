import "server-only";

// Phase 1N-C5 — CSV export foundation. A small, dependency-free CSV
// serializer shared by every report export route, so escaping/formula
// neutralization/filename/response-header logic lives in exactly one
// place rather than being hand-rolled per report.

/** Server-side ceiling on exported rows. Explicit, centralized, tested. */
export const REPORT_EXPORT_ROW_LIMIT = 10_000;

/**
 * Page size used when an export route pages through an existing detail
 * RPC to assemble the full (bounded) row set. Matches the hard [1,100]
 * clamp every detail RPC already applies server-side (see e.g.
 * supabase/migrations/20260926080200_get_branch_detail_report_rpc.sql),
 * so this is never a value the RPC would itself reject or silently
 * shrink further.
 */
export const REPORT_EXPORT_FETCH_PAGE_SIZE = 100;

/**
 * Thrown whenever an export cannot be proven safe/complete within
 * REPORT_EXPORT_ROW_LIMIT — either because the declared row count itself
 * exceeds the limit, or because collectAllReportRows could not safely
 * page through to a complete result within its fixed page-count ceiling
 * (an inconsistent/malformed upstream totalCount+pageSize pair, or a
 * paging run that came back short of the declared total). Callers map
 * this to a single controlled 4xx response — never a partial CSV. The
 * user-facing message is deliberately the same generic, filter-narrowing
 * guidance in every case; no internal RPC/paging detail is ever exposed.
 */
export class ReportExportTooLargeError extends Error {
  readonly totalCount: number;
  constructor(totalCount: number) {
    super(
      `Export cannot be completed safely (${totalCount} rows, limit ${REPORT_EXPORT_ROW_LIMIT}). Narrow the date range or filters and try again.`
    );
    this.name = "ReportExportTooLargeError";
    this.totalCount = totalCount;
  }
}

const CSV_SPECIAL_CHARS = /[",\r\n]/;

/**
 * RFC 4180 field escaping: wraps in double quotes and doubles any
 * embedded double quote whenever the field contains a comma, quote, or
 * newline (CR and/or LF). Fields with none of those pass through
 * unquoted, matching common CSV consumer expectations.
 */
export function escapeCsvCell(raw: string): string {
  if (!CSV_SPECIAL_CHARS.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

const DANGEROUS_CONTROL_PREFIX = /^[\t\r]/;
const LEADING_WHITESPACE_OR_CONTROL = /^[ \t\v\f ]+/;
const DANGEROUS_LEADING_CHAR = /^[=+\-@]/;

/**
 * Spreadsheet-formula-injection neutralization: a value that would be
 * interpreted as a formula by Excel/Sheets/LibreOffice when it starts
 * with =, +, -, or @ — including after leading spaces/tabs/vertical-tabs/
 * form-feeds/NBSP that some spreadsheet CSV importers skip over before
 * looking for a formula marker — is prefixed with a single quote so it
 * opens as inert text. A leading tab or carriage-return control
 * character is itself always neutralized (both are already
 * formula-adjacent risk characters independent of what follows). Only
 * the leading whitespace run is inspected to decide whether to
 * neutralize; the original raw value (whitespace included) is what
 * actually gets the quote prefix, so legitimate leading-space text is
 * never otherwise altered. Only ever applied to string/user-controlled
 * text fields — callers must not run this over already-numeric values,
 * so a genuine negative number (e.g. -123.45) formatted as a number is
 * never passed through this function.
 */
export function sanitizeSpreadsheetCell(raw: string): string {
  if (raw === "") return raw;
  if (DANGEROUS_CONTROL_PREFIX.test(raw)) return `'${raw}`;
  const stripped = raw.replace(LEADING_WHITESPACE_OR_CONTROL, "");
  return DANGEROUS_LEADING_CHAR.test(stripped) ? `'${raw}` : raw;
}

export type CsvCellValue = string | number | boolean | null | undefined;

export type CsvColumn<Row> = {
  header: string;
  /** Extracts this column's raw value from a row. */
  value: (row: Row) => CsvCellValue;
  /** True for free-text, user-controlled fields (names, codes, search-affected text) that must go through sanitizeSpreadsheetCell. Numbers/booleans/ISO dates/currency codes should leave this unset. */
  userText?: boolean;
};

function formatCell(value: CsvCellValue, userText: boolean): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? String(value) : typeof value === "number" ? String(value) : value;
  const sanitized = userText ? sanitizeSpreadsheetCell(text) : text;
  return escapeCsvCell(sanitized);
}

/**
 * Serializes rows into a complete CSV document: header row, then one row
 * per input row, CRLF line endings throughout (the RFC 4180 default,
 * broadly compatible with Excel/Sheets/LibreOffice). No trailing blank
 * line.
 */
export function serializeCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvCell(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => formatCell(c.value(row), c.userText === true)).join(","));
  }
  return lines.join("\r\n");
}

const FILENAME_UNSAFE = /[^A-Za-z0-9-]+/g;

function sanitizeFilenamePart(part: string): string {
  return part.replace(FILENAME_UNSAFE, "-");
}

/**
 * Builds a deterministic, injection-safe filename from fixed, already-
 * controlled parts (report name literal + ISO date-only strings) —
 * never raw business/user-controlled text. Every part is defensively
 * re-sanitized anyway so a future caller can't accidentally introduce
 * unsafe characters (including CR/LF, which would otherwise let a
 * crafted part inject extra response headers via Content-Disposition).
 */
export function safeCsvFilename(parts: string[]): string {
  const safeParts = parts.map(sanitizeFilenamePart).filter((p) => p.length > 0);
  return `${safeParts.join("-")}.csv`;
}

/**
 * Builds the full Response for a CSV export: correct content type,
 * attachment disposition with a pre-sanitized filename, and private,
 * no-store caching (the payload may contain customer/business-sensitive
 * data and must never be shared/public-cached).
 */
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function jsonErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Pages through an existing paginated report DAL function (never a raw
 * query) to assemble the full set of rows matching the caller's already-
 * validated filters, bounded by REPORT_EXPORT_ROW_LIMIT. Fails fast — a
 * single first-page fetch reveals totalCount, and an over-limit result
 * throws ReportExportTooLargeError before any further pages are
 * fetched — never a partial CSV. Deterministic and duplicate/missing-row
 * safe only because every underlying detail RPC orders by an allowlisted
 * column plus a stable id tiebreaker (see each RPC's own `order by %I
 * %s nulls last, <id> asc`).
 */
export async function collectAllReportRows<Row>(
  fetchPage: (page: number) => Promise<{ rows: Row[]; totalCount: number; pageSize: number }>
): Promise<Row[]> {
  const first = await fetchPage(1);
  if (first.totalCount > REPORT_EXPORT_ROW_LIMIT) {
    throw new ReportExportTooLargeError(first.totalCount);
  }

  const rows: Row[] = [...first.rows];
  // Guards against a runtime pageSize of 0, negative, NaN, or Infinity —
  // none of which the DAL's own typing should ever produce, but paging
  // math below must never divide by (or ceil against) an unsafe value.
  const pageSize = Number.isFinite(first.pageSize) && first.pageSize > 0 ? first.pageSize : REPORT_EXPORT_FETCH_PAGE_SIZE;

  // Fixed, fail-closed ceiling: the maximum number of pages this export
  // path will ever fetch, independent of what any single RPC call
  // reports. REPORT_EXPORT_ROW_LIMIT/REPORT_EXPORT_FETCH_PAGE_SIZE = 100
  // pages — exactly enough to reach the row limit at the page size every
  // export route actually requests, and never more.
  const maxPages = Math.ceil(REPORT_EXPORT_ROW_LIMIT / REPORT_EXPORT_FETCH_PAGE_SIZE);
  const requiredPages = Math.max(1, Math.ceil(first.totalCount / pageSize));

  // Fail closed rather than silently truncate: if satisfying the
  // declared totalCount at the declared pageSize would take more pages
  // than this export path can safely fetch, completeness can't be
  // proven — never return a partial CSV presented as a full one. An
  // honest totalCount/pageSize pair within REPORT_EXPORT_ROW_LIMIT can
  // never trigger this (requiredPages tops out at exactly maxPages for
  // 10,000 rows at the standard 100-row page size).
  if (requiredPages > maxPages) {
    throw new ReportExportTooLargeError(first.totalCount);
  }

  for (let page = 2; page <= requiredPages; page += 1) {
    const next = await fetchPage(page);
    rows.push(...next.rows);
  }

  // Final completeness check, independent of the page-count math above:
  // even a page count that looked safe can still under-deliver rows (an
  // upstream page returned short/empty before the declared total was
  // reached, or totalCount itself was unreliable). Never present a
  // shorter-than-declared row set as a complete export.
  if (rows.length < first.totalCount) {
    throw new ReportExportTooLargeError(first.totalCount);
  }

  return rows;
}

/** Plain UTC calendar-day slice of an ISO timestamp, e.g. "2026-09-15T00:00:00Z" -> "2026-09-15". Never environment-local formatting. */
export function isoDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Inclusive display end date for a half-open [from, to) range, matching formatReportRangeLabel's own "to minus one millisecond" convention. */
export function inclusiveEndDateOnly(toExclusiveIso: string): string {
  return isoDateOnly(new Date(new Date(toExclusiveIso).getTime() - 1).toISOString());
}
