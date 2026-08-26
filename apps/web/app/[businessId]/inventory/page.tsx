import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInventoryOverview } from "@/lib/inventory/dal";
import { buttonVariants } from "@/components/ui/button";
import { InventoryOverviewTable } from "@/components/inventory/inventory-overview-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function InventoryPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/inventory">) {
  const { businessId } = await params;
  const query = await searchParams;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.INVENTORY_VIEW);
  const canAdjust = permissions.has(PERMISSION.INVENTORY_ADJUST);

  const { rows, nextCursor } = await getInventoryOverview(businessId, { cursor });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <div className="flex items-center gap-2">
          <Link href={`/${businessId}/inventory/history`} className={buttonVariants({ variant: "outline" })}>
            History
          </Link>
          {canAdjust ? (
            <Link href={`/${businessId}/inventory/adjust`} className={buttonVariants()}>
              Adjust stock
            </Link>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No tracked products yet.</p>
      ) : (
        <>
          <InventoryOverviewTable businessId={businessId} rows={rows} />
          <PaginationLink href={`/${businessId}/inventory`} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
