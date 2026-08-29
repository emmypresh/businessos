import Link from "next/link";
import { Building2 } from "lucide-react";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listBranches } from "@/lib/branches/dal";
import { parseBranchListFilters } from "@/lib/validation/branches";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { BranchFilters } from "@/components/branches/branch-filters";
import { BranchListTable } from "@/components/branches/branch-list-table";

export default async function BranchesPage({ params, searchParams }: PageProps<"/[businessId]/branches">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.BRANCHES_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.BRANCHES_MANAGE);

  const { search, status } = parseBranchListFilters(query);
  const branches = await listBranches(businessId, { search, status });
  const hasFilters = Boolean(search || status);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Branches"
        description="The physical locations your business operates from."
        actions={
          canManage ? (
            <Link href={`/${businessId}/branches/new`} className={buttonVariants()}>
              New branch
            </Link>
          ) : undefined
        }
      />

      <BranchFilters />

      {branches.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={hasFilters ? "No branches match your search." : "No branches yet."}
          description={
            !hasFilters && canManage ? "Create a branch to start assigning staff to a location." : undefined
          }
          action={
            !hasFilters && canManage ? (
              <Link href={`/${businessId}/branches/new`} className={buttonVariants({ variant: "secondary" })}>
                Create a branch
              </Link>
            ) : undefined
          }
        />
      ) : (
        <BranchListTable businessId={businessId} branches={branches} />
      )}
    </div>
  );
}
