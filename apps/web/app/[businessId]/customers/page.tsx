import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listCustomers } from "@/lib/customers/dal";
import { buttonVariants } from "@/components/ui/button";
import { CustomerFilters } from "@/components/customers/customer-filters";
import { CustomerListTable } from "@/components/customers/customer-list-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function CustomersPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/customers">) {
  const { businessId } = await params;
  const query = await searchParams;

  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.CUSTOMERS_VIEW);
  const canManage = permissions.has(PERMISSION.CUSTOMERS_MANAGE);

  const search = typeof query.search === "string" ? query.search : undefined;
  const status =
    query.status === "active" || query.status === "inactive" || query.status === "archived"
      ? query.status
      : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const { rows, nextCursor } = await listCustomers(businessId, { search, status, cursor });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        {canManage ? (
          <Link href={`/${businessId}/customers/new`} className={buttonVariants()}>
            New customer
          </Link>
        ) : null}
      </div>

      <CustomerFilters />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {search || status ? "No customers match your search." : "No customers yet."}
          {!search && !status && canManage ? (
            <>
              {" "}
              <Link href={`/${businessId}/customers/new`} className="underline underline-offset-4">
                Add your first customer
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <CustomerListTable businessId={businessId} customers={rows} />
          <PaginationLink
            href={`/${businessId}/customers${search ? `?search=${encodeURIComponent(search)}` : ""}${status ? `${search ? "&" : "?"}status=${status}` : ""}`}
            nextCursor={nextCursor}
          />
        </>
      )}
    </div>
  );
}
