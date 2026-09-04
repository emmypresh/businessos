/**
 * Opaque keyset-pagination cursor: `(created_at, id)`, both DESC —
 * deterministic even under concurrent inserts (unlike offset pagination,
 * which can skip or duplicate rows when new rows land between page
 * requests). Used by every paginated list in the products/inventory
 * domain (products, inventory overview, inventory history) so all three
 * share one cursor encoding.
 */

export type Cursor = { createdAt: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value: string | undefined | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    // A malformed/tampered cursor is never fatal — treat it as "no
    // cursor" (first page) rather than throwing, since it only ever
    // affects which page of the CALLER's own tenant-scoped, RLS-filtered
    // data they see; it cannot be used to reach another tenant's rows.
    return null;
  }
}

export const DEFAULT_PAGE_SIZE = 25;

// SEC-1K-APP-01 remediation: purely ADDITIVE strict validators for a
// decoded cursor's two fields. decodeCursor() itself is UNCHANGED — it
// still only confirms `createdAt`/`id` are strings, exactly as every
// existing caller (audit, customers, expenses, inventory, invoices,
// products, returns, sales) already relies on — these two functions are
// new, opt-in shape checks a caller may additionally apply to that
// decoded value before trusting it enough to interpolate into a
// PostgREST filter string. Nothing here changes decodeCursor's own
// return type, behavior, or the "malformed -> null" convention any
// existing caller depends on.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict structural validator for a keyset cursor's `id` field — a
 * plain UUID, matching this schema's universal gen_random_uuid() primary
 * -key convention. Bounded length (exact 36) rejects any padding/grammar
 * before the regex even runs. */
export function isCanonicalUuid(value: string): boolean {
  return value.length === 36 && UUID_PATTERN.test(value);
}

// Verified LIVE against this project's actual PostgREST output (not
// assumed): `select to_json(created_at) from notifications` returns
// strings like "2026-09-03T21:24:39.657079+00:00" — a fixed "+00:00"
// offset (never "Z" — this is Postgres's own to_json(timestamptz)
// rendering, not a JS Date/toISOString() one), and a fractional-seconds
// part that is OMITTED when exactly zero and otherwise 1-6 digits with
// trailing zeros trimmed (".5", ".123", ".999999" are all real,
// legitimate values this database actually produces — a fixed 3-or-6-
// digit assumption would incorrectly reject genuine rows).
const CANONICAL_TIMESTAMPTZ_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?\+00:00$/;

/**
 * Strict structural validator for a keyset cursor's `createdAt` field —
 * the EXACT canonical shape this project's own Postgres/PostgREST layer
 * emits for a timestamptz column (see above), never a looser "any ISO
 * variant". This is a SHAPE check only: a value that passes is returned
 * completely unchanged by the caller — it is NEVER reparsed through
 * `new Date(...).toISOString()` or any other renormalization, which
 * would silently collapse genuine Postgres microsecond precision
 * (".999999") down to JS Date's own millisecond ceiling and corrupt
 * exact keyset pagination semantics. `Date.parse` is used only as a
 * SECONDARY real-calendar-validity check (rejecting a structurally
 * shaped but impossible date the regex's own day-range alone wouldn't
 * catch, e.g. Feb 30) — its result is discarded either way; only the
 * pass/fail matters, never its own (millisecond-lossy) parsed value.
 */
export function isCanonicalTimestamptz(value: string): boolean {
  if (value.length > 40) return false;
  if (!CANONICAL_TIMESTAMPTZ_PATTERN.test(value)) return false;
  // The regex's own day range (01-31) alone accepts a day that is
  // impossible for a GIVEN month (e.g. Feb 30) — `Date.parse` does NOT
  // catch this either (JS silently rolls an out-of-range day into the
  // next month rather than rejecting it), so days-in-month is checked
  // explicitly. `Date.UTC(year, month, 0)` is the standard "day 0 of the
  // next month" trick for the last real day of THIS month, correctly
  // accounting for leap years.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return !Number.isNaN(Date.parse(value));
}
