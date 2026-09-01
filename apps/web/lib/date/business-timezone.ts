/**
 * Codex adversarial review, remediation round 1, Low 4: BusinessOS has no
 * per-business timezone setting yet (the product is Nigeria-only today —
 * see e.g. lib/currency.ts's own hardcoded "NGN"), and a handful of
 * SERVER-rendered read paths need "today's calendar date" for a
 * comparison against a stored `date` column with no time-of-day
 * component of its own (invoice.due_date). Unlike a form submission
 * (lib/expenses/expense-form.tsx's/lib/invoices/payment-form.tsx's own
 * datetime-local -> ISO conversion), there is no browser present at
 * render time to ask "what is the user's own local time?" — this code
 * runs in whatever timezone the server process happens to be deployed
 * in, which is NOT reliably Africa/Lagos (Vercel functions default to
 * UTC). `new Date().toISOString().slice(0, 10)` therefore silently
 * computes the wrong calendar day for part of every day: at 00:30 WAT
 * (Africa/Lagos, UTC+1) the UTC calendar date is still "yesterday".
 *
 * Africa/Lagos has NO daylight saving (a fixed year-round UTC+1 offset,
 * unlike, say, US/Europe timezones) — so a fixed +1 hour shift before
 * taking the UTC date slice is an exact, permanently-correct conversion
 * for this one timezone, not an approximation that drifts across DST
 * boundaries. This is a deliberate, narrowly-scoped fix for BusinessOS's
 * current Nigeria-only product assumptions (explicitly not a general
 * IANA-timezone solution, and not Phase 2 "BOS Edge" infrastructure) —
 * the moment a second business timezone is ever supported, this becomes
 * the one place that needs to learn to read a real per-business setting
 * instead of a hardcoded constant.
 */
const LAGOS_UTC_OFFSET_HOURS = 1;

/** Today's calendar date (YYYY-MM-DD) in Africa/Lagos, computed from the
 * current instant — safe to call from server-rendered code with no
 * browser/request-local timezone context available. */
export function businessTodayDateString(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + LAGOS_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
