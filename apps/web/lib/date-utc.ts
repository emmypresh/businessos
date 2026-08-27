/**
 * Shared UTC calendar-day boundary helpers.
 *
 * Extracted so every calendar-date filter/range in this app (the expense
 * list's dateFrom/dateTo filters, lib/reports/ranges.ts's report presets
 * and custom range) shares ONE implementation of "start of day" /
 * "exclusive next-day boundary" arithmetic, instead of two independent
 * copies that could silently drift apart. This is a pure extraction, not
 * a behavior change — lib/reports/ranges.ts's own exported functions
 * (resolvePresetRange/resolveCustomRange/resolveReportRange) keep their
 * exact existing signatures and results.
 *
 * No business-level timezone setting exists anywhere in this application
 * yet (verified: no timezone column on public.businesses, no per-business
 * locale setting) — every boundary here is computed in UTC, matching
 * Postgres's own default session timezone for a bare timestamptz literal.
 * This is a deliberate, documented choice, not an oversight: if a future
 * phase introduces per-business timezones, this module is the one place
 * that needs to change. The application UI must make this explicit to the
 * user wherever a calendar date is involved (see lib/reports/constants.ts's
 * "(UTC)"-suffixed preset labels and the reports page's helper copy) — see
 * that suffix requirement's own header comment for the full reasoning.
 */

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Parses a strict "YYYY-MM-DD" calendar date string into the UTC instant
 * at its start (00:00:00.000Z). Returns null for anything that isn't
 * exactly that shape, or that doesn't round-trip to a real calendar date
 * (e.g. "2026-02-30", which `Date` would otherwise silently roll forward
 * into March) — callers MUST treat null as "this value is not a usable
 * calendar date" and never pass the original string through to a query.
 */
export function parseCalendarDateUtc(value: string): Date | null {
  if (!CALENDAR_DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

/**
 * The inclusive start-of-day UTC instant for a "YYYY-MM-DD" filter value
 * — for use as a `>=` (gte) lower bound. Returns null if the value is not
 * a well-formed calendar date; the caller must then omit the filter
 * entirely rather than pass the raw string to Postgres.
 */
export function calendarDayStartUtc(value: string): Date | null {
  return parseCalendarDateUtc(value);
}

/**
 * The EXCLUSIVE next-day UTC boundary for a "YYYY-MM-DD" filter value —
 * for use as a `<` (lt) upper bound, NEVER `<=` against 23:59:59(.999).
 * This is what makes a visible calendar "To date" field behave as the
 * user expects: every instant on the selected day, through the literal
 * end of that day, is included. Returns null if the value is not a
 * well-formed calendar date.
 */
export function calendarDayEndExclusiveUtc(value: string): Date | null {
  const start = parseCalendarDateUtc(value);
  return start ? addUtcDays(start, 1) : null;
}

// Matches exactly the canonical timestamptz text PostgREST returns for a
// `timestamptz` column (verified against real local Data API output —
// e.g. "2026-08-27T19:54:42.395+00:00" for a value this application
// itself submitted via `.toISOString()`, and "2026-08-27T19:54:42.406849+00:00"
// for a `now()`-defaulted column, which Postgres emits at microsecond
// precision with trailing zeros stripped), and the "Z"-suffixed spelling
// `Date.prototype.toISOString()` itself always produces. Fractional
// seconds are optional and, when present, 1-6 digits (Postgres never
// emits more than six — timestamptz has microsecond precision).
//
// The timezone offset is DELIBERATELY narrowed to exactly `Z` or
// `+00:00` — NOT the general `[+-]\d{2}:\d{2}` grammar a real RFC3339
// parser would accept. Codex adversarial review (3rd pass) confirmed the
// broader grammar let a syntactically-plausible but Postgres-rejected
// value through (`+99:99`, an out-of-range offset) and, more subtly,
// let a syntactically VALID but semantically wrong-for-this-application
// value through too (`+16:00` — a genuine timezone, just not one this
// cursor could ever legitimately carry). This value is a pagination
// cursor's `incurred_at`, copied verbatim from a column this
// application's own local Postgres instance returns — which is always
// UTC (verified: no per-business timezone setting exists anywhere in
// this application yet, see this file's own top-of-file header comment
// — and Supabase's session/database timezone is UTC). An expense cursor
// is never a user-entered business-local timestamp, so there is no
// legitimate non-UTC offset for it to ever carry; narrowing the grammar
// to exactly the two spellings UTC can take is strictly safer than
// accepting arbitrary offsets "just in case", and matches the actual
// observed output exactly.
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/;

/**
 * Strictly validates a timestamptz-shaped string — deliberately NOT
 * `Date.parse`/`new Date(x)` alone. Those accept a much wider grammar
 * than Postgres's own `timestamptz` input parser does — confirmed
 * directly: `Date.parse("0")` succeeds in JavaScript, producing a real
 * (if nonsensical) instant, while `'0'::timestamptz` is rejected by
 * Postgres with a 22007 (invalid_datetime_format) error. A pagination
 * cursor's timestamp component is application-generated data (this app
 * only ever encodes a value it just read back from a timestamptz column
 * — see lib/expenses/dal.ts's decodeExpenseCursor), so accepting only
 * the exact shape this application itself ever emits is both correct
 * and strictly safer than accepting anything `Date.parse` tolerates.
 * The pattern's own character allowlist (digits, `T`, `:`, `.`, `Z`,
 * `+`) also structurally cannot contain a comma, parenthesis, or other
 * character with meaning in a PostgREST `.or()` filter string, which is
 * where this value is ultimately embedded.
 *
 * After the syntax check, the captured numeric components are
 * range-validated directly (year >= 1 — Postgres's `timestamptz` input
 * parser rejects year 0000 outright, confirmed by Codex; month 1-12; day
 * valid for that month/year; hour <=23; minute/second <=59) rather than
 * trusted to `new Date(...)`'s own permissive rollover behavior, which
 * would otherwise silently accept "2026-02-30T00:00:00.000Z" as March
 * 2nd, or "2026-02-29T..." (not a leap year) as March 1st.
 */
export function isRealTimestampInstant(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  // Day 0 of the FOLLOWING month, in UTC, is the last day of THIS month
  // — this correctly accounts for leap years without a separate table.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;

  return true;
}
