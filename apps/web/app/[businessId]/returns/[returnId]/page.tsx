import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getReturn, getReturnItems } from "@/lib/returns/dal";
import { RETURN_REASON_LABEL, REFUND_METHOD_LABEL, type ReturnReason, type RefundMethod } from "@/lib/returns/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { StatusBadge } from "@/components/dashboard/status-badge";

export default async function ReturnDetailPage({
  params,
}: PageProps<"/[businessId]/returns/[returnId]">) {
  const { businessId, returnId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.RETURNS_VIEW);
  const permissions = await getPermissions(businessId);
  // A link to the originating sale is only ever shown when the caller
  // independently holds sales.view — the sale detail route itself
  // requires it (see app/[businessId]/sales/[saleId]/page.tsx) and would
  // 404 them otherwise. Never a convenience link that discloses whether
  // an inaccessible sale id exists.
  const canViewSale = permissions.has(PERMISSION.SALES_VIEW);

  // Scoped by BOTH business_id and return_id — a forged/foreign returnId
  // renders identically to a nonexistent one (notFound()).
  const saleReturn = await getReturn(businessId, returnId);
  const items = await getReturnItems(businessId, returnId);

  return (
    <div className="flex flex-col gap-6" data-testid="return-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{saleReturn.return_number}</h1>
          <p className="text-sm text-muted-foreground">
            Created {new Date(saleReturn.created_at).toLocaleString()}
          </p>
        </div>
        <StatusBadge status={saleReturn.status} label="Completed" tone="success" />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Sale</dt>
              <dd>
                {/* Immutable history — no invented "sale reference"
                    lookup beyond what a permitted caller can already
                    reach directly. */}
                {canViewSale ? (
                  <Link href={`/${businessId}/sales/${saleReturn.sale_id}`} className="font-medium hover:underline">
                    View sale
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Branch</dt>
              {/* Rendered from the return's OWN historical snapshot —
                  never a join to the live business_branches row. */}
              <dd>{saleReturn.branch_name_snapshot}</dd>
              <dt className="text-muted-foreground">Reason</dt>
              <dd>
                {saleReturn.reason
                  ? RETURN_REASON_LABEL[saleReturn.reason as ReturnReason] ?? saleReturn.reason
                  : "—"}
              </dd>
            </dl>
            {saleReturn.notes ? (
              <div className="mt-3">
                <p className="text-muted-foreground">Notes</p>
                <p className="whitespace-pre-wrap">{saleReturn.notes}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Refund</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-muted-foreground">Amount</dt>
              <dd className="font-medium">{formatMoney(saleReturn.refund_amount, "NGN")}</dd>
              <dt className="text-muted-foreground">Method</dt>
              <dd>
                {saleReturn.refund_method
                  ? REFUND_METHOD_LABEL[saleReturn.refund_method as RefundMethod] ?? saleReturn.refund_method
                  : "No refund"}
              </dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Returned items</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 pr-4 font-normal">Item</th>
                  <th className="py-2 pr-4 font-normal">Quantity</th>
                  <th className="py-2 pr-4 font-normal">Unit price</th>
                  <th className="py-2 pr-4 font-normal">Line total</th>
                  <th className="py-2 font-normal">Stock</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <p className="font-medium">{item.product_name_snapshot}</p>
                      {item.sku_snapshot ? <p className="text-xs text-muted-foreground">{item.sku_snapshot}</p> : null}
                    </td>
                    <td className="py-2 pr-4">{item.quantity}</td>
                    <td className="py-2 pr-4">{formatMoney(item.unit_price_snapshot, "NGN")}</td>
                    <td className="py-2 pr-4">{formatMoney(item.line_total, "NGN")}</td>
                    {/* Historical fact, never an editable toggle — this
                        return's own immutable history has no path to
                        alter a restock decision after creation. */}
                    <td className="py-2">{item.restock ? "Restocked" : "Not restocked"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
