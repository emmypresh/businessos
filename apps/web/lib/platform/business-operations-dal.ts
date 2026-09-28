import "server-only";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import {
  SUPPORT_DEFAULT_PAGE_SIZE,
  SUPPORT_MAX_PAGE_SIZE,
  type MemberQuery,
} from "@/lib/validation/platform-business-operations";

// Every field here is exactly what the corresponding 1O-C RPC returns
// (supabase/migrations/20260930080000_platform_business_operational_intelligence.sql)
// — never a broader shape. Each RPC independently re-verifies its own
// platform permission at the database layer; this module only shapes the
// call and its result for the page/components, and never itself decides
// authorization.

export type PlatformBusinessOverview = {
  business_id: string;
  business_name: string;
  slug: string;
  status: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  created_at: string;
  owner_email: string | null;
  has_active_owner: boolean;
  member_count: number;
  branch_count: number;
  active_branch_count: number;
  subscription: {
    plan_code: string | null;
    plan_name: string | null;
    status: string;
    trial_ends_at: string | null;
    current_period_ends_at: string | null;
    cancel_at_period_end: boolean;
  } | null;
  branches: Array<{
    branch_id: string;
    name: string;
    code: string | null;
    status: string;
    created_at: string;
    member_count: number;
  }>;
  diagnostics: Array<{ code: string; severity: "OK" | "INFO" | "WARNING"; message: string }>;
};

export type PlatformBusinessMemberRow = {
  member_id: string;
  email: string | null;
  role: string;
  status: string;
  primary_branch_id: string | null;
  primary_branch_name: string | null;
  created_at: string;
  total_count: number;
};

export type PlatformBusinessActivityRow = {
  occurred_at: string | null;
  category: string;
  summary: string;
  reference_id: string;
  branch_name: string | null;
  actor_email: string | null;
  total_count: number;
};

export type PlatformBusinessAuditRow = {
  occurred_at: string;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_ref: string | null;
  summary: string;
  total_count: number;
};

export async function getPlatformBusinessOverview(
  businessId: string
): Promise<PlatformBusinessOverview> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_platform_business_overview", {
    p_business_id: businessId,
  });

  if (error) {
    throw new Error(`Failed to load business overview: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as PlatformBusinessOverview;
}

export async function listPlatformBusinessMembers(
  businessId: string,
  query: MemberQuery
): Promise<{ rows: PlatformBusinessMemberRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = SUPPORT_DEFAULT_PAGE_SIZE;

  const { data, error } = await supabase.rpc("list_platform_business_members", {
    p_business_id: businessId,
    p_search: query.q ?? undefined,
    p_role: query.role ?? undefined,
    p_status: query.status ?? undefined,
    p_branch_id: query.branch ?? undefined,
    p_sort: query.sort,
    p_dir: query.dir,
    p_page: query.page,
    p_page_size: Math.min(pageSize, SUPPORT_MAX_PAGE_SIZE),
  });

  if (error) {
    throw new Error(`Failed to load business members: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformBusinessMemberRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}

export async function listPlatformBusinessActivity(
  businessId: string,
  page: number
): Promise<{ rows: PlatformBusinessActivityRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = SUPPORT_DEFAULT_PAGE_SIZE;

  const { data, error } = await supabase.rpc("list_platform_business_activity", {
    p_business_id: businessId,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    throw new Error(`Failed to load business activity: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformBusinessActivityRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}

/**
 * Deliberately returns `null` (never throws) when the caller lacks
 * platform.audit.view — see requirePlatformPermission's own "UI hiding is
 * convenience only, RPC re-checks independently" convention. A businesses-
 * view-only admin therefore sees an unavailable Audit tab rather than an
 * error boundary, matching phase instruction #3 ("must NOT cause the whole
 * business page to 404 / break other tabs").
 */
export async function listPlatformBusinessAudit(
  businessId: string,
  page: number
): Promise<{ rows: PlatformBusinessAuditRow[]; totalCount: number; pageSize: number } | null> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = SUPPORT_DEFAULT_PAGE_SIZE;

  const { data, error } = await supabase.rpc("list_platform_business_audit", {
    p_business_id: businessId,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    if (error.message.includes("insufficient_privilege")) {
      return null;
    }
    throw new Error(`Failed to load business audit history: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformBusinessAuditRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}
