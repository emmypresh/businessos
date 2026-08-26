import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getProduct, getProductCostIfAllowed } from "@/lib/products/dal";
import { getProductStock, getInventoryHistory } from "@/lib/inventory/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { StockSummaryCard } from "@/components/products/stock-summary-card";
import { ArchiveProductDialog } from "@/components/products/archive-product-dialog";
import { InventoryHistoryTable } from "@/components/inventory/inventory-history-table";
import { ProductForm } from "@/components/products/product-form";

export default async function ProductDetailPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/products/[productId]">) {
  const { businessId, productId } = await params;
  const query = await searchParams;
  const isEditing = query.edit === "1";

  await requirePermissionOrNotFound(businessId, PERMISSION.PRODUCTS_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.PRODUCTS_MANAGE);
  const canAdjust = permissions.has(PERMISSION.INVENTORY_ADJUST);
  const canViewInventory = permissions.has(PERMISSION.INVENTORY_VIEW);
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  const product = await getProduct(businessId, productId);

  // The detail page IS the edit surface (no separate /edit route) — an
  // `?edit=1` query param toggles between the read view below and the
  // shared ProductForm in edit mode, gated on products.manage either way.
  if (isEditing && canManage) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Edit {product.name}</h1>
        <ProductForm mode="edit" businessId={businessId} product={product} canSeeCost={canSeeCost} />
      </div>
    );
  }

  const [costPrice, stock, history] = await Promise.all([
    getProductCostIfAllowed(businessId, productId),
    product.track_inventory ? getProductStock(businessId, productId) : null,
    canViewInventory
      ? getInventoryHistory(businessId, { productId, limit: 5 })
      : { rows: [], nextCursor: null },
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
          {product.sku ? <p className="text-sm text-muted-foreground">{product.sku}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={product.status === "active" ? "default" : "outline"}>{product.status}</Badge>
          {canManage && product.status === "active" ? (
            <Link
              href={`/${businessId}/products/${productId}?edit=1`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
          ) : null}
          {canManage && product.status === "active" ? (
            <ArchiveProductDialog businessId={businessId} productId={productId} productName={product.name} />
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {product.description ? <p>{product.description}</p> : null}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              {product.barcode ? (
                <>
                  <dt className="text-muted-foreground">Barcode</dt>
                  <dd>{product.barcode}</dd>
                </>
              ) : null}
              {product.category ? (
                <>
                  <dt className="text-muted-foreground">Category</dt>
                  <dd>{product.category}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Unit</dt>
              <dd>{product.unit}</dd>
              <dt className="text-muted-foreground">Selling price</dt>
              <dd>
                {product.currency_code} {product.selling_price.toFixed(2)}
              </dd>
              {canSeeCost ? (
                <>
                  <dt className="text-muted-foreground">Cost price</dt>
                  <dd>{costPrice !== null ? `${product.currency_code} ${costPrice.toFixed(2)}` : "—"}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        {product.track_inventory && stock ? (
          <StockSummaryCard
            businessId={businessId}
            trackInventory={product.track_inventory}
            quantity={stock.quantity}
            lowStockThreshold={product.low_stock_threshold}
            locationName={stock.locationName}
            canAdjust={canAdjust}
          />
        ) : (
          <StockSummaryCard
            businessId={businessId}
            trackInventory={false}
            quantity={0}
            lowStockThreshold={null}
            locationName=""
            canAdjust={false}
          />
        )}
      </div>

      {canViewInventory && product.track_inventory ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent inventory history</CardTitle>
          </CardHeader>
          <CardContent>
            {history.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No inventory movements yet.</p>
            ) : (
              <>
                <InventoryHistoryTable
                  businessId={businessId}
                  rows={history.rows}
                  showCost={canSeeCost}
                  showProductColumn={false}
                />
                <Link
                  href={`/${businessId}/inventory/history?productId=${productId}`}
                  className="mt-3 inline-block text-sm underline underline-offset-4"
                >
                  View full history
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
