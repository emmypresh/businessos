// Phase 1E financial report date-range resolution.
//
// Every preset resolves to an explicit [from, to) instant pair — never an
// inclusive end-of-day hack (e.g. appending 23:59:59.999) — matching
// get_financial_summary's own half-open interval contract exactly
// (supabase/migrations/20260827080600_get_financial_summary_rpc.sql).
//
// No business-level timezone setting exists anywhere in this application
// yet (verified: no timezone column on public.businesses, no per-business
// locale setting) — every boundary here is computed in UTC, matching
// Postgres's own default session timezone for a bare timestamptz literal.
// This is a deliberate, documented choice, not an oversight: if a future
// phase introduces per-business timezones, this module is the one place
// that needs to change. The day-boundary arithmetic itself is shared with
// lib/date-utc.ts (also used by the expense list's dateFrom/dateTo
// filters) so both call sites agree on exactly what "a calendar day in
// UTC" means — this file's own exported functions and their results are
// unchanged by that extraction.

import { startOfUtcDay, addUtcDays, startOfUtcMonth, calendarDayStartUtc, calendarDayEndExclusiveUtc } from "@/lib/date-utc";
import { REPORT_RANGE_PRESET, type ReportRangePreset } from "./constants";

export type ReportRange = { from: string; to: string };

type RelativePreset = Exclude<ReportRangePreset, "custom">;

/**
 * Resolves a preset (relative to `now`) to an explicit [from, to) instant
 * pair. CUSTOM is not resolved here — a custom range's boundaries are
 * caller-supplied dates, resolved separately by resolveCustomRange below.
 */
export function resolvePresetRange(preset: RelativePreset, now: Date = new Date()): ReportRange {
  const todayStart = startOfUtcDay(now);

  switch (preset) {
    case REPORT_RANGE_PRESET.TODAY: {
      return { from: todayStart.toISOString(), to: addUtcDays(todayStart, 1).toISOString() };
    }
    case REPORT_RANGE_PRESET.LAST_7_DAYS: {
      // Inclusive of today: today plus the six days before it.
      return {
        from: addUtcDays(todayStart, -6).toISOString(),
        to: addUtcDays(todayStart, 1).toISOString(),
      };
    }
    case REPORT_RANGE_PRESET.LAST_30_DAYS: {
      return {
        from: addUtcDays(todayStart, -29).toISOString(),
        to: addUtcDays(todayStart, 1).toISOString(),
      };
    }
    case REPORT_RANGE_PRESET.THIS_MONTH: {
      const from = startOfUtcMonth(now);
      const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case REPORT_RANGE_PRESET.PREVIOUS_MONTH: {
      const thisMonthStart = startOfUtcMonth(now);
      const from = new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - 1, 1));
      return { from: from.toISOString(), to: thisMonthStart.toISOString() };
    }
    default: {
      const exhaustive: never = preset;
      throw new Error(`Unhandled report range preset: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolves a validated custom {dateFrom, dateTo} (plain YYYY-MM-DD dates,
 * already checked by CustomReportRangeSchema — dateFrom <= dateTo) into an
 * explicit [from, to) instant pair. `to` is the exclusive UTC-midnight
 * boundary the day AFTER dateTo, so a caller picking "Aug 1 to Aug 27"
 * gets the whole of Aug 27 included — never an inclusive-end hack. Uses
 * the same calendarDayStartUtc/calendarDayEndExclusiveUtc helpers the
 * expense list's date filters use (lib/expenses/dal.ts), so both agree on
 * exactly what a calendar day means.
 */
export function resolveCustomRange(input: { dateFrom: string; dateTo: string }): ReportRange {
  const from = calendarDayStartUtc(input.dateFrom);
  const to = calendarDayEndExclusiveUtc(input.dateTo);
  // CustomReportRangeSchema already validates both are well-formed
  // "YYYY-MM-DD" strings before this function is ever called — a null
  // here would indicate that validation was bypassed, which is a caller
  // bug, not a recoverable runtime state to paper over silently.
  if (!from || !to) {
    throw new Error(`resolveCustomRange received an invalid calendar date: ${JSON.stringify(input)}`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Combines preset resolution and custom-range resolution behind one call
 * — what the reports page actually calls. Returns null only for
 * preset === "custom" with no (or not-yet-validated) custom input, which
 * the caller must treat as "cannot resolve a range yet", never as a
 * zero-width [now, now) range.
 */
export function resolveReportRange(
  preset: ReportRangePreset,
  custom: { dateFrom: string; dateTo: string } | null,
  now: Date = new Date()
): ReportRange | null {
  if (preset === REPORT_RANGE_PRESET.CUSTOM) {
    return custom ? resolveCustomRange(custom) : null;
  }
  return resolvePresetRange(preset, now);
}
