// Phase 1N-C1 reports workspace: a canonical, presentation-layer range
// parser that sits ON TOP of the frozen Phase 1E range primitives
// (lib/reports/ranges.ts, lib/reports/constants.ts) — it does not change
// their exported behavior or the [from, to) UTC contract they implement
// (see ranges.ts's own header comment for why every boundary is UTC).
//
// This module exists so C2–C5 (sales/customers/inventory/branches detail
// reports and CSV export) can all resolve "what period is the caller
// asking about" through one deterministic, server-authoritative helper
// instead of each route re-implementing preset/custom parsing and
// inventing its own excessive-range behavior. The /reports workspace page
// is the first caller.
//
// Additive only: the existing get_financial_summary call (unbounded, no
// day cap — see supabase/migrations/20260827080600_get_financial_summary_rpc.sql,
// which never checks a maximum span) is not modified in shape or
// semantics by this file. What changes is that the /reports workspace now
// also rejects a custom range wider than MAX_REPORT_RANGE_DAYS before it
// ever reaches that RPC — the same cap the frozen Phase 1N management
// aggregate already enforces at the database layer (see
// supabase/migrations/20260916090200_management_reporting_range_limit.sql),
// applied here at the presentation layer for consistency and to keep
// "no unbounded report queries" true workspace-wide, not just for one
// aggregate.

import { REPORT_RANGE_PRESET, type ReportRangePreset } from "./constants";
import { resolvePresetRange, resolveCustomRange, type ReportRange } from "./ranges";
import { CustomReportRangeSchema } from "@/lib/validation/reports";

/** Matches the frozen cap in 20260916090200_management_reporting_range_limit.sql. */
export const MAX_REPORT_RANGE_DAYS = 366;

export const EXCESSIVE_RANGE_MESSAGE = `Select a range of ${MAX_REPORT_RANGE_DAYS} days or fewer.`;

const PRESET_VALUES = Object.values(REPORT_RANGE_PRESET) as ReportRangePreset[];

export type ReportRangeQuery = {
  preset: ReportRangePreset;
  range: ReportRange;
  custom: { dateFrom: string; dateTo: string } | null;
  /** e.g. "Aug 18 – Sep 16, 2026 · UTC" — always UTC, always half-open-aware. */
  label: string;
};

export type ReportRangeQueryResult =
  | { status: "ok"; query: ReportRangeQuery }
  // preset === "custom" chosen but no (or not yet complete) dates entered —
  // never a validation error, just "nothing to resolve yet".
  | { status: "pending" }
  | { status: "error"; message: string };

const dayMs = 24 * 60 * 60 * 1000;

function exceedsMaxRange(range: ReportRange): boolean {
  const spanMs = new Date(range.to).getTime() - new Date(range.from).getTime();
  return spanMs > MAX_REPORT_RANGE_DAYS * dayMs;
}

/**
 * Formats a half-open [from, to) UTC range as a human label. `to` is
 * exclusive, so the displayed end date is `to` minus one millisecond —
 * e.g. from=2026-08-18T00:00:00Z, to=2026-09-17T00:00:00Z displays as
 * "Aug 18, 2026 – Sep 16, 2026, UTC", never "Sep 17". A single-day range (e.g.
 * TODAY) collapses to one date instead of repeating it either side of a
 * dash.
 */
export function formatReportRangeLabel(range: ReportRange): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const from = new Date(range.from);
  const inclusiveTo = new Date(new Date(range.to).getTime() - 1);
  const fromLabel = formatter.format(from);
  const toLabel = formatter.format(inclusiveTo);
  return fromLabel === toLabel ? `${fromLabel}, UTC` : `${fromLabel} – ${toLabel}, UTC`;
}

export type ReportRangeQueryInput = {
  preset?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

/**
 * Resolves raw (already-string-narrowed) query-param input into a
 * canonical ReportRangeQuery. An unknown/missing preset silently falls
 * back to LAST_30_DAYS (matching the workspace's documented default) —
 * only an *attempted* custom range that fails validation surfaces as an
 * error, matching the existing /reports page's own UX convention.
 */
export function parseReportRangeQuery(
  input: ReportRangeQueryInput,
  now: Date = new Date()
): ReportRangeQueryResult {
  const preset: ReportRangePreset = PRESET_VALUES.includes(input.preset as ReportRangePreset)
    ? (input.preset as ReportRangePreset)
    : REPORT_RANGE_PRESET.LAST_30_DAYS;

  if (preset !== REPORT_RANGE_PRESET.CUSTOM) {
    const range = resolvePresetRange(preset, now);
    return {
      status: "ok",
      query: { preset, range, custom: null, label: formatReportRangeLabel(range) },
    };
  }

  const parsed = CustomReportRangeSchema.safeParse({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });

  if (!parsed.success) {
    if (typeof input.dateFrom === "string" || typeof input.dateTo === "string") {
      return {
        status: "error",
        message: parsed.error.issues[0]?.message ?? "Enter a valid date range.",
      };
    }
    return { status: "pending" };
  }

  const range = resolveCustomRange(parsed.data);
  if (exceedsMaxRange(range)) {
    return { status: "error", message: EXCESSIVE_RANGE_MESSAGE };
  }

  return {
    status: "ok",
    query: { preset, range, custom: parsed.data, label: formatReportRangeLabel(range) },
  };
}

// Re-exported so callers building on this module never need a second
// import from lib/validation/reports just to type a custom-range shape.
export type { CustomReportRangeInput } from "@/lib/validation/reports";

// Phase 1N-C2: a pure, additive query-string builder so a detail report
// (e.g. /reports/sales) can link to/from the /reports workspace without
// losing the caller's selected period. Deliberately carries ONLY
// preset/dateFrom/dateTo — never `branch` — because this module has no
// opinion on whether a given detail report's backend safely supports
// branch-scoped semantics; a detail report page decides that for itself
// and must not blindly forward a branch id it cannot honor.
export function buildReportRangeSearchParams(input: ReportRangeQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.preset) params.set("preset", input.preset);
  if (input.dateFrom) params.set("dateFrom", input.dateFrom);
  if (input.dateTo) params.set("dateTo", input.dateTo);
  return params;
}
