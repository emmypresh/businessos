import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getSale, getSaleItems } from "@/lib/sales/dal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_STATUS, PAYMENT_STATUS_LABEL, type PaymentStatus } from "@/lib/sales/constants";

export default async function SaleDetailPage({
  params,
}: PageProps<"/[businessId]/sales/[saleId]">) {
  const { businessId, saleId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.SALES_VIEW);

  const [sale, items] = await Promise.all([
    getSale(businessId, saleId),
    getSaleItems(businessId, saleId),
  ]);

  return (
    <div className="flex flex-col gap-6" data-testid="sale-detail">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{sale.sale_number}</h1>
          <p className="text-sm text-muted-foreground">
            {sale.completed_at ? new Date(sale.completed_at).toLocaleString() : "—"}
          </p>
        </div>
        <Badge variant={sale.payment_status === PAYMENT_STATUS.PAID ? "default" : "secondary"}>
          {PAYMENT_STATUS_LABEL[sale.payment_status as PaymentStatus] ?? sale.payment_status}
        </Badge>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {/* Rendered from the sale's OWN historical snapshot columns —
                never the live customers row, and never a join. Editing
                or archiving the customer later never changes what this
                page shows. */}
            {sale.customer_name_snapshot ? (
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted-foreground">Name</dt>
                <dd>
                  {sale.customer_id ? (
                    <Link href={`/${businessId}/customers/${sale.customer_id}`} className="hover:underline">
                      {sale.customer_name_snapshot}
                    </Link>
                  ) : (
                    sale.customer_name_snapshot
                  )}
                </dd>
                {sale.customer_phone_snapshot ? (
                  <>
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd>{sale.customer_phone_snapshot}</dd>
                  </>
                ) : null}
                {sale.customer_email_snapshot ? (
                  <>
                    <dt className="text-muted-foreground">Email</dt>
                    <dd>{sale.customer_email_snapshot}</dd>
                  </>
                ) : null}
                {sale.customer_address_snapshot ? (
                  <>
                    <dt className="text-muted-foreground">Address</dt>
                    <dd>{sale.customer_address_snapshot}</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="text-muted-foreground">Walk-in customer</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Status</dt>
              <dd>{PAYMENT_STATUS_LABEL[sale.payment_status as PaymentStatus] ?? sale.payment_status}</dd>
              <dt className="text-muted-foreground">Method</dt>
              <dd>{sale.payment_method ?? "—"}</dd>
              <dt className="text-muted-foreground">Amount paid</dt>
              <dd>
                {sale.currency_code} {sale.amount_paid.toFixed(2)}
              </dd>
              {/* Branch and sold-from location, both from the sale's OWN
                  historical snapshot columns — never a join to the live
                  business_branches/inventory_locations rows. A branch
                  rename, or the branch later becoming inactive, never
                  changes what this page shows (see lib/sales/dal.ts's own
                  header comment on snapshots). */}
              <dt className="text-muted-foreground">Branch</dt>
              <dd>{sale.branch_name_snapshot}</dd>
              <dt className="text-muted-foreground">Sold from</dt>
              <dd>{sale.inventory_location_name_snapshot}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Unit price</TableHead>
                <TableHead>Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    {/* Rendered from the line's OWN historical snapshot —
                        never a join to the live products row. No cost
                        field is ever queried or rendered here — Phase 1D
                        has no cost/profit UI. */}
                    <p className="font-medium">{item.product_name_snapshot}</p>
                    {item.sku_snapshot ? (
                      <p className="text-xs text-muted-foreground">{item.sku_snapshot}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>
                    {sale.currency_code} {item.unit_price.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    {sale.currency_code} {item.line_total.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <dl className="mt-4 ml-auto grid w-fit grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right">
              {sale.currency_code} {sale.subtotal.toFixed(2)}
            </dd>
            <dt className="text-muted-foreground">Discount</dt>
            <dd className="text-right">
              {sale.currency_code} {sale.discount.toFixed(2)}
            </dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-medium">
              {sale.currency_code} {sale.total.toFixed(2)}
            </dd>
          </dl>
        </CardContent>
      </Card>

      {sale.notes ? (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{sale.notes}</CardContent>
        </Card>
      ) : null}
    </div>
  );
}
