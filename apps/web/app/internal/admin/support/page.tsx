import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { listPlatformBusinessDiagnostics, getPlatformSupportSummary } from "@/lib/platform/support-dal";
import { parsePlatformSupportQuery } from "@/lib/validation/platform-support";
import { SupportFilters } from "@/components/platform/support-filters";
import {
  PlatformSectionHeader,
  PlatformStatCard,
  PlatformPanel,
  PlatformEmptyState,
  PlatformPagination,
} from "@/components/platform/platform-primitives";
import { AlertTriangle, Info, Building2, MessageCircleWarning } from "@/components/ui/icon";

export const metadata: Metadata = {
  title: "Support — Internal Administration",
};

const SEVERITY_TONE: Record<string, string> = {
  WARNING: "bg-kpi-orange-bg text-kpi-orange-fg",
  INFO: "bg-kpi-blue-bg text-kpi-blue-fg",
};

const SEVERITY_LABEL: Record<string, string> = {
  WARNING: "Warning",
  INFO: "Info",
};

// Businesses Requiring Attention — NOT a support-ticket system. Every row
// is one of the seven frozen 1O-C diagnostic codes
// (get_platform_business_overview's own established set), computed
// set-based across every business in one bounded pass via
// public.list_platform_business_diagnostics (supabase/migrations/
// 20261004080000_platform_audit_subscriptions_support.sql) — never one RPC
// call per business. Gated on platform.businesses.view — the existing
// permission, not a new platform.support.view minted for UI convenience.
export default async function PlatformSupportPage({
  searchParams,
}: PageProps<"/internal/admin/support">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW);

  const rawQuery = await searchParams;
  const query = parsePlatformSupportQuery(rawQuery);

  const [{ rows, totalCount, pageSize }, summary] = await Promise.all([
    listPlatformBusinessDiagnostics(query),
    getPlatformSupportSummary(),
  ]);

  const urlSearchParams = new URLSearchParams();
  if (query.severity) urlSearchParams.set("severity", query.severity);
  if (query.q) urlSearchParams.set("q", query.q);

  const hasActiveFilters = Boolean(query.severity || query.q);

  return (
    <div className="flex flex-col gap-6">
      <PlatformSectionHeader
        title="Support"
        description="Operational diagnostics across every business. Not a ticketing system — every row is a deterministic, schema-derived signal."
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <PlatformStatCard
          label="Businesses Requiring Attention"
          value={summary.businesses_requiring_attention}
          icon={<Building2 />}
        />
        <PlatformStatCard label="Warnings" value={summary.warnings} icon={<AlertTriangle />} />
        <PlatformStatCard label="Info" value={summary.info} icon={<Info />} />
        <PlatformStatCard
          label="Recent WhatsApp Failures"
          value={summary.recent_whatsapp_failures}
          hint="Failed WhatsApp messages in the last 7 days"
          icon={<MessageCircleWarning />}
        />
      </div>

      <SupportFilters />

      <PlatformPanel title="Attention Queue" className="p-0">
        <div className="p-5">
          {rows.length === 0 ? (
            <PlatformEmptyState
              message={
                hasActiveFilters
                  ? "No diagnostics match your filters."
                  : "No businesses currently require attention."
              }
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {rows.map((row) => (
                <li
                  key={`${row.business_id}-${row.code}`}
                  className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <Link href={`/internal/admin/businesses/${row.business_id}`} className="font-medium hover:underline">
                      {row.business_name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">{row.message}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[row.severity] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {SEVERITY_LABEL[row.severity] ?? row.severity} &middot; {row.code}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PlatformPanel>

      {rows.length > 0 ? (
        <PlatformPagination
          page={query.page}
          pageSize={pageSize}
          totalCount={totalCount}
          searchParams={urlSearchParams}
          noun="diagnostic"
          ariaLabel="Support diagnostics pagination"
        />
      ) : null}
    </div>
  );
}
