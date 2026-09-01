import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInvoiceBranchOptions } from "@/lib/invoices/dal";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function NewInvoicePage({
  params,
  searchParams,
}: PageProps<"/[businessId]/invoices/new">) {
  const { businessId } = await params;
  const query = await searchParams;

  // invoices.manage is required to even reach this page.
  await requirePermissionOrNotFound(businessId, PERMISSION.INVOICES_MANAGE);

  // Codex adversarial review, remediation round 1, Medium 2: branch
  // options are now resolved through get_invoice_branch_options
  // (invoices.manage-gated alone — 20260831080700_invoice_picker_rpcs.sql),
  // never getOperationalBranchOptions' own 'operations' scope (sales.create
  // OR products.manage OR inventory.adjust) — an UNRELATED permission set
  // invoices.manage does not, and must not be made to, imply.
  const { options: branches, primaryBranchId } = await getInvoiceBranchOptions(businessId);

  // A caller with invoices.manage but no invoices.view lands back here
  // (see createInvoice's own redirect logic, lib/invoices/actions.ts) —
  // this generic, non-disclosing success banner is the only feedback
  // they get, mirroring /sales/new's own identical `?created=1` pattern.
  const created = query.created === "1";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
      {created ? (
        <Alert data-testid="invoice-created-banner">
          <AlertDescription>Invoice created successfully.</AlertDescription>
        </Alert>
      ) : null}
      <InvoiceForm businessId={businessId} branches={branches} primaryBranchId={primaryBranchId} />
    </div>
  );
}
