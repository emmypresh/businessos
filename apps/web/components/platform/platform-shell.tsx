import Link from "next/link";
import { LayoutDashboard, Building2, ShieldCheck, LogOut, LifeBuoy, CreditCard, FileClock } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { logOut } from "@/lib/auth/actions";
import { SidebarNav, type NavSection } from "@/components/dashboard/sidebar-nav";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import type { PlatformRole } from "@/lib/platform/constants";

// The internal admin (Super Admin) console shell. Deliberately reuses the
// SAME SidebarNav/MobileNav components the tenant dashboard shell uses
// (components/dashboard/sidebar-nav.tsx, mobile-nav.tsx) — both are already
// generic (permission-filtered NavSection[] in, no tenant-specific logic
// inside), and phase instructions §33 direct against inventing a one-off
// abstraction where a working one already exists. Visual differentiation
// from the tenant shell comes entirely from the `.platform-shell` CSS scope
// (app/globals.css) — a fixed dark-charcoal sidebar with a violet/indigo
// accent, applied only inside this component's own subtree — never from a
// second nav implementation.
//
// UI hiding here is a convenience only: every route this links to
// independently re-verifies its own platform permission + AAL2 via
// requirePlatformPermission/requireAnyPlatformPermission (see
// app/internal/admin/layout.tsx's own header comment on this exact
// point). Nothing here decides authorization.
export function PlatformShell({
  role,
  canReachActions,
  canViewBusinesses,
  canViewSubscriptions,
  canViewAudit,
  children,
}: {
  role: PlatformRole | null;
  canReachActions: boolean;
  canViewBusinesses: boolean;
  canViewSubscriptions: boolean;
  canViewAudit: boolean;
  children: React.ReactNode;
}) {
  const sections: NavSection[] = [
    {
      items: [
        { href: "/internal/admin", label: "Overview", icon: <LayoutDashboard />, exact: true },
        // Businesses and Support both gate on platform.businesses.view —
        // reusing that existing permission rather than minting a
        // platform.support.view for UI convenience (build brief §04/§13 of
        // the completion-pass brief).
        ...(canViewBusinesses
          ? [
              { href: "/internal/admin/businesses", label: "Businesses", icon: <Building2 /> },
              { href: "/internal/admin/support", label: "Support", icon: <LifeBuoy /> },
            ]
          : []),
        ...(canViewSubscriptions
          ? [{ href: "/internal/admin/subscriptions", label: "Subscriptions", icon: <CreditCard /> }]
          : []),
        // Deliberately "Platform Audit", not "Audit" — the per-business
        // support console already has its own "Audit" tab
        // (components/platform/business-support-tabs.tsx), and both nav
        // surfaces are visible together on a business detail page.
        ...(canViewAudit
          ? [{ href: "/internal/admin/audit", label: "Platform Audit", icon: <FileClock /> }]
          : []),
        // Section 5 of the brief — a permanent broad nav item is not
        // appropriate for a narrow controlled-action surface; this link is
        // still gated exactly like the previous shell (see layout.tsx),
        // never widened to look like a directory entry point.
        ...(canReachActions
          ? [{ href: "/internal/admin/actions", label: "Actions", icon: <ShieldCheck /> }]
          : []),
      ],
    },
  ];

  return (
    <div className="platform-shell flex min-h-full flex-1 flex-col bg-background text-foreground md:flex-row">
      {/* Mobile top bar — sidebar becomes a drawer below md, matching the
          tenant shell's own established mobile pattern (dashboard-shell.tsx). */}
      <div className="flex items-center justify-between border-b bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-xs font-bold">
            OS
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">BusinessOS</p>
            <p className="truncate text-[11px] text-sidebar-foreground/60">Super Admin</p>
          </div>
        </div>
        <MobileNav sections={sections} businessName="BusinessOS · Super Admin" />
      </div>

      {/* Fixed desktop sidebar — dark charcoal + violet accent regardless of
          light/dark page mode (see globals.css's own comment on this
          deliberate "always-on console" identity). */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2.5 px-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
            OS
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">BusinessOS</p>
            <p className="truncate text-[11px] text-sidebar-foreground/60">Super Admin</p>
          </div>
        </div>
        <div className="mt-6">
          <SidebarNav sections={sections} />
        </div>
        <form action={logOut} className="mt-auto pt-8">
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2.5 text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
            Log out
          </Button>
        </form>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 hidden h-16 shrink-0 items-center justify-between border-b bg-card px-6 shadow-xs md:flex">
          <div className="flex min-w-0 items-center gap-3">
            {/* Deliberately NOT the literal text "Internal Administration" —
                that heading is the Overview page's own content (rendered
                only once the caller has passed AAL2 and reached the actual
                console), and this shell also wraps the AAL1 MFA challenge
                route (see layout.tsx). Duplicating that exact phrase into
                shared shell chrome would make it visible on the MFA page
                too, which tests/e2e/internal-admin.spec.ts explicitly
                asserts must NOT happen before AAL2. */}
            <Link
              href="/internal/admin"
              className="rounded-md px-1 py-0.5 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Platform Console
            </Link>
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              title="Derived from NODE_ENV / VERCEL_ENV at render time"
            >
              {process.env.NODE_ENV === "production" ? "Production" : "Development"}
            </span>
          </div>
          <div className="flex items-center gap-3 border-l pl-3">
            <span className="text-xs text-muted-foreground">{role ?? "No role"}</span>
          </div>
        </header>
        <main className="flex-1 overflow-x-auto bg-background p-4 sm:p-6 md:p-8">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
