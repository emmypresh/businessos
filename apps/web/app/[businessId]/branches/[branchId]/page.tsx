import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getBranch } from "@/lib/branches/dal";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  SetDefaultBranchDialog,
  DeactivateBranchDialog,
  ReactivateBranchForm,
} from "@/components/branches/branch-actions";

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function BranchDetailPage({ params }: PageProps<"/[businessId]/branches/[branchId]">) {
  const { businessId, branchId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.BRANCHES_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.BRANCHES_MANAGE);

  const branch = await getBranch(businessId, branchId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={branch.name}
        breadcrumbs={
          <Link href={`/${businessId}/branches`} className="hover:underline">
            Branches
          </Link>
        }
        actions={
          canManage ? (
            <>
              <Link href={`/${businessId}/branches/${branch.id}/edit`} className={buttonVariants({ variant: "outline" })}>
                Edit
              </Link>
              {!branch.is_default && branch.status === "ACTIVE" ? (
                <SetDefaultBranchDialog businessId={businessId} branchId={branch.id} branchName={branch.name} />
              ) : null}
              {branch.status === "ACTIVE" && !branch.is_default ? (
                <DeactivateBranchDialog businessId={businessId} branchId={branch.id} branchName={branch.name} />
              ) : null}
              {branch.status === "INACTIVE" ? <ReactivateBranchForm businessId={businessId} branchId={branch.id} /> : null}
            </>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={branch.status} />
        {branch.is_default ? <StatusBadge status="DEFAULT" /> : null}
      </div>

      {branch.is_default && branch.status === "ACTIVE" && canManage ? (
        <p className="text-sm text-muted-foreground">
          This is the default branch. Set another active branch as default before deactivating this one.
        </p>
      ) : null}

      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" value={branch.code} />
          <Field label="Phone" value={branch.phone} />
          <Field label="Address line 1" value={branch.address_line1} />
          <Field label="Address line 2" value={branch.address_line2} />
          <Field label="City" value={branch.city} />
          <Field label="State" value={branch.state} />
          <Field label="Country" value={branch.country_code} />
          <Field label="Created" value={new Date(branch.created_at).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
