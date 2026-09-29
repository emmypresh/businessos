import { z } from "zod";

/**
 * Phase 1O-C — support console tab state + member/activity/audit query
 * shaping. Bounds mirror the corresponding server-side RPC validation
 * exactly (supabase/migrations/20260930080000_platform_business_operational_intelligence.sql)
 * — those RPCs remain the actual authority; this module exists so a
 * malformed URL/query never reaches an RPC as raw input, and so an
 * invalid ?tab= value falls back to a safe default instead of ever being
 * trusted directly.
 */

export const SUPPORT_TAB = {
  OVERVIEW: "overview",
  MEMBERS: "members",
  BRANCHES: "branches",
  SUBSCRIPTION: "subscription",
  ACTIVITY: "activity",
  DIAGNOSTICS: "diagnostics",
  AUDIT: "audit",
  // Phase 1O-D — kept as its own tab, deliberately never merged into
  // Overview (phase instructions §30: "Do not mix destructive actions
  // into ordinary Overview cards").
  ACTIONS: "actions",
} as const;

export const SUPPORT_TAB_VALUES = [
  SUPPORT_TAB.OVERVIEW,
  SUPPORT_TAB.MEMBERS,
  SUPPORT_TAB.BRANCHES,
  SUPPORT_TAB.SUBSCRIPTION,
  SUPPORT_TAB.ACTIVITY,
  SUPPORT_TAB.DIAGNOSTICS,
  SUPPORT_TAB.AUDIT,
  SUPPORT_TAB.ACTIONS,
] as const;

export type SupportTab = (typeof SUPPORT_TAB_VALUES)[number];

/**
 * Normalizes an arbitrary caller-supplied tab string to a known tab,
 * falling back to overview for anything unrecognized — never trusts an
 * arbitrary string as a tab identifier (phase instruction #27).
 */
export function parseSupportTab(raw: string | string[] | undefined): SupportTab {
  const value = typeof raw === "string" ? raw : undefined;
  const parsed = z.enum(SUPPORT_TAB_VALUES).safeParse(value);
  return parsed.success ? parsed.data : SUPPORT_TAB.OVERVIEW;
}

export const MEMBER_ROLE_VALUES = [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "SALES",
  "INVENTORY",
  "ACCOUNTANT",
  "VIEWER",
] as const;

export const MEMBER_STATUS_VALUES = ["invited", "active", "suspended", "removed"] as const;

export const MEMBER_SORT_VALUES = ["email", "role", "status", "created_at"] as const;
export type MemberSort = (typeof MEMBER_SORT_VALUES)[number];

export const SUPPORT_DEFAULT_PAGE_SIZE = 25;
export const SUPPORT_MAX_PAGE_SIZE = 100;

export const MemberQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  role: z.enum(MEMBER_ROLE_VALUES).optional(),
  status: z.enum(MEMBER_STATUS_VALUES).optional(),
  branch: z.uuid().optional(),
  sort: z.enum(MEMBER_SORT_VALUES).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
});

export type MemberQuery = z.infer<typeof MemberQuerySchema>;

export function parseMemberQuery(raw: Record<string, string | string[] | undefined>): MemberQuery {
  const pick = (key: string) => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };

  const parsed = MemberQuerySchema.safeParse({
    q: pick("q"),
    role: pick("role"),
    status: pick("status"),
    branch: pick("branch"),
    sort: pick("sort"),
    dir: pick("dir"),
    page: pick("page"),
  });

  if (parsed.success) {
    return parsed.data;
  }

  return MemberQuerySchema.parse({});
}

const PageParamSchema = z.coerce.number().int().min(1).default(1);

/** Shared bounded-page parser for the Activity and Audit tabs. */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = typeof raw === "string" ? raw : undefined;
  const parsed = PageParamSchema.safeParse(value);
  return parsed.success ? parsed.data : 1;
}

export const IdSchema = z.uuid();

// Phase 1O-D remediation — the search box on the minimal
// /internal/admin/actions lookup (the smallest safe navigation mechanism
// for a caller, e.g. BILLING, who holds a controlled-action permission but
// not platform.businesses.view). Mirrors
// list_platform_action_eligible_businesses' own server-side bounds exactly
// (20261002090000_harden_platform_billing_action_lookup.sql): a non-blank
// search below 3 characters is discarded here (treated the same as no
// search at all) rather than forwarded to the RPC, so the UI never shows a
// raw INVALID_SEARCH database error for a caller who is simply still
// typing.
export const PLATFORM_ACTION_SEARCH_MIN_LENGTH = 3;
const ActionSearchSchema = z.string().trim().max(200).optional();

export function parseActionSearch(raw: string | string[] | undefined): string | undefined {
  const value = typeof raw === "string" ? raw : undefined;
  const parsed = ActionSearchSchema.safeParse(value);
  if (!parsed.success || !parsed.data) return undefined;
  return parsed.data.length >= PLATFORM_ACTION_SEARCH_MIN_LENGTH ? parsed.data : undefined;
}
