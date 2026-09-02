import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listReturns, getReturnsBranchFilterOptions } from "@/lib/returns/dal";
import { ReturnFilterSchema } from "@/lib/validation/returns";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ReturnFilters } from "@/components/returns/return-filters";
import { ReturnListTable } from "@/components/returns/return-list-table";
import { PaginationLink } from "@/components/pagination-link";
import { Undo2 } from "lucide-react";

export default async function ReturnsPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/returns">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.RETURNS_VIEW);
  const permissions = await getPermissions(businessId);
  const canCreate = permissions.has(PERMISSION.RETURNS_MANAGE);

  const parsedFilters = ReturnFilterSchema.safeParse({
    search: typeof query.search === "string" ? query.search : undefined,
    reason: typeof query.reason === "string" ? query.reason : undefined,
    branchId: typeof query.branch === "string" ? query.branch : undefined,
  });
  const search = parsedFilters.success ? parsedFilters.data.search : undefined;
  const reason = parsedFilters.success ? parsedFilters.data.reason : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  // Business-wide, never narrowed to the caller's own operational branch
  // assignment — returns.view is business-wide, matching invoices.view's
  // own precedent, and resolved through get_returns_branch_filter_options
  // (returns.view-gated alone) so a returns.view-only caller with no
  // branches.view still gets real branch names here.
  const allBranches = await getReturnsBranchFilterOptions(businessId);
  const branchParsed = parsedFilters.success ? parsedFilters.data.branchId : undefined;
  const branchId =
    branchParsed && allBranches.some((b) => b.id === branchParsed) ? branchParsed : undefined;

  const { rows, nextCursor } = await listReturns(businessId, { search, branchId, reason, cursor });

  const hasFilters = Boolean(search || reason || branchId);
  const baseHref =
    `/${businessId}/returns?` +
    new URLSearchParams({
      ...(search ? { search } : {}),
      ...(reason ? { reason } : {}),
      ...(branchId ? { branch: branchId } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Returns"
        actions={
          canCreate ? (
            <Link href={`/${businessId}/returns/new`} className={buttonVariants()}>
              New return
            </Link>
          ) : undefined
        }
      />

      <ReturnFilters branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))} />

      {rows.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title={hasFilters ? "No returns match your search." : "No returns yet."}
          description={!hasFilters ? "Record a return against a completed sale to get started." : undefined}
          action={
            !hasFilters && canCreate ? (
              <Link href={`/${businessId}/returns/new`} className={buttonVariants()}>
                New return
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ReturnListTable businessId={businessId} returns={rows} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
