import { z } from "zod";

/**
 * Client/route-side shaping for /internal/admin/audit's URL query params
 * (?actionType=&q=&dateFrom=&dateTo=&page=). Mirrors
 * lib/validation/platform-businesses.ts's own established convention: this
 * schema exists so a malformed query string is normalized to a safe default
 * before it ever becomes an RPC call. public.list_platform_audit
 * (supabase/migrations/20261004080000_platform_audit_subscriptions_support.sql)
 * remains the actual authority and independently re-validates every value.
 */
export const PLATFORM_ACTION_TYPE_VALUES = [
  "SUSPEND_BUSINESS",
  "REACTIVATE_BUSINESS",
  "EXTEND_TRIAL",
] as const;

// Plain `YYYY-MM-DD` only — matches an HTML `<input type="date">` value
// exactly. Postgres reads this as local midnight when cast to timestamptz,
// which is precise enough for a coarse audit-log date filter; a malformed
// value is dropped to "no filter" here rather than ever reaching the RPC
// and surfacing a raw cast error.
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PlatformAuditQuerySchema = z.object({
  actionType: z.enum(PLATFORM_ACTION_TYPE_VALUES).optional(),
  q: z.string().trim().max(200).optional(),
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type PlatformAuditQuery = z.infer<typeof PlatformAuditQuerySchema>;

export function parsePlatformAuditQuery(
  raw: Record<string, string | string[] | undefined>
): PlatformAuditQuery {
  const pick = (key: string) => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };

  const parsed = PlatformAuditQuerySchema.safeParse({
    actionType: pick("actionType"),
    q: pick("q"),
    dateFrom: pick("dateFrom"),
    dateTo: pick("dateTo"),
    page: pick("page"),
  });

  if (parsed.success) {
    return parsed.data;
  }

  return PlatformAuditQuerySchema.parse({});
}
