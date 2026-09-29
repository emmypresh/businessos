import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";

// Every field here is exactly what public.get_platform_dashboard_overview
// returns (supabase/migrations/20261003080000_platform_dashboard_overview.sql)
// — see that migration's own header comment for each metric's exact
// definition. The RPC itself re-verifies platform.dashboard.view + AAL2 at
// the database layer; this module only shapes the call and its result.
export type PlatformDashboardOverview = {
  total_businesses: number;
  active_businesses: number;
  suspended_businesses: number;
  trialing_subscriptions: number;
  active_subscriptions: number;
  past_due_subscriptions: number;
  canceled_subscriptions: number;
  new_businesses_7d: number;
};

export async function getPlatformDashboardOverview(): Promise<PlatformDashboardOverview> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_platform_dashboard_overview");
  if (error) {
    throw new Error(`Failed to load platform dashboard overview: ${error.message}`);
  }

  return data as unknown as PlatformDashboardOverview;
}

export type PlatformRecentActionRow = {
  action_id: string;
  action_type: string;
  target_business_id: string;
  target_business_name: string;
  reason: string;
  actor_user_id: string;
  occurred_at: string;
  total_count: number;
};

/**
 * Deliberately returns `null` (never throws) when the caller lacks
 * platform.audit.view — matches listPlatformBusinessAudit/
 * listPlatformBusinessActions' own established convention (see
 * lib/platform/business-operations-dal.ts): the Overview page renders
 * without the Recent Platform Actions panel rather than erroring for a
 * businesses-view-only admin.
 */
export async function listPlatformRecentActions(
  pageSize = 8
): Promise<{ rows: PlatformRecentActionRow[]; totalCount: number } | null> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("list_platform_recent_actions", {
    p_page: 1,
    p_page_size: pageSize,
  });

  if (error) {
    if (error.message.includes("insufficient_privilege")) {
      return null;
    }
    throw new Error(`Failed to load recent platform actions: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformRecentActionRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0 };
}
