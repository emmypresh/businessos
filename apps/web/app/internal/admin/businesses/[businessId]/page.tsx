import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePlatformPermission, hasPlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { getPlatformBusinessOverview } from "@/lib/platform/business-operations-dal";
import { IdSchema, SUPPORT_TAB, parseSupportTab, parseMemberQuery, parsePageParam } from "@/lib/validation/platform-business-operations";
import { BusinessSupportTabs } from "@/components/platform/business-support-tabs";
import { OverviewTab } from "@/components/platform/overview-tab";
import { BranchesTab } from "@/components/platform/branches-tab";
import { SubscriptionTab } from "@/components/platform/subscription-tab";
import { DiagnosticsTab } from "@/components/platform/diagnostics-tab";
import { MembersTab } from "@/components/platform/members-tab";
import { ActivityTab } from "@/components/platform/activity-tab";
import { AuditTab } from "@/components/platform/audit-tab";
import { ActionsTab } from "@/components/platform/actions-tab";

export const metadata: Metadata = {
  title: "Business detail — Internal Administration",
};

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

// Support console shell (Phase 1O-C). The page shell itself requires only
// platform.businesses.view + AAL2 (requirePlatformPermission below) —
// every tab except Audit reuses that same permission (overview data is
// fetched once, here, and handed to the Overview/Branches/Subscription/
// Diagnostics tabs, which all read from the same bounded RPC result rather
// than issuing four separate calls). Members/Activity/Audit each load only
// on their own active tab (phase instruction #35: prefer active-tab data
// loading, never fetch all tabs' data up front).
//
// A malformed businessId, a nonexistent business, and (structurally,
// before this page ever renders) an unauthorized caller all resolve to the
// same 404 — mirrors the frozen 1O-B detail page's own convention exactly.
export default async function PlatformBusinessDetailPage({
  params,
  searchParams,
}: PageProps<"/internal/admin/businesses/[businessId]">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW);

  const { businessId } = await params;
  const parsedId = IdSchema.safeParse(businessId);
  if (!parsedId.success) {
    notFound();
  }

  const rawSearchParams = await searchParams;
  const activeTab = parseSupportTab(rawSearchParams.tab);
  const urlSearchParams = toSearchParams(rawSearchParams);

  const canViewAudit = await hasPlatformPermission(PLATFORM_PERMISSION.AUDIT_VIEW);
  const canSuspend = await hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_SUSPEND);
  const canReactivate = await hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_REACTIVATE);
  const canExtendTrial = await hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL);
  const canViewActions = canSuspend || canReactivate || canExtendTrial || canViewAudit;

  const overview = await getPlatformBusinessOverview(parsedId.data);

  let tabContent: React.ReactNode;
  switch (activeTab) {
    case SUPPORT_TAB.MEMBERS: {
      const query = parseMemberQuery(rawSearchParams);
      tabContent = (
        <MembersTab businessId={parsedId.data} query={query} searchParams={urlSearchParams} />
      );
      break;
    }
    case SUPPORT_TAB.BRANCHES:
      tabContent = <BranchesTab overview={overview} />;
      break;
    case SUPPORT_TAB.SUBSCRIPTION:
      tabContent = <SubscriptionTab overview={overview} />;
      break;
    case SUPPORT_TAB.ACTIVITY: {
      const page = parsePageParam(rawSearchParams.page);
      tabContent = (
        <ActivityTab businessId={parsedId.data} page={page} searchParams={urlSearchParams} />
      );
      break;
    }
    case SUPPORT_TAB.DIAGNOSTICS:
      tabContent = <DiagnosticsTab overview={overview} />;
      break;
    case SUPPORT_TAB.AUDIT: {
      // Defense in depth: even a tampered ?tab=audit URL from a
      // businesses-view-only admin renders AuditTab, which independently
      // re-checks platform.audit.view at the RPC layer and shows an
      // "unavailable" message rather than any audit data — see AuditTab's
      // own header comment.
      const page = parsePageParam(rawSearchParams.page);
      tabContent = (
        <AuditTab businessId={parsedId.data} page={page} searchParams={urlSearchParams} />
      );
      break;
    }
    case SUPPORT_TAB.ACTIONS: {
      // Defense in depth: even a tampered ?tab=actions URL from a caller
      // with none of the underlying permissions renders ActionsTab, which
      // independently re-checks each permission before rendering any
      // control or history — mirrors AuditTab's own convention exactly.
      const page = parsePageParam(rawSearchParams.page);
      tabContent = (
        <ActionsTab
          businessId={parsedId.data}
          overview={overview}
          page={page}
          searchParams={urlSearchParams}
          canSuspend={canSuspend}
          canReactivate={canReactivate}
          canExtendTrial={canExtendTrial}
          canViewHistory={canViewAudit}
          showDedicatedRouteLink
        />
      );
      break;
    }
    case SUPPORT_TAB.OVERVIEW:
    default:
      tabContent = <OverviewTab overview={overview} />;
      break;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/internal/admin/businesses"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; Businesses
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{overview.business_name}</h1>
        <p className="text-sm text-muted-foreground">{overview.slug}</p>
      </div>

      <BusinessSupportTabs
        businessId={parsedId.data}
        activeTab={activeTab}
        canViewAudit={canViewAudit}
        canViewActions={canViewActions}
      />

      {tabContent}
    </div>
  );
}
