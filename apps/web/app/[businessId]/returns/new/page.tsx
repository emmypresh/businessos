import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { ReturnForm } from "@/components/returns/return-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function NewReturnPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/returns/new">) {
  const { businessId } = await params;
  const query = await searchParams;

  // returns.manage is required to even reach this page — no sales.view,
  // branches.view, or any other unrelated permission is checked here or
  // anywhere downstream in ReturnForm's own picker/create calls (see
  // lib/returns/actions.ts's own header comments).
  await requirePermissionOrNotFound(businessId, PERMISSION.RETURNS_MANAGE);

  // A caller with returns.manage but no returns.view lands back here
  // (see createSaleReturn's own redirect logic, lib/returns/actions.ts) —
  // this generic, non-disclosing success banner is the only feedback
  // they get, mirroring /invoices/new's own identical `?created=1`
  // pattern.
  const created = query.created === "1";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New return</h1>
      {created ? (
        <Alert data-testid="return-created-banner">
          <AlertDescription>Return created successfully.</AlertDescription>
        </Alert>
      ) : null}
      <ReturnForm businessId={businessId} />
    </div>
  );
}
