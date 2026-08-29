import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getBranch, toBranchEditValues } from "@/lib/branches/dal";
import { PageHeader } from "@/components/dashboard/page-header";
import { BranchForm } from "@/components/branches/branch-form";

export default async function EditBranchPage({ params }: PageProps<"/[businessId]/branches/[branchId]/edit">) {
  const { businessId, branchId } = await params;

  // branches.manage is required to even reach this page — branches.view
  // alone (the permission the detail page requires) is not enough to
  // reach the edit form.
  await requirePermissionOrNotFound(businessId, PERMISSION.BRANCHES_MANAGE);

  const branch = await getBranch(businessId, branchId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Edit ${branch.name}`}
        breadcrumbs={
          <Link href={`/${businessId}/branches/${branch.id}`} className="hover:underline">
            {branch.name}
          </Link>
        }
      />
      {/* Codex adversarial review, application-layer round 2, Low 9: only
          the narrow edit-relevant projection crosses into the Client
          Component — never business_id/created_by/timestamps/status/
          is_default, which BranchForm has no use for at all. */}
      <BranchForm mode="edit" businessId={businessId} branch={toBranchEditValues(branch)} />
    </div>
  );
}
