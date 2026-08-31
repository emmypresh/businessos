import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listSales } from "@/lib/sales/dal";
import { listSalesFilterBranchOptions } from "@/lib/branches/dal";
import { SaleFilterSchema } from "@/lib/validation/sales";
import { buttonVariants } from "@/components/ui/button";
import { SaleFilters } from "@/components/sales/sale-filters";
import { SaleListTable } from "@/components/sales/sale-list-table";
import { PaginationLink } from "@/components/pagination-link";

export default async function SalesPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/sales">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.SALES_VIEW);
  const permissions = await getPermissions(businessId);
  const canCreate = permissions.has(PERMISSION.SALES_CREATE);

  const search = typeof query.search === "string" ? query.search : undefined;
  const paymentStatus =
    query.paymentStatus === "UNPAID" || query.paymentStatus === "PARTIALLY_PAID" || query.paymentStatus === "PAID"
      ? query.paymentStatus
      : undefined;
  const dateFrom = typeof query.dateFrom === "string" ? query.dateFrom : undefined;
  const dateTo = typeof query.dateTo === "string" ? query.dateTo : undefined;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  // Codex adversarial review, application-layer round 2, Blocker 4:
  // sales.view is BUSINESS-WIDE (never gated on has_branch_access — see
  // lib/sales/dal.ts's own comment), and the unfiltered list already shows
  // every branch's sales — so the filter's own OPTIONS must cover every
  // branch of the business, never just the caller's own OPERATIONAL
  // assignment (that concept only applies to CREATING a sale, a
  // genuinely different authorization model — see
  // getOperationalBranchOptions' own header comment). Every branch,
  // including INACTIVE ones, is offered here: a business's sales history
  // at a since-deactivated branch must remain filterable. A malformed or
  // unrecognized `?branch=` value is silently dropped (treated as "no
  // filter"), exactly like every other filter's own safe-fallback
  // convention (see lib/validation/expenses.ts's parseExpenseListFilters).
  const allBranches = await listSalesFilterBranchOptions(businessId);
  const rawBranch = typeof query.branch === "string" ? query.branch : undefined;
  const branchParsed = SaleFilterSchema.shape.branchId.safeParse(rawBranch);
  const branchId =
    branchParsed.success && branchParsed.data && allBranches.some((b) => b.id === branchParsed.data)
      ? branchParsed.data
      : undefined;

  const { rows, nextCursor } = await listSales(businessId, {
    search,
    paymentStatus,
    branchId,
    dateFrom,
    dateTo,
    cursor,
  });

  const hasFilters = Boolean(search || paymentStatus || branchId || dateFrom || dateTo);
  const baseHref =
    `/${businessId}/sales?` +
    new URLSearchParams({
      ...(search ? { search } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(branchId ? { branch: branchId } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        {canCreate ? (
          <Link href={`/${businessId}/sales/new`} className={buttonVariants()}>
            New sale
          </Link>
        ) : null}
      </div>

      <SaleFilters branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))} />

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters ? "No sales match your search." : "No sales yet."}
          {!hasFilters && canCreate ? (
            <>
              {" "}
              <Link href={`/${businessId}/sales/new`} className="underline underline-offset-4">
                Record your first sale
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <SaleListTable businessId={businessId} sales={rows} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
