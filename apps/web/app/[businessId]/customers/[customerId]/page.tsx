import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getCustomer } from "@/lib/customers/dal";
import { listSalesForCustomer } from "@/lib/sales/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { CustomerForm } from "@/components/customers/customer-form";
import { SaleListTable } from "@/components/sales/sale-list-table";
import { CUSTOMER_STATUS, CUSTOMER_STATUS_LABEL, type CustomerStatus } from "@/lib/customers/constants";

export default async function CustomerDetailPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/customers/[customerId]">) {
  const { businessId, customerId } = await params;
  const query = await searchParams;
  const isEditing = query.edit === "1";

  await requirePermissionOrNotFound(businessId, PERMISSION.CUSTOMERS_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.CUSTOMERS_MANAGE);
  // A user may have customers.view without sales.view — sale history is
  // gated on ITS OWN permission, never inferred from customers.view.
  // When absent, the query is never even issued (not just hidden after
  // fetching).
  const canViewSales = permissions.has(PERMISSION.SALES_VIEW);

  const customer = await getCustomer(businessId, customerId);

  // The detail page IS the edit surface (no separate /edit route),
  // matching the products convention exactly.
  if (isEditing && canManage) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Edit {customer.name}</h1>
        <CustomerForm mode="edit" businessId={businessId} customer={customer} />
      </div>
    );
  }

  const salesHistory = canViewSales
    ? await listSalesForCustomer(businessId, customerId)
    : { rows: [], nextCursor: null };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={customer.status === CUSTOMER_STATUS.ACTIVE ? "default" : "outline"}>
            {CUSTOMER_STATUS_LABEL[customer.status as CustomerStatus] ?? customer.status}
          </Badge>
          {canManage ? (
            <Link
              href={`/${businessId}/customers/${customerId}?edit=1`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{customer.phone ?? "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{customer.email ?? "—"}</dd>
            <dt className="text-muted-foreground sm:col-span-1">Address</dt>
            <dd className="sm:col-span-3">{customer.address ?? "—"}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{new Date(customer.created_at).toLocaleDateString()}</dd>
          </dl>
          {customer.notes ? (
            <>
              <p className="mt-4 text-muted-foreground">Notes</p>
              <p className="whitespace-pre-wrap">{customer.notes}</p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {canViewSales ? (
        <Card>
          <CardHeader>
            <CardTitle>Sale history</CardTitle>
          </CardHeader>
          <CardContent>
            {salesHistory.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sales recorded for this customer yet.</p>
            ) : (
              <SaleListTable businessId={businessId} sales={salesHistory.rows} showCustomerColumn={false} />
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
