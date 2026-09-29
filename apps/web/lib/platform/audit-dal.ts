import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import type { PlatformAuditQuery } from "@/lib/validation/platform-audit";

// Every field here is exactly what public.list_platform_audit returns
// (supabase/migrations/20261004080000_platform_audit_subscriptions_support.sql)
// — the RPC itself re-verifies platform.audit.view + AAL2 at the database
// layer. before_state/after_state are never fetched at all: the RPC already
// collapses them into a safe plain-text change_summary server-side.
export type PlatformAuditRow = {
  action_id: string;
  action_type: string;
  actor_email: string | null;
  target_business_id: string;
  target_business_name: string;
  reason: string;
  change_summary: string;
  occurred_at: string;
  total_count: number;
};

export async function listPlatformAudit(
  query: PlatformAuditQuery
): Promise<{ rows: PlatformAuditRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = 25;

  const { data, error } = await supabase.rpc("list_platform_audit", {
    p_page: query.page,
    p_page_size: pageSize,
    p_action_type: query.actionType ?? undefined,
    p_business_search: query.q ?? undefined,
    // dateFrom is local midnight of that day; dateTo is pushed to the last
    // instant of that day so the filter is inclusive of the whole end date.
    p_date_from: query.dateFrom ? `${query.dateFrom}T00:00:00.000Z` : undefined,
    p_date_to: query.dateTo ? `${query.dateTo}T23:59:59.999Z` : undefined,
  });

  if (error) {
    throw new Error(`Failed to load platform audit log: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformAuditRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}
