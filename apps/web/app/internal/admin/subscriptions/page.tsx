import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformPermission, hasPlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { listPlatformSubscriptions } from "@/lib/platform/subscriptions-dal";
import { getPlatformDashboardOverview } from "@/lib/platform/dashboard-dal";
import { parsePlatformSubscriptionQuery } from "@/lib/validation/platform-subscriptions";
import { SubscriptionFilters } from "@/components/platform/subscription-filters";
import {
  PlatformSectionHeader,
  PlatformStatCard,
  PlatformPanel,
  PlatformEmptyState,
  PlatformStatusBadge,
  PlatformPagination,
} from "@/components/platform/platform-primitives";
import { CheckCircle2, Clock, AlertTriangle, XCircle } from "lucide-react";

export const metadata: Metadata = {
  title: "Subscriptions — Internal Administration",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Read-only platform subscription overview. Gated on
// platform.subscriptions.view. The ONLY subscription mutation anywhere in
// the product remains platform_extend_trial (1O-D), reached through the
// frozen /internal/admin/businesses/[businessId]/actions route — this page
// never duplicates that logic, it only links to it when the caller ALSO
// holds platform.subscriptions.extend_trial.
export default async function PlatformSubscriptionsPage({
  searchParams,
}: PageProps<"/internal/admin/subscriptions">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_VIEW);

  const rawQuery = await searchParams;
  const query = parsePlatformSubscriptionQuery(rawQuery);

  const [{ rows, totalCount, pageSize }, overview, canExtendTrial] = await Promise.all([
    listPlatformSubscriptions(query),
    getPlatformDashboardOverview(),
    hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL),
  ]);

  const urlSearchParams = new URLSearchParams();
  if (query.q) urlSearchParams.set("q", query.q);
  if (query.status) urlSearchParams.set("status", query.status);

  const hasActiveFilters = Boolean(query.q || query.status);

  return (
    <div className="flex flex-col gap-6">
      <PlatformSectionHeader
        title="Subscriptions"
        description="Read-only platform subscription overview. Extend Trial remains the only mutation, via the frozen controlled-action flow."
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <PlatformStatCard label="Active" value={overview.active_subscriptions} icon={<CheckCircle2 />} />
        <PlatformStatCard label="Trialing" value={overview.trialing_subscriptions} icon={<Clock />} />
        <PlatformStatCard label="Past Due" value={overview.past_due_subscriptions} icon={<AlertTriangle />} />
        <PlatformStatCard label="Canceled" value={overview.canceled_subscriptions} icon={<XCircle />} />
      </div>

      <SubscriptionFilters />

      {/* Not "Subscriptions" — the page's own h1 title above already is,
          and a second heading with the identical accessible name makes
          getByRole("heading", { name: "Subscriptions" }) ambiguous
          (confirmed by running the e2e a11y/functional specs). */}
      <PlatformPanel title="All Subscriptions" className="p-0">
        <div className="p-5">
          {rows.length === 0 ? (
            <PlatformEmptyState
              message={hasActiveFilters ? "No subscriptions match this view." : "No subscriptions found."}
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {rows.map((row) => (
                <li
                  key={row.business_id}
                  className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <Link href={`/internal/admin/businesses/${row.business_id}`} className="font-medium hover:underline">
                      {row.business_name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.plan_name ?? "No plan"} &middot; Trial ends {formatDate(row.trial_ends_at)} &middot; Period ends{" "}
                      {formatDate(row.current_period_ends_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <PlatformStatusBadge status={row.status} />
                    {canExtendTrial && row.status === "TRIALING" ? (
                      <Link
                        href={`/internal/admin/businesses/${row.business_id}/actions`}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Extend Trial
                      </Link>
                    ) : null}
                  </div>
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
          noun="subscription"
          ariaLabel="Subscriptions pagination"
        />
      ) : null}
    </div>
  );
}
