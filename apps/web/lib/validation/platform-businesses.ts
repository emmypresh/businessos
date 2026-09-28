import { z } from "zod";

/**
 * Client/route-side shaping for the Phase 1O-B business directory's URL
 * query params (?q=&country=&currency=&plan=&status=&sort=&dir=&page=).
 * Bounds mirror public.list_platform_businesses' own server-side
 * validation exactly (supabase/migrations/20260929080000_platform_business_directory.sql)
 * — that RPC remains the actual authority; this schema exists so a
 * malformed query string is normalized to a safe default before it ever
 * becomes an RPC call, rather than surfacing a raw Postgres error to the
 * page.
 */

export const PLATFORM_BUSINESS_SORT = {
  NAME: "name",
  CREATED_AT: "created_at",
  MEMBER_COUNT: "member_count",
  BRANCH_COUNT: "branch_count",
} as const;

export const PLATFORM_BUSINESS_SORT_VALUES = [
  PLATFORM_BUSINESS_SORT.NAME,
  PLATFORM_BUSINESS_SORT.CREATED_AT,
  PLATFORM_BUSINESS_SORT.MEMBER_COUNT,
  PLATFORM_BUSINESS_SORT.BRANCH_COUNT,
] as const;

export type PlatformBusinessSort = (typeof PLATFORM_BUSINESS_SORT_VALUES)[number];

export const SUBSCRIPTION_PLAN_CODE_VALUES = ["STARTER", "GROWTH", "BUSINESS", "ENTERPRISE"] as const;
export const SUBSCRIPTION_STATUS_VALUES = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "EXPIRED",
  "INCOMPLETE",
] as const;

export const PLATFORM_BUSINESS_DEFAULT_PAGE_SIZE = 25;
export const PLATFORM_BUSINESS_MAX_PAGE_SIZE = 100;

export const PlatformBusinessQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .optional(),
  plan: z.enum(SUBSCRIPTION_PLAN_CODE_VALUES).optional(),
  status: z.enum(SUBSCRIPTION_STATUS_VALUES).optional(),
  sort: z.enum(PLATFORM_BUSINESS_SORT_VALUES).default(PLATFORM_BUSINESS_SORT.CREATED_AT),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
});

export type PlatformBusinessQuery = z.infer<typeof PlatformBusinessQuerySchema>;

// Shared UUID identifier check for the directory's own [businessId] route
// param — mirrors every other domain's own IdSchema exactly.
export const IdSchema = z.uuid();

/**
 * Parses a raw Next.js searchParams-shaped record into a validated query,
 * discarding (never throwing on) anything malformed — an invalid/tampered
 * query string falls back to the schema's own defaults (page 1, newest
 * first, no filters) rather than ever reaching the RPC as raw input or
 * surfacing a validation error to the visitor.
 */
export function parsePlatformBusinessQuery(
  raw: Record<string, string | string[] | undefined>
): PlatformBusinessQuery {
  const pick = (key: string) => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };

  const parsed = PlatformBusinessQuerySchema.safeParse({
    q: pick("q"),
    country: pick("country"),
    currency: pick("currency"),
    plan: pick("plan"),
    status: pick("status"),
    sort: pick("sort"),
    dir: pick("dir"),
    page: pick("page"),
  });

  if (parsed.success) {
    return parsed.data;
  }

  return PlatformBusinessQuerySchema.parse({});
}
