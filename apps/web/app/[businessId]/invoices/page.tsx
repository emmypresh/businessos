import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listInvoices } from "@/lib/invoices/dal";
import { listInvoiceFilterBranchOptions } from "@/lib/branches/dal";
import { InvoiceFilterSchema } from "@/lib/validation/invoices";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InvoiceFilters } from "@/components/invoices/invoice-filters";
import { InvoiceListTable } from "@/components/invoices/invoice-list-table";
import { PaginationLink } from "@/components/pagination-link";
import { FileText } from "lucide-react";

export default async function InvoicesPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/invoices">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.INVOICES_VIEW);
  const permissions = await getPermissions(businessId);
  const canCreate = permissions.has(PERMISSION.INVOICES_MANAGE);

  const parsedFilters = InvoiceFilterSchema.safeParse({
    search: typeof query.search === "string" ? query.search : undefined,
    status: typeof query.status === "string" ? query.status : undefined,
    branchId: typeof query.branch === "string" ? query.branch : undefined,
  });
  const search = parsedFilters.success ? parsedFilters.data.search : undefined;
  const status = parsedFilters.success ? parsedFilters.data.status : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  // Business-wide, never narrowed to the caller's own operational branch
  // assignment — invoices.view is business-wide, matching sales.view's
  // own precedent, and resolved through get_invoice_filter_branch_options
  // (invoices.view-gated alone — see listInvoiceFilterBranchOptions' own
  // header comment) so an invoices.view-only caller with no branches.view
  // still gets real branch names here, never an empty/degraded result.
  const allBranches = await listInvoiceFilterBranchOptions(businessId);
  const branchParsed = parsedFilters.success ? parsedFilters.data.branchId : undefined;
  const branchId =
    branchParsed && allBranches.some((b) => b.id === branchParsed) ? branchParsed : undefined;

  const { rows, nextCursor } = await listInvoices(businessId, { search, status, branchId, cursor });

  const hasFilters = Boolean(search || status || branchId);
  const baseHref =
    `/${businessId}/invoices?` +
    new URLSearchParams({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      ...(branchId ? { branch: branchId } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        actions={
          canCreate ? (
            <Link href={`/${businessId}/invoices/new`} className={buttonVariants()}>
              New invoice
            </Link>
          ) : undefined
        }
      />

      <InvoiceFilters branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))} />

      {rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={hasFilters ? "No invoices match your search." : "No invoices yet."}
          description={!hasFilters ? "Create your first invoice to start billing customers." : undefined}
          action={
            !hasFilters && canCreate ? (
              <Link href={`/${businessId}/invoices/new`} className={buttonVariants()}>
                New invoice
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <InvoiceListTable businessId={businessId} invoices={rows} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
