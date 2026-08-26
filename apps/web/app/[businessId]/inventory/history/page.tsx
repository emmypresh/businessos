import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInventoryHistory } from "@/lib/inventory/dal";
import { listProducts } from "@/lib/products/dal";
import { HistoryFilters } from "@/components/inventory/history-filters";
import { InventoryHistoryTable } from "@/components/inventory/inventory-history-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function InventoryHistoryPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/inventory/history">) {
  const { businessId } = await params;
  const query = await searchParams;
  const productId = typeof query.productId === "string" ? query.productId : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.INVENTORY_VIEW);
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  const [{ rows, nextCursor }, { rows: products }] = await Promise.all([
    getInventoryHistory(businessId, { productId, cursor }),
    listProducts(businessId, { status: "active" }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory history</h1>
      <HistoryFilters products={products} />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {productId ? "No inventory movements for this product yet." : "No inventory movements yet."}
        </p>
      ) : (
        <>
          <InventoryHistoryTable businessId={businessId} rows={rows} showCost={canSeeCost} />
          <PaginationLink
            href={`/${businessId}/inventory/history${productId ? `?productId=${productId}` : ""}`}
            nextCursor={nextCursor}
          />
        </>
      )}
    </div>
  );
}
