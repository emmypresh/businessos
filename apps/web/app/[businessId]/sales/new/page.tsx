import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listCustomers } from "@/lib/customers/dal";
import { SaleForm } from "@/components/sales/sale-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function NewSalePage({
  params,
  searchParams,
}: PageProps<"/[businessId]/sales/new">) {
  const { businessId } = await params;
  const query = await searchParams;

  // sales.create is required to even reach this page.
  await requirePermissionOrNotFound(businessId, PERMISSION.SALES_CREATE);

  // A simple, non-paginated active-customer list for the optional
  // customer selector — matching the same "plain Select, not a live
  // picker" treatment stock-adjustment-form.tsx uses for its (small,
  // single-location) product list. Product selection itself DOES need
  // search-as-you-type (components/sales/product-picker.tsx), since a
  // catalog is expected to be far larger than a customer list for most
  // SMEs at this scale.
  const { rows } = await listCustomers(businessId, { status: "active" });

  // A caller with sales.create but not sales.view lands back here after a
  // successful sale (lib/sales/actions.ts) instead of the sale detail
  // page, which they cannot reach. This banner is deliberately generic —
  // no sale UUID, sale number, totals, or customer details are ever
  // rendered here, since those are sales.view-protected, and this route
  // never checks that permission.
  const created = query.created === "1";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New sale</h1>
      {created ? (
        <Alert data-testid="sale-created-banner">
          <AlertDescription>Sale recorded successfully.</AlertDescription>
        </Alert>
      ) : null}
      {/* A fresh page load — the SaleForm below mounts fresh here, giving
          it a brand-new creationKey (useState(() => crypto.randomUUID())
          runs again on this fresh mount), never reusing the one from the
          sale that was just created. */}
      <SaleForm businessId={businessId} customers={rows.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}
