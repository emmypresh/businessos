import type { Metadata } from "next";
import { requirePlatformAdmin } from "@/lib/platform/dal";

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

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b bg-muted/40">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              BusinessOS Internal
            </p>
            <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
