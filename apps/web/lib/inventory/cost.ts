import type { Json } from "@/lib/supabase/database.types";

/**
 * `get_product_cost`/`get_movement_unit_cost` return `jsonb`, generated
 * as TypeScript `Json` (correctly nullable) rather than a lying
 * non-nullable `number` — see the database plan's own reasoning. That
 * still leaves the actual runtime value untyped from the caller's
 * perspective: an unchecked `as number` cast would silently accept a
 * string, object, array, boolean, or non-finite number if the RPC's
 * shape ever changed unexpectedly. This is the one place that value is
 * narrowed, and every call site uses it — never a bare cast anywhere
 * else in the app.
 *
 * Accepts: a finite number, or `null` (both are legitimate — the
 * function's own non-disclosure design returns `null` for both a
 * genuinely absent value and a foreign/nonexistent id).
 * Rejects (fails safe — returns `null`, never throws, never renders
 * garbage): any other JSON shape. A rejection is logged distinctly from
 * a legitimate `null`, since it indicates a real contract mismatch worth
 * knowing about server-side, even though the UI's behavior is identical
 * either way (nothing rendered).
 */
export function parseCostValue(value: Json): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  console.error("parseCostValue: unexpected cost RPC return shape", value);
  return null;
}
