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

// Phase 1O-D — platform-staff action history. Distinct from
// PlatformBusinessAuditRow above: that type reads audit_events (what a
// TENANT user did); this one reads platform_action_audit (what
// BUSINESSOS STAFF did to this business) — see
// 20261001080000_platform_controlled_actions.sql's own header comment for
// why these are deliberately separate tables/trust domains.
export type PlatformBusinessActionRow = {
  action_id: string;
  action_type: string;
  actor_email: string | null;
  reason: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  occurred_at: string;
  total_count: number;
};

// Phase 1O-D remediation — minimal shape for the dedicated
// /internal/admin/businesses/[businessId]/actions route. Structurally a
// subset of PlatformBusinessOverview above (business_id/business_name/
// status/subscription{status,trial_ends_at}), so ActionsTab can accept
// either type without duplicating its own logic. Deliberately excludes
// slug, country/currency/timezone, owner_email, member/branch counts,
// branches, and diagnostics — none of which get_platform_business_action_context
// (gated on any controlled-action permission, never platform.businesses.view)
// returns.
export type PlatformBusinessActionContext = {
  business_id: string;
  business_name: string;
  status: string;
  subscription: { status: string; trial_ends_at: string | null } | null;
};

export type PlatformActionEligibleBusinessRow = {
  business_id: string;
  business_name: string;
  business_status: string;
  subscription_status: string | null;
  trial_ends_at: string | null;
  total_count: number;
};

// Gated on "caller holds at least one of the three controlled-action
// permissions" at the database layer (never platform.businesses.view) —
// see 20261002080000_platform_billing_action_access.sql. notFound() on a
// nonexistent business mirrors getPlatformBusinessOverview's own
// convention; an authorization failure surfaces as a thrown error mapped
// by lib/errors.ts at the call site, exactly like every other platform RPC
// wrapper in this module.
export async function getPlatformBusinessActionContext(
  businessId: string
): Promise<PlatformBusinessActionContext> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_platform_business_action_context", {
    p_business_id: businessId,
  });

  if (error) {
    throw new Error(`Failed to load business action context: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as PlatformBusinessActionContext;
}

// The smallest safe navigation mechanism for a caller (e.g. BILLING) who
// holds a controlled-action permission but not platform.businesses.view,
// and therefore cannot use the 1O-B business directory. Search-only, by
// name; returns only the same minimal fields as
// getPlatformBusinessActionContext above for every matching row — never
// members/branches/activity/audit.
// Phase 1O-D remediation — max page size for this RPC is 50, not the
// shared SUPPORT_MAX_PAGE_SIZE (100): a targeted, search-only lookup has no
// legitimate need for a wider page than the other support-console tabs
// (20261002090000_harden_platform_billing_action_lookup.sql).
const ACTION_LOOKUP_MAX_PAGE_SIZE = 50;

export async function listPlatformActionEligibleBusinesses(
  search: string | undefined,
  page: number
): Promise<{ rows: PlatformActionEligibleBusinessRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = Math.min(SUPPORT_DEFAULT_PAGE_SIZE, ACTION_LOOKUP_MAX_PAGE_SIZE);

  // A blank/missing search is passed straight through: the RPC itself
  // fails closed to zero rows rather than "all businesses" — this is not
  // an app-layer authorization boundary, it mirrors it for a fast, correct
  // empty state.
  const { data, error } = await supabase.rpc("list_platform_action_eligible_businesses", {
    p_search: search ?? undefined,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    throw new Error(`Failed to load action-eligible businesses: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformActionEligibleBusinessRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}

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

/**
 * Deliberately returns `null` (never throws) when the caller lacks
 * platform.audit.view — same convention as listPlatformBusinessAudit
 * above, and for the identical reason: an OPERATIONS/BILLING admin who can
 * PERFORM a controlled action does not automatically gain visibility into
 * the platform-wide action history (phase instructions §37 — a mutation
 * permission must never imply audit-read).
 */
export async function listPlatformBusinessActions(
  businessId: string,
  page: number
): Promise<{ rows: PlatformBusinessActionRow[]; totalCount: number; pageSize: number } | null> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = SUPPORT_DEFAULT_PAGE_SIZE;

  const { data, error } = await supabase.rpc("list_platform_business_actions", {
    p_business_id: businessId,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    if (error.message.includes("insufficient_privilege")) {
      return null;
    }
    throw new Error(`Failed to load platform action history: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformBusinessActionRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}
