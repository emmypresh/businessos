import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listProducts } from "@/lib/products/dal";
import { getOperationalBranchOptions } from "@/lib/branches/dal";
import { StockAdjustmentForm } from "@/components/inventory/stock-adjustment-form";
import { NoActiveBranchState } from "@/components/branches/no-active-branch-state";

export default async function AdjustStockPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/inventory/adjust">) {
  const { businessId } = await params;
  const query = await searchParams;
  const initialProductId = typeof query.productId === "string" ? query.productId : undefined;

  await requirePermissionOrNotFound(businessId, PERMISSION.INVENTORY_ADJUST);

  const [{ rows: products }, { options: branches, primaryBranchId }] = await Promise.all([
    listProducts(businessId, { status: "active" }),
    getOperationalBranchOptions(businessId),
  ]);
  const trackedProducts = products.filter((p) => p.track_inventory);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Adjust stock</h1>
      {branches.length === 0 ? (
        <NoActiveBranchState action="adjusting stock" />
      ) : trackedProducts.length === 0 ? (
        <p className="text-muted-foreground">No inventory-tracked products yet.</p>
      ) : (
        <StockAdjustmentForm
          businessId={businessId}
          products={trackedProducts}
          branches={branches}
          primaryBranchId={primaryBranchId}
          initialProductId={initialProductId}
        />
      )}
    </div>
  );
}
