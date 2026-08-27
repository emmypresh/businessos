import Link from "next/link";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { logOut } from "@/lib/auth/actions";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
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

  // Nav visibility only — a courtesy, not a security boundary. Every
  // route this links to independently re-verifies the same permission
  // server-side (requirePermissionOrNotFound), and every mutation
  // independently re-verifies its own (see lib/products/actions.ts,
  // lib/inventory/actions.ts).
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

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b bg-card p-4 md:w-56 md:border-b-0 md:border-r">
        <div>
          <p className="truncate font-semibold tracking-tight">{business?.name}</p>
          <p className="text-xs text-muted-foreground">{membership.roles?.name ?? "Member"}</p>
        </div>
        <nav className="mt-6 flex flex-col gap-1 text-sm">
          <Link href={`/${businessId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
            <LayoutDashboard className="size-4" />
            Dashboard
          </Link>
          <Link href={`/${businessId}/members`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
            <Users className="size-4" />
            Members
          </Link>
          {canViewProducts ? (
            <Link href={`/${businessId}/products`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Package className="size-4" />
              Products
            </Link>
          ) : null}
          {canViewInventory ? (
            <Link href={`/${businessId}/inventory`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Boxes className="size-4" />
              Inventory
            </Link>
          ) : null}
          {canViewCustomers ? (
            <Link href={`/${businessId}/customers`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <UserRound className="size-4" />
              Customers
            </Link>
          ) : null}
          {canViewSales || canCreateSales ? (
            <Link href={salesHref} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Receipt className="size-4" />
              Sales
            </Link>
          ) : null}
          {canViewExpenses || canManageExpenses ? (
            <Link href={expensesHref} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Wallet className="size-4" />
              Expenses
            </Link>
          ) : null}
          {canViewExpenses || canManageExpenses ? (
            <Link
              href={`/${businessId}/expenses/categories`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 pl-8 text-muted-foreground hover:bg-accent"
            >
              <ListTree className="size-4" />
              Categories
            </Link>
          ) : null}
          {canViewReports ? (
            <Link href={`/${businessId}/reports`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <LineChart className="size-4" />
              Reports
            </Link>
          ) : null}
        </nav>
        <form action={logOut} className="mt-auto pt-8">
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start gap-2">
            <LogOut className="size-4" />
            Log out
          </Button>
        </form>
      </aside>
      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
