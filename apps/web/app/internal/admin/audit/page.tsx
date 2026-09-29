import type { Metadata } from "next";
import { requirePlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { listPlatformAudit } from "@/lib/platform/audit-dal";
import { parsePlatformAuditQuery } from "@/lib/validation/platform-audit";
import { AuditFilters } from "@/components/platform/audit-filters";
import {
  PlatformSectionHeader,
  PlatformPanel,
  PlatformEmptyState,
  PlatformPagination,
} from "@/components/platform/platform-primitives";

export const metadata: Metadata = {
  title: "Platform Audit — Internal Administration",
};

const ACTION_LABEL: Record<string, string> = {
  SUSPEND_BUSINESS: "Suspended business",
  REACTIVATE_BUSINESS: "Reactivated business",
  EXTEND_TRIAL: "Extended trial",
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Platform Administrative Actions — deliberately not a claim to show every
// event in the whole product. Reads ONLY public.platform_action_audit (what
// BusinessOS staff did), never the tenant audit_events ledger, via
// public.list_platform_audit (supabase/migrations/
// 20261004080000_platform_audit_subscriptions_support.sql). Gated on
// platform.audit.view — the same permission the per-business Actions tab's
// history already requires; this is that same authorized viewer's
// platform-wide equivalent. No raw before/after JSON is ever fetched: the
// RPC already collapses it into a safe plain-text change_summary.
export default async function PlatformAuditPage({
  searchParams,
}: PageProps<"/internal/admin/audit">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.AUDIT_VIEW);

  const rawQuery = await searchParams;
  const query = parsePlatformAuditQuery(rawQuery);
  const { rows, totalCount, pageSize } = await listPlatformAudit(query);

  const urlSearchParams = new URLSearchParams();
  if (query.actionType) urlSearchParams.set("actionType", query.actionType);
  if (query.q) urlSearchParams.set("q", query.q);
  if (query.dateFrom) urlSearchParams.set("dateFrom", query.dateFrom);
  if (query.dateTo) urlSearchParams.set("dateTo", query.dateTo);

  const hasActiveFilters = Boolean(query.actionType || query.q || query.dateFrom || query.dateTo);

  return (
    <div className="flex flex-col gap-6">
      <PlatformSectionHeader
        title="Platform Audit"
        description="Bounded, read-only history of privileged platform-staff actions across every business."
      />

      <AuditFilters />

      <PlatformPanel title="Platform Administrative Actions" className="p-0">
        <div className="p-5">
          {rows.length === 0 ? (
            <PlatformEmptyState
              message={hasActiveFilters ? "No platform actions match your filters." : "No platform actions found."}
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {rows.map((row) => (
                <li key={row.action_id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{ACTION_LABEL[row.action_type] ?? row.action_type}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.target_business_name} &middot; {row.change_summary}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      by {row.actor_email ?? "unknown staff member"} — &ldquo;{row.reason}&rdquo;
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(row.occurred_at)}</span>
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
          noun="action"
          ariaLabel="Platform audit pagination"
        />
      ) : null}
    </div>
  );
}
