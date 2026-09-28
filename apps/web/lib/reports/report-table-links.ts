// Phase 1N-C3 remediation: a single, shared query-state builder for every
// detail report's sort/pagination links (and the hidden fields its search
// form must carry) so no report page hand-rolls its own
// `new URLSearchParams()` and silently drops the caller's active period,
// branch, or table state. Every report page's sort/page Link and search
// form hidden inputs MUST go through this module — never construct report
// query strings inline.
//
// Canonical state: preset, dateFrom, dateTo, branch, search, sort,
// direction, page. Callers pass whichever subset applies (a report with no
// branch filter simply omits `branch`); empty/undefined values are never
// written to the query string, matching this workspace's existing URL
// convention of omitting default/empty params.

export type ReportTableLinkState = {
  preset?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  branch?: string | undefined;
  search?: string | undefined;
  sort: string;
  direction: "asc" | "desc";
};

function baseParams(state: Pick<ReportTableLinkState, "preset" | "dateFrom" | "dateTo" | "branch" | "search">): URLSearchParams {
  const params = new URLSearchParams();
  if (state.preset) params.set("preset", state.preset);
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  if (state.branch) params.set("branch", state.branch);
  if (state.search) params.set("q", state.search);
  return params;
}

/**
 * Href for a sortable column header. Preserves preset/dateFrom/dateTo/
 * branch/search and sets the new sort key + direction. Pagination always
 * resets to page 1 on a sort change (the `page` param is simply omitted —
 * the report's own query parser already defaults a missing page to 1).
 */
export function buildReportSortHref(state: ReportTableLinkState, sortKey: string, nextDirection: "asc" | "desc"): string {
  const params = baseParams(state);
  params.set("sort", sortKey);
  params.set("dir", nextDirection);
  return `?${params.toString()}`;
}

/**
 * Href for a pagination link. Preserves preset/dateFrom/dateTo/branch/
 * search/sort/direction and sets the target page.
 */
export function buildReportPageHref(state: ReportTableLinkState, page: number): string {
  const params = baseParams(state);
  params.set("sort", state.sort);
  params.set("dir", state.direction);
  params.set("page", String(page));
  return `?${params.toString()}`;
}

/**
 * Weaker than ReportTableLinkState: sort/direction are optional because
 * the Sales & Revenue report has no sort/pagination surface at all (see
 * lib/reports/dal.ts's own header comment) and its export link must not
 * fabricate a sort param no route on that report ever reads.
 */
export type ReportExportLinkState = Omit<ReportTableLinkState, "sort" | "direction"> & {
  sort?: string | undefined;
  direction?: "asc" | "desc" | undefined;
};

/**
 * Phase 1N-C5: href for a report's "Export CSV" action. Preserves the
 * exact same preset/dateFrom/dateTo/branch/search/sort/direction state
 * as the screen currently being viewed, but deliberately omits `page` —
 * export is never limited to the current page (see the export route's
 * own row-limit/pagination-bypass documentation).
 */
export function buildReportExportHref(basePath: string, state: ReportExportLinkState): string {
  const params = baseParams(state);
  if (state.sort) params.set("sort", state.sort);
  if (state.direction) params.set("dir", state.direction);
  const search = params.toString();
  return search ? `${basePath}?${search}` : basePath;
}
