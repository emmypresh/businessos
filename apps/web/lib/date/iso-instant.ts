/**
 * Codex adversarial review, remediation round 3 ("Semantically Invalid
 * ISO Calendar Dates"): validates that a string is a SEMANTICALLY REAL,
 * explicit, offset-bearing ISO 8601 instant — never relying on
 * `new Date(str)`'s/`Date.parse(str)`'s own normalization behavior,
 * which silently rolls an impossible calendar date into a DIFFERENT,
 * valid one instead of rejecting it (e.g. `new Date("2026-02-30T15:30:00Z")`
 * normalizes to March 2nd — no error, no NaN — and would otherwise reach
 * record_invoice_payment/PostgREST/PostgreSQL, which fails it late with
 * a raw SQLSTATE 22008 instead of a controlled field error).
 *
 * This is a small, purpose-built regex-capture + explicit-range-check +
 * calendar-arithmetic validator — deliberately not a general-purpose
 * date/timezone library. It answers exactly one question ("is this a
 * real calendar instant, shaped exactly like
 * `YYYY-MM-DDTHH:mm:ss[.fff](Z|±HH:MM)`") and nothing more:
 *
 *   1. Regex-capture year/month/day/hour/minute/second/offset — a
 *      structural match is NECESSARY but not sufficient.
 *   2. Explicit numeric range checks on every component (month 1-12,
 *      hour 0-23, minute 0-59, second 0-59 — no leap-second support,
 *      offset hours 0-23 / minutes 0-59).
 *   3. Real days-in-month validation, including the full Gregorian
 *      leap-year rule (divisible by 4, except divisible by 100, unless
 *      ALSO divisible by 400) — 2024/2000 are leap years, 2026/2100 are
 *      not.
 *
 * `Date.parse`/`new Date(...)` may still be used AFTER this validator
 * passes (e.g. for future-date-grace-window arithmetic) — by that point
 * every calendar component has already been proven real, so there is
 * nothing left for JS's own normalization to silently paper over.
 */

const OFFSET_BEARING_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Gregorian leap-year rule, applied exactly: divisible by 4, except
// divisible by 100, unless ALSO divisible by 400.
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const DAYS_IN_MONTH = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return DAYS_IN_MONTH[month - 1];
}

/**
 * True only for a string that is BOTH shaped like, and a genuinely real,
 * offset-bearing ISO 8601 instant. Structural regex match alone is never
 * enough — every numeric component is independently range-checked,
 * including calendar-correct days-in-month (leap years included) and a
 * real (non-impossible) UTC offset.
 */
export function isValidOffsetBearingInstant(value: string): boolean {
  const match = OFFSET_BEARING_INSTANT_PATTERN.exec(value);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, offset] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  // No leap-second support — 60 is rejected outright, matching the
  // review's own explicit "23:59:60 must be rejected" requirement.
  if (second < 0 || second > 59) return false;

  if (offset !== "Z") {
    // The outer pattern already constrains this to `[+-]\d{2}:\d{2}`;
    // re-captured here purely to range-check hours/minutes independently
    // — e.g. "+24:00"/"+12:60"/"-25:00" all match the SHAPE but are not
    // real offsets.
    const offsetMatch = /^[+-](\d{2}):(\d{2})$/.exec(offset);
    if (!offsetMatch) return false;
    const offsetHours = Number(offsetMatch[1]);
    const offsetMinutes = Number(offsetMatch[2]);
    if (offsetHours < 0 || offsetHours > 23) return false;
    if (offsetMinutes < 0 || offsetMinutes > 59) return false;
  }

  return true;
}
