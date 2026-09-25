import { requirePermissionOrNotFound, getBusinessDetails } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getOperationalBranchOptions } from "@/lib/branches/dal";
import { ProductForm } from "@/components/products/product-form";
import { CurrencyUnavailableState } from "@/components/business/currency-unavailable-state";

export default async function NewProductPage({
  params,
}: PageProps<"/[businessId]/products/new">) {
  const { businessId } = await params;

  // products.manage is required to even reach this page — a
  // products.view-only user never sees the "New product" link (§7 of the
  // plan), and this notFound() is what backs that up server-side.
  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.PRODUCTS_MANAGE);
  const canSeeCost = permissions.has(PERMISSION.INVENTORY_VIEW_COST);

  // getOperationalBranchOptions is authorized on the "operations" RPC
  // scope, which requires products.manage/sales.create/inventory.adjust —
  // never branches.view specifically — preserving the exact "mutation
  // permission ≠ view permission" contract this page's own comment above
  // already documents for products.manage/products.view (see
  // supabase/migrations/20260830080000_branch_option_rpc.sql).
  const [{ options: branches, primaryBranchId }, business] = await Promise.all([
    getOperationalBranchOptions(businessId),
    // Phase 1Q-0C: the price labels' currency indicator is display-only,
    // reading from this same authoritative loader — never a separate,
    // independently-drifting source, matching ExpenseForm's own pattern.
    getBusinessDetails(businessId),
  ]);
  // Phase 1Q-0C follow-up: fail closed rather than assuming NGN when the
  // business record couldn't be loaded — see the matching comment on
  // expenses/new/page.tsx.
  if (!business) {
    return <CurrencyUnavailableState action="create a product" />;
  }
  const currencyCode = business.currency_code;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
      <ProductForm
        mode="create"
        businessId={businessId}
        canSeeCost={canSeeCost}
        branches={branches}
        primaryBranchId={primaryBranchId}
        currencyCode={currencyCode}
      />
    </div>
  );
}
