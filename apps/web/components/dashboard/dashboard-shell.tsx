import {
  LayoutDashboard,
  Users,
  Package,
  Boxes,
  LogOut,
  UserRound,
  Receipt,
  Wallet,
  ListTree,
  LineChart,
  Building2,
  IdCard,
  FileText,
  Undo2,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { logOut } from "@/lib/auth/actions";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { SidebarNav, type NavSection } from "@/components/dashboard/sidebar-nav";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { getUnreadNotificationCount } from "@/lib/notifications/dal";
import type { MembershipRow } from "@/lib/business/dal";

export async function DashboardShell({
  membership,
  children,
}: {
  membership: MembershipRow;
  children: React.ReactNode;
}) {
  const business = membership.businesses;
  const businessId = membership.business_id;

  // Phase 1K: permissionless — every active member gets a bell, gated
  // only on the SAME active membership this whole shell already requires
  // (see lib/notifications/dal.ts's own header comment for why no
  // operational permission is involved).
  const unreadNotificationCount = await getUnreadNotificationCount(businessId);

  // Nav visibility only — a courtesy, not a security boundary. Every
  // route this links to independently re-verifies the same permission
  // server-side (requirePermissionOrNotFound), and every mutation
  // independently re-verifies its own (see lib/products/actions.ts,
  // lib/inventory/actions.ts, lib/branches/actions.ts, lib/staff/actions.ts).
  const permissions = await getPermissions(businessId);
  const canViewProducts = permissions.has(PERMISSION.PRODUCTS_VIEW);
  const canViewInventory = permissions.has(PERMISSION.INVENTORY_VIEW);
  const canViewCustomers = permissions.has(PERMISSION.CUSTOMERS_VIEW);
  const canViewSales = permissions.has(PERMISSION.SALES_VIEW);
  const canCreateSales = permissions.has(PERMISSION.SALES_CREATE);
  // Never assumed from a role name, and never assumed from another
  // permission (customers.manage does NOT imply sales.create,
  // sales.create does NOT imply customers.manage, sales.view does NOT
  // imply customers.view — even though the current seeded role matrix
  // happens to grant them together for every role that has any of them).
  // A caller with sales.create but not sales.view links straight to
  // "New sale" instead of an inaccessible list page.
  const salesHref = canViewSales ? `/${businessId}/sales` : `/${businessId}/sales/new`;

  // Phase 1I. returns.manage does NOT imply returns.view (and the reverse
  // doesn't hold either) — a manage-only caller links straight to "New
  // return" instead of the list page, which independently requires
  // returns.view and would 404 them, mirroring the sales/invoices/expenses
  // nav links' own identical pattern above. Returns lives under
  // Operations, not Finance — the initiating workflow is tied to a sale
  // and its stock, even though the refund itself has a financial effect
  // (see this phase's own product brief).
  const canViewReturns = permissions.has(PERMISSION.RETURNS_VIEW);
  const canManageReturns = permissions.has(PERMISSION.RETURNS_MANAGE);
  const returnsHref = canViewReturns ? `/${businessId}/returns` : `/${businessId}/returns/new`;

  // Phase 1E. expenses.manage does NOT imply expenses.view (and the
  // reverse doesn't hold either) — a manage-only caller links straight to
  // "New expense" instead of the list page, which independently requires
  // expenses.view and would 404 them. Mirrors the sales nav link's own
  // reasoning exactly. The category-management route is reachable on
  // EITHER permission (matches expense_categories' own SELECT policy), so
  // it is shown whenever either one is held.
  const canViewExpenses = permissions.has(PERMISSION.EXPENSES_VIEW);
  const canManageExpenses = permissions.has(PERMISSION.EXPENSES_MANAGE);
  const expensesHref = canViewExpenses ? `/${businessId}/expenses` : `/${businessId}/expenses/new`;
  const canViewReports = permissions.has(PERMISSION.REPORTS_VIEW);

  // Phase 1H remediation, Medium 6: Invoices was absent from navigation
  // entirely. invoices.manage does NOT imply invoices.view (see
  // 20260831080600_invoice_payment_permissions.sql's own header comment
  // on why ACCOUNTANT/SALES-tier roles can diverge on these two keys) —
  // a manage-only caller links straight to "New invoice" instead of the
  // list page, which independently requires invoices.view and would 404
  // them, mirroring the expenses/branches/staff nav links' own identical
  // pattern above.
  const canViewInvoices = permissions.has(PERMISSION.INVOICES_VIEW);
  const canManageInvoices = permissions.has(PERMISSION.INVOICES_MANAGE);
  const invoicesHref = canViewInvoices ? `/${businessId}/invoices` : `/${businessId}/invoices/new`;

  // Phase 1F. branches.manage does NOT imply branches.view — a manage-only
  // caller links straight to "New branch" instead of the list, which
  // independently requires branches.view and would 404 them. staff.invite
  // does NOT imply staff.view either — an invite-only caller links
  // straight to the invite form, never the staff list (which would 404
  // them, and which would also — separately — leak the invitation tab to
  // someone who never asked to see the roster). staff.view alone does
  // NOT surface an invite entry point; only staff.invite does.
  const canViewBranches = permissions.has(PERMISSION.BRANCHES_VIEW);
  const canManageBranches = permissions.has(PERMISSION.BRANCHES_MANAGE);
  const branchesHref = canViewBranches ? `/${businessId}/branches` : `/${businessId}/branches/new`;
  const canViewStaff = permissions.has(PERMISSION.STAFF_VIEW);
  const canInviteStaff = permissions.has(PERMISSION.STAFF_INVITE);
  // Codex adversarial review, application-layer round 2: an invite-only
  // caller (staff.invite, no staff.view) now lands on the independent
  // /staff/invitations route — reachable on staff.invite alone, and a
  // genuinely useful destination (it lists what they've already sent,
  // with its own link through to /staff/invite) — rather than being
  // dropped straight into a blank create form with no way back to see
  // what they've done.
  const staffHref = canViewStaff ? `/${businessId}/staff` : `/${businessId}/staff/invitations`;

  // Phase 1J. There is no manage-without-view split here at all —
  // audit.view is the ONLY permission (no audit.manage exists), so this
  // is a plain boolean, unlike every other nav link above.
  const canViewAudit = permissions.has(PERMISSION.AUDIT_VIEW);

  // Icons are rendered into ELEMENTS here (`<Package />`, not the bare
  // `Package` component reference) — see sidebar-nav.tsx's own NavItem
  // comment for why: this array crosses a Server -> Client Component
  // boundary (SidebarNav/MobileNav), and only already-rendered elements
  // (never raw component/function references) can cross that boundary.
  const sections: NavSection[] = [
    { items: [{ href: `/${businessId}`, label: "Overview", icon: <LayoutDashboard />, exact: true }] },
    {
      label: "Operations",
      items: [
        ...(canViewSales || canCreateSales ? [{ href: salesHref, label: "Sales", icon: <Receipt /> }] : []),
        ...(canViewReturns || canManageReturns ? [{ href: returnsHref, label: "Returns", icon: <Undo2 /> }] : []),
        ...(canViewCustomers ? [{ href: `/${businessId}/customers`, label: "Customers", icon: <UserRound /> }] : []),
        ...(canViewProducts ? [{ href: `/${businessId}/products`, label: "Products", icon: <Package /> }] : []),
        ...(canViewInventory ? [{ href: `/${businessId}/inventory`, label: "Inventory", icon: <Boxes /> }] : []),
      ],
    },
    {
      label: "Finance",
      items: [
        ...(canViewInvoices || canManageInvoices
          ? [{ href: invoicesHref, label: "Invoices", icon: <FileText /> }]
          : []),
        ...(canViewExpenses || canManageExpenses
          ? [
              { href: expensesHref, label: "Expenses", icon: <Wallet /> },
              { href: `/${businessId}/expenses/categories`, label: "Categories", icon: <ListTree />, nested: true },
            ]
          : []),
        ...(canViewReports ? [{ href: `/${businessId}/reports`, label: "Reports", icon: <LineChart /> }] : []),
      ],
    },
    {
      label: "Organization",
      items: [
        { href: `/${businessId}/members`, label: "Members", icon: <Users /> },
        ...(canViewBranches || canManageBranches ? [{ href: branchesHref, label: "Branches", icon: <Building2 /> }] : []),
        ...(canViewStaff || canInviteStaff ? [{ href: staffHref, label: "Staff", icon: <IdCard /> }] : []),
        ...(canViewAudit ? [{ href: `/${businessId}/activity`, label: "Activity", icon: <Activity /> }] : []),
      ],
    },
  ].filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      {/* Mobile top bar — sidebar becomes a drawer below md, triggered from
          here. Kept deliberately minimal: business name + menu trigger, no
          branch selector (Phase 1F branches do not yet scope any other
          module's data — see the [businessId]/layout.tsx comment — so no
          UI here should imply otherwise). The role label is deliberately
          NOT repeated here — Tailwind's `md:hidden` only hides this bar
          visually at desktop width, it stays in the DOM regardless of
          viewport, so duplicating the exact same "OWNER"/role text the
          desktop <aside> below already renders would make every existing
          test's role-label assertion ambiguous (two DOM matches) even
          though only one is ever visible at a time. The drawer opened via
          MobileNav's trigger still shows the full business context
          (SheetTitle), so nothing is actually lost on mobile. */}
      <div className="flex items-center justify-between border-b bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden">
        <p className="min-w-0 truncate font-semibold tracking-tight">{business?.name}</p>
        <NotificationBell businessId={businessId} initialUnreadCount={unreadNotificationCount} />
        <MobileNav sections={sections} businessName={business?.name ?? "BusinessOS"} />
      </div>

      <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto bg-sidebar p-4 text-sidebar-foreground md:flex">
        <div className="px-1">
          <p className="truncate font-semibold tracking-tight">{business?.name}</p>
          <p className="text-xs text-sidebar-foreground/60">{membership.roles?.name ?? "Member"}</p>
        </div>
        <div className="mt-3 px-1">
          <NotificationBell businessId={businessId} initialUnreadCount={unreadNotificationCount} />
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

      <main className="flex-1 overflow-x-auto p-6 md:p-8">{children}</main>
    </div>
  );
}
