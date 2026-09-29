import type { Metadata } from "next";
import { requirePlatformAdmin, hasPlatformPermission, getPlatformRole } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { PlatformShell } from "@/components/platform/platform-shell";

export const metadata: Metadata = {
  title: "Internal Administration",
};

// The single entry gate for the entire /internal/admin surface, including
// the MFA challenge route (app/internal/admin/mfa/page.tsx): requires only
// "is this caller an active platform admin", not the specific
// platform.dashboard.view permission and not AAL2. Deliberately kept
// role-only here — an admin authenticated at AAL1 must still be able to
// reach /internal/admin/mfa to elevate, and gating this layout on AAL2
// would redirect that route to itself. The console page requires AAL2 and
// platform.dashboard.view itself, on top of this layout's gate, via
// requirePlatformPermission (see app/internal/admin/page.tsx and
// lib/platform/dal.ts for the full ordering rationale).
//
// notFound() (raised by requirePlatformAdmin) renders BusinessOS's
// existing not-found page — no distinguishable "you're logged in but not
// a platform admin" screen, so /internal/admin's existence is never
// revealed to a caller who lacks access. This is not a tenant workspace:
// it is intentionally NOT nested under /[businessId], and never reads or
// depends on any businessId param.
export default async function InternalAdminLayout({
  children,
}: LayoutProps<"/internal/admin">) {
  await requirePlatformAdmin();

  // Phase 1O-D remediation — shown only when the caller holds at least one
  // controlled-action permission, independent of platform.businesses.view.
  // This is the nav-visibility convenience for BILLING (which holds
  // platform.subscriptions.extend_trial but not businesses.view, and
  // therefore never sees "Businesses" lead anywhere useful): the actual
  // authorization boundary is requireAnyPlatformPermission on the
  // /internal/admin/actions route itself, not this link's visibility.
  const [canSuspend, canReactivate, canExtendTrial, role, canViewBusinesses, canViewSubscriptions, canViewAudit] =
    await Promise.all([
      hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_SUSPEND),
      hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_REACTIVATE),
      hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL),
      getPlatformRole(),
      hasPlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW),
      hasPlatformPermission(PLATFORM_PERMISSION.SUBSCRIPTIONS_VIEW),
      hasPlatformPermission(PLATFORM_PERMISSION.AUDIT_VIEW),
    ]);
  const canReachActions = canSuspend || canReactivate || canExtendTrial;

  // Every nav destination PlatformShell can render maps to a route that
  // actually exists. Support reuses platform.businesses.view (the phase
  // brief explicitly directs against minting a platform.support.view
  // permission for UI convenience — see the build brief §04). System
  // Health and Settings remain deferred: no monitoring backend and no real
  // platform settings model exist to back either page truthfully.
  return (
    <PlatformShell
      role={role}
      canReachActions={canReachActions}
      canViewBusinesses={canViewBusinesses}
      canViewSubscriptions={canViewSubscriptions}
      canViewAudit={canViewAudit}
    >
      {children}
    </PlatformShell>
  );
}
