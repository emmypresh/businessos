import Link from "next/link";
import { cn } from "@/lib/utils";
import { SUPPORT_TAB, type SupportTab } from "@/lib/validation/platform-business-operations";

const TAB_LABELS: Record<SupportTab, string> = {
  [SUPPORT_TAB.OVERVIEW]: "Overview",
  [SUPPORT_TAB.MEMBERS]: "Members",
  [SUPPORT_TAB.BRANCHES]: "Branches",
  [SUPPORT_TAB.SUBSCRIPTION]: "Subscription",
  [SUPPORT_TAB.ACTIVITY]: "Activity",
  [SUPPORT_TAB.DIAGNOSTICS]: "Diagnostics",
  [SUPPORT_TAB.AUDIT]: "Audit",
};

const TAB_ORDER: SupportTab[] = [
  SUPPORT_TAB.OVERVIEW,
  SUPPORT_TAB.MEMBERS,
  SUPPORT_TAB.BRANCHES,
  SUPPORT_TAB.SUBSCRIPTION,
  SUPPORT_TAB.ACTIVITY,
  SUPPORT_TAB.DIAGNOSTICS,
];

/**
 * URL-state tab navigation (?tab=) — deliberately plain server-rendered
 * links, not the client-side shadcn Tabs primitive, so the active tab's
 * content is the only thing the server ever fetches/renders (phase
 * instruction #35, "prefer active-tab data loading").
 *
 * The Audit tab only ever renders when `canViewAudit` is true — a
 * platform.businesses.view-only admin never sees it as a clickable
 * (or even visible) option, per phase instruction #28. This is UI
 * convenience only: list_platform_business_audit independently re-checks
 * platform.audit.view at the database layer regardless of what this
 * component renders.
 */
export function BusinessSupportTabs({
  businessId,
  activeTab,
  canViewAudit,
}: {
  businessId: string;
  activeTab: SupportTab;
  canViewAudit: boolean;
}) {
  const tabs = canViewAudit ? [...TAB_ORDER, SUPPORT_TAB.AUDIT] : TAB_ORDER;

  return (
    <nav aria-label="Business support sections" className="flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Link
            key={tab}
            href={`/internal/admin/businesses/${businessId}?tab=${tab}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-t-md px-3 py-2 text-sm font-medium underline-offset-4 hover:underline",
              isActive
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground"
            )}
          >
            {TAB_LABELS[tab]}
          </Link>
        );
      })}
    </nav>
  );
}
