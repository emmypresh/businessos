/**
 * Phase 1Q-0B: businesses now store their own IANA timezone
 * (businesses.timezone — see supabase/migrations/20260923090000_business_
 * timezone.sql), closing the gap this file's own original header comment
 * (Codex adversarial review, remediation round 1, Low 4) flagged: "the
 * moment a second business timezone is ever supported, this becomes the
 * one place that needs to learn to read a real per-business setting
 * instead of a hardcoded constant."
 *
 * This now uses Intl.DateTimeFormat with an explicit `timeZone`, not a
 * fixed UTC-offset arithmetic shift — the original implementation's fixed
 * +1 hour trick was only ever an exact conversion for Africa/Lagos
 * (a timezone with no daylight saving). Several of this phase's OTHER
 * launch timezones DO observe DST (the four US zones, and Europe/London's
 * BST), so a fixed offset would silently compute the wrong calendar date
 * for those businesses part of the year. Intl's own tz-database-backed
 * conversion is correct for every IANA zone, DST or not, and produces
 * IDENTICAL output to the old fixed-offset code for Africa/Lagos — so
 * every existing caller (which passes no timezone and gets the default
 * below) keeps its exact previous behavior.
 *
 * `en-CA` is used purely as a formatting trick: that locale's short date
 * format is already "YYYY-MM-DD", so no manual reassembly of
 * year/month/day parts is needed.
 *
 * DEFAULT_BUSINESS_TIMEZONE remains Africa/Lagos — every business created
 * before this phase was backfilled to it (see that same migration), and
 * it is still the right fallback for any SERVER-rendered call site that
 * has not yet been threaded a real businesses.timezone value (see this
 * file's own "remaining Africa/Lagos assumptions" note in the phase
 * report — reporting's own UTC range semantics are explicitly UNCHANGED
 * by this phase and do NOT call this function).
 */
export const DEFAULT_BUSINESS_TIMEZONE = "Africa/Lagos";

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone, computed
 * from the current instant — safe to call from server-rendered code with
 * no browser/request-local timezone context available. Defaults to
 * Africa/Lagos when no business timezone is available yet. */
export function businessTodayDateString(
  now: Date = new Date(),
  timezone: string = DEFAULT_BUSINESS_TIMEZONE
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
