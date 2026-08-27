import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CustomerForm } from "@/components/customers/customer-form";

export default async function NewCustomerPage({
  params,
}: PageProps<"/[businessId]/customers/new">) {
  const { businessId } = await params;

  // customers.manage is required to even reach this page — a
  // customers.view-only user never sees the "New customer" link, and
  // this notFound() is what backs that up server-side.
  await requirePermissionOrNotFound(businessId, PERMISSION.CUSTOMERS_MANAGE);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New customer</h1>
      <CustomerForm mode="create" businessId={businessId} />
    </div>
  );
}
