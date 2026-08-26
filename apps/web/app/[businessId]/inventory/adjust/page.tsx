import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listProducts } from "@/lib/products/dal";
import { getDefaultInventoryLocation } from "@/lib/inventory/dal";
import { StockAdjustmentForm } from "@/components/inventory/stock-adjustment-form";

export default async function AdjustStockPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/inventory/adjust">) {
  const { businessId } = await params;
  const query = await searchParams;
  const initialProductId = typeof query.productId === "string" ? query.productId : undefined;

  await requirePermissionOrNotFound(businessId, PERMISSION.INVENTORY_ADJUST);

  const [{ rows: products }, location] = await Promise.all([
    listProducts(businessId, { status: "active" }),
    getDefaultInventoryLocation(businessId),
  ]);
  const trackedProducts = products.filter((p) => p.track_inventory);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Adjust stock</h1>
      {trackedProducts.length === 0 ? (
        <p className="text-muted-foreground">No inventory-tracked products yet.</p>
      ) : (
        <StockAdjustmentForm
          businessId={businessId}
          products={trackedProducts}
          defaultLocationName={location.name}
          initialProductId={initialProductId}
        />
      )}
    </div>
  );
}
