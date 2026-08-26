import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { ProductForm } from "@/components/products/product-form";

export default async function NewProductPage({
  params,
}: PageProps<"/[businessId]/products/new">) {
  const { businessId } = await params;

  // products.manage is required to even reach this page — a
  // products.view-only user never sees the "New product" link (§7 of the
  // plan), and this notFound() is what backs that up server-side.
  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.PRODUCTS_MANAGE);
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
      <ProductForm mode="create" businessId={businessId} canSeeCost={canSeeCost} />
    </div>
  );
}
