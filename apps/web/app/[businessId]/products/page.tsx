import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listProducts } from "@/lib/products/dal";
import { buttonVariants } from "@/components/ui/button";
import { ProductFilters } from "@/components/products/product-filters";
import { ProductListTable } from "@/components/products/product-list-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function ProductsPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/products">) {
  const { businessId } = await params;
  const query = await searchParams;

  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.PRODUCTS_VIEW);
  const canManage = permissions.has(PERMISSION.PRODUCTS_MANAGE);

  const search = typeof query.search === "string" ? query.search : undefined;
  const status = query.status === "active" || query.status === "archived" ? query.status : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const { rows, nextCursor } = await listProducts(businessId, { search, status, cursor });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        {canManage ? (
          <Link href={`/${businessId}/products/new`} className={buttonVariants()}>
            New product
          </Link>
        ) : null}
      </div>

      <ProductFilters />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {search || status ? "No products match your search." : "No products yet."}
          {!search && !status && canManage ? (
            <>
              {" "}
              <Link href={`/${businessId}/products/new`} className="underline underline-offset-4">
                Create your first product
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <ProductListTable businessId={businessId} products={rows} />
          <PaginationLink
            href={`/${businessId}/products${search ? `?search=${encodeURIComponent(search)}` : ""}${status ? `${search ? "&" : "?"}status=${status}` : ""}`}
            nextCursor={nextCursor}
          />
        </>
      )}
    </div>
  );
}
