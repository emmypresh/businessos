import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import type { PlatformSubscriptionQuery } from "@/lib/validation/platform-subscriptions";

// Every field here is exactly what public.list_platform_subscriptions
// returns (supabase/migrations/20261004080000_platform_audit_subscriptions_support.sql)
// — the RPC itself re-verifies platform.subscriptions.view + AAL2 at the
// database layer. No provider reference, payment token, or webhook payload
// field exists here — private_platform_directory_reader was never granted
// those columns on business_subscriptions in the first place.
export type PlatformSubscriptionRow = {
  business_id: string;
  business_name: string;
  plan_code: string | null;
  plan_name: string | null;
  status: string;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  total_count: number;
};

export async function listPlatformSubscriptions(
  query: PlatformSubscriptionQuery
): Promise<{ rows: PlatformSubscriptionRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = 25;

  const { data, error } = await supabase.rpc("list_platform_subscriptions", {
    p_page: query.page,
    p_page_size: pageSize,
    p_search: query.q ?? undefined,
    p_status: query.status ?? undefined,
  });

  if (error) {
    throw new Error(`Failed to load platform subscriptions: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformSubscriptionRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}
