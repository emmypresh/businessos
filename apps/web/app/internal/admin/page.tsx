import {
  getPlatformRole,
  getMyPlatformPermissions,
  requirePlatformPermission,
} from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Intentionally minimal for 1O-A: authenticated platform role and current
// platform permissions, nothing else. No business/user/subscription
// directories or SaaS analytics — those are 1O-B/1O-C scope. Every nav
// destination below is either this page or omitted entirely; there is no
// clickable placeholder leading to an unbuilt screen.
//
// The layout above already proved "is a platform admin"
// (requirePlatformAdmin); this page is where AAL2 and the specific
// platform.dashboard.view permission are actually required — an AAL1
// admin never reaches this render, they're redirected to
// /internal/admin/mfa by requirePlatformPermission below.
export default async function InternalAdminOverviewPage() {
  await requirePlatformPermission(PLATFORM_PERMISSION.DASHBOARD_VIEW);

  const [role, permissions] = await Promise.all([
    getPlatformRole(),
    getMyPlatformPermissions(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Internal Administration</h2>
        <p className="text-sm text-muted-foreground">
          Platform-level access, separate from any business you belong to.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your platform role</CardTitle>
          <CardDescription>
            Assigned directly by a BusinessOS operator. Independent of any tenant role you hold.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Badge variant="secondary">{role ?? "None"}</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current permissions</CardTitle>
          <CardDescription>Read-only for this phase.</CardDescription>
        </CardHeader>
        <CardContent>
          {permissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No platform permissions granted.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {permissions.map((permission) => (
                <li key={permission} className="text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{permission}</code>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
