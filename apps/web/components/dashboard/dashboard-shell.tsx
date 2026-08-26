import Link from "next/link";
import { LayoutDashboard, Users, Package, Boxes, LogOut } from "lucide-react";
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
