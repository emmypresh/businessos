import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listSales } from "@/lib/sales/dal";
import { buttonVariants } from "@/components/ui/button";
import { SaleFilters } from "@/components/sales/sale-filters";
import { SaleListTable } from "@/components/sales/sale-list-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function SalesPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/sales">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.SALES_VIEW);
  const permissions = await getPermissions(businessId);
  const canCreate = permissions.has(PERMISSION.SALES_CREATE);

  const search = typeof query.search === "string" ? query.search : undefined;
  const paymentStatus =
    query.paymentStatus === "UNPAID" || query.paymentStatus === "PARTIALLY_PAID" || query.paymentStatus === "PAID"
      ? query.paymentStatus
      : undefined;
  const dateFrom = typeof query.dateFrom === "string" ? query.dateFrom : undefined;
  const dateTo = typeof query.dateTo === "string" ? query.dateTo : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const { rows, nextCursor } = await listSales(businessId, {
    search,
    paymentStatus,
    dateFrom,
    dateTo,
    cursor,
  });

  const hasFilters = Boolean(search || paymentStatus || dateFrom || dateTo);
  const baseHref =
    `/${businessId}/sales?` +
    new URLSearchParams({
      ...(search ? { search } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        {canCreate ? (
          <Link href={`/${businessId}/sales/new`} className={buttonVariants()}>
            New sale
          </Link>
        ) : null}
      </div>

      <SaleFilters />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters ? "No sales match your search." : "No sales yet."}
          {!hasFilters && canCreate ? (
            <>
              {" "}
              <Link href={`/${businessId}/sales/new`} className="underline underline-offset-4">
                Record your first sale
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <SaleListTable businessId={businessId} sales={rows} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
