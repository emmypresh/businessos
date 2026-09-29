import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import type { PlatformSupportQuery } from "@/lib/validation/platform-support";

// Every field here is exactly what public.list_platform_business_diagnostics
// returns (supabase/migrations/20261004080000_platform_audit_subscriptions_support.sql)
// — the seven frozen 1O-C diagnostic codes computed set-based across every
// business in one bounded pass, never one RPC call per business. The RPC
// itself re-verifies platform.businesses.view + AAL2 at the database layer.
export type PlatformDiagnosticRow = {
  business_id: string;
  business_name: string;
  code: string;
  severity: "WARNING" | "INFO";
  message: string;
  total_count: number;
};

export type PlatformSupportSummary = {
  businesses_requiring_attention: number;
  warnings: number;
  info: number;
  recent_whatsapp_failures: number;
};

export async function listPlatformBusinessDiagnostics(
  query: PlatformSupportQuery
): Promise<{ rows: PlatformDiagnosticRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = 25;

  const { data, error } = await supabase.rpc("list_platform_business_diagnostics", {
    p_page: query.page,
    p_page_size: pageSize,
    p_severity: query.severity ?? undefined,
    p_search: query.q ?? undefined,
  });

  if (error) {
    throw new Error(`Failed to load platform diagnostics: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformDiagnosticRow[];
  return { rows, totalCount: rows[0]?.total_count ?? 0, pageSize };
}

export async function getPlatformSupportSummary(): Promise<PlatformSupportSummary> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_platform_support_summary");
  if (error) {
    throw new Error(`Failed to load platform support summary: ${error.message}`);
  }

  return data as unknown as PlatformSupportSummary;
}
