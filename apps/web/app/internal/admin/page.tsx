import {
  getMyPlatformPermissions,
  requirePlatformPermission,
  hasPlatformPermission,
} from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { getPlatformDashboardOverview, listPlatformRecentActions } from "@/lib/platform/dashboard-dal";
import { listPlatformBusinesses } from "@/lib/platform/businesses-dal";
import { getPlatformSupportSummary } from "@/lib/platform/support-dal";
import { parsePlatformBusinessQuery } from "@/lib/validation/platform-businesses";
import {
  PlatformSectionHeader,
  PlatformStatCard,
  PlatformPanel,
  PlatformEmptyState,
  PlatformStatusBadge,
} from "@/components/platform/platform-primitives";
import { Building2, CheckCircle2, PauseCircle, CreditCard, TrendingUp } from "lucide-react";
import Link from "next/link";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function actionLabel(actionType: string): string {
  switch (actionType) {
    case "SUSPEND_BUSINESS":
      return "Suspended business";
    case "REACTIVATE_BUSINESS":
      return "Reactivated business";
    case "EXTEND_TRIAL":
      return "Extended trial";
    default:
      return actionType;
  }
}

// The primary platform overview. Every number rendered here has an exact,
// written definition in apps/web/docs/phase-1o-e-internal-admin-dashboard-final-ux-security-build-brief.md
// (section 05) and comes from public.get_platform_dashboard_overview /
// public.list_platform_recent_actions (supabase/migrations/
// 20261003080000_platform_dashboard_overview.sql) — never a client-side
// guess or a hardcoded placeholder. Monthly Revenue, Open Support Cases,
// and System Health are deliberately NOT rendered anywhere on this page —
// see the same build-brief section for exactly why each is omitted.
export default async function InternalAdminOverviewPage() {
  await requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW);

  const [permissions, overview, canViewBusinesses] = await Promise.all([
    getMyPlatformPermissions(),
    getPlatformDashboardOverview(),
    hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW),
  ]);

  // listPlatformRecentActions/listPlatformBusinesses/getPlatformSupportSummary
  // independently re-check their own platform permission at the database
  // layer and return null (or, for the summary, throw — see the try/catch)
  // for a caller who lacks it — the canViewBusinesses / permissions.includes
  // checks here are rendering convenience only, not the authorization
  // boundary.
  const [recentActions, directorySnapshot, supportSummary] = await Promise.all([
    permissions.includes(PLATFORM_PERMISSION.AUDIT_VIEW) ? listPlatformRecentActions(6) : Promise.resolve(null),
    canViewBusinesses ? listPlatformBusinesses(parsePlatformBusinessQuery({})) : Promise.resolve(null),
    canViewBusinesses ? getPlatformSupportSummary() : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {/* This exact heading text is asserted by tests/e2e/internal-admin.spec.ts
          as proof the caller has actually reached the AAL2-gated console
          (never visible pre-AAL2 — see platform-shell.tsx's own comment on
          why the shared shell chrome deliberately does not repeat it). */}
      <PlatformSectionHeader
        title="Internal Administration"
        description="Overview — platform-wide operational snapshot, permission-scoped to your platform role."
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <PlatformStatCard
          label="Total Businesses"
          value={overview.total_businesses}
          hint="Excludes archived"
          icon={<Building2 />}
        />
        <PlatformStatCard
          label="Active Businesses"
          value={overview.active_businesses}
          hint="status = active"
          icon={<CheckCircle2 />}
        />
        <PlatformStatCard
          label="Suspended"
          value={overview.suspended_businesses}
          hint="status = suspended"
          icon={<PauseCircle />}
        />
        <PlatformStatCard
          label="Active Subscriptions"
          value={overview.active_subscriptions}
          hint={`${overview.trialing_subscriptions} trialing`}
          icon={<CreditCard />}
        />
        <PlatformStatCard
          label="New Businesses (7d)"
          value={overview.new_businesses_7d}
          hint="Rolling 7-day window"
          icon={<TrendingUp />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlatformPanel
          title="Subscription Overview"
          description="Subscription status distribution across every business."
          action={
            permissions.includes(PLATFORM_PERMISSION.SUBSCRIPTIONS_VIEW) ? (
              <Link href="/internal/admin/subscriptions" className="text-sm font-medium text-primary hover:underline">
                Subscription details
              </Link>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-4 gap-4 text-center">
            <div>
              <dt className="text-xs text-muted-foreground">Active</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{overview.active_subscriptions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Trialing</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{overview.trialing_subscriptions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Past Due</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{overview.past_due_subscriptions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Canceled</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{overview.canceled_subscriptions}</dd>
            </div>
          </dl>
        </PlatformPanel>

        <PlatformPanel
          title="Recent Platform Actions"
          description="Privileged staff actions across all businesses. Requires platform.audit.view."
          action={
            permissions.includes(PLATFORM_PERMISSION.AUDIT_VIEW) ? (
              <Link href="/internal/admin/audit" className="text-sm font-medium text-primary hover:underline">
                Full history
              </Link>
            ) : undefined
          }
        >
          {recentActions === null ? (
            <PlatformEmptyState message="You do not have permission to view platform action history." />
          ) : recentActions.rows.length === 0 ? (
            <PlatformEmptyState message="No recent platform actions." />
          ) : (
            <ul className="flex flex-col divide-y">
              {recentActions.rows.map((row) => (
                <li key={row.action_id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{actionLabel(row.action_type)}</p>
                    <p className="truncate text-xs text-muted-foreground">{row.target_business_name}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(row.occurred_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </PlatformPanel>
      </div>

      {supportSummary ? (
        <PlatformPanel
          title="Support Snapshot"
          description="Businesses requiring attention, from the same operational diagnostics as the Support page."
          action={
            <Link href="/internal/admin/support" className="text-sm font-medium text-primary hover:underline">
              Attention queue
            </Link>
          }
        >
          <dl className="grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Requiring Attention</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {supportSummary.businesses_requiring_attention}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Warnings</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{supportSummary.warnings}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Info</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{supportSummary.info}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">WhatsApp Failures</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{supportSummary.recent_whatsapp_failures}</dd>
            </div>
          </dl>
        </PlatformPanel>
      ) : null}

      <PlatformPanel
        title="Business Directory Snapshot"
        description="Most recently created businesses."
        action={
          canViewBusinesses ? (
            // Deliberately not the phrase "...businesses" — the existing
            // e2e suite (tests/e2e/internal-admin-businesses.spec.ts,
            // internal-admin-business-support.spec.ts) does
            // getByRole("link", { name: "Businesses" }) against the sidebar
            // nav item, and Playwright's default name matching is a
            // case-insensitive substring match: "View all businesses" would
            // make that query ambiguous (strict-mode violation) between
            // this panel link and the nav link. Confirmed by running both
            // specs against this page.
            <Link href="/internal/admin/businesses" className="text-sm font-medium text-primary hover:underline">
              Open directory
            </Link>
          ) : undefined
        }
      >
        {directorySnapshot === null ? (
          <PlatformEmptyState message="You do not have permission to view the business directory." />
        ) : directorySnapshot.rows.length === 0 ? (
          <PlatformEmptyState message="No businesses yet." />
        ) : (
          <ul className="flex flex-col divide-y">
            {directorySnapshot.rows.slice(0, 8).map((row) => (
              <li key={row.business_id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link
                    href={`/internal/admin/businesses/${row.business_id}`}
                    className="truncate font-medium hover:underline"
                  >
                    {row.business_name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.member_count} members · {row.active_branch_count} active branches
                  </p>
                </div>
                <PlatformStatusBadge status={row.status} />
              </li>
            ))}
          </ul>
        )}
      </PlatformPanel>
    </div>
  );
}
