import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { PageHeader } from "@/components/dashboard/page-header";
import { BranchForm } from "@/components/branches/branch-form";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function NewBranchPage({ params, searchParams }: PageProps<"/[businessId]/branches/new">) {
  const { businessId } = await params;
  const query = await searchParams;

  // branches.manage is required to even reach this page.
  await requirePermissionOrNotFound(businessId, PERMISSION.BRANCHES_MANAGE);

  // A caller with branches.manage but not branches.view lands back here
  // after a successful create/update/set-default/deactivate/reactivate
  // (lib/branches/actions.ts) instead of the branch detail page, which
  // they cannot reach. Every banner below is deliberately generic — no
  // branch UUID, name, or other branches.view-protected detail is ever
  // rendered here, since this route never checks that permission.
  // Mirrors expenses'/sales' own manage-without-view redirect exactly.
  // Codex adversarial review, application-layer round 2, Medium 2: the
  // four mutation actions (update/setDefault/deactivate/reactivate)
  // previously always redirected straight to the branches.view-gated
  // detail page regardless of whether the caller actually held
  // branches.view — a manage-only caller who successfully mutated a
  // branch was redirected into a 404. They now land back here instead,
  // exactly like create already did.
  const created = query.created === "1";
  const updated = query.updated === "1";
  const defaulted = query.defaulted === "1";
  const deactivated = query.deactivated === "1";
  const reactivated = query.reactivated === "1";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New branch" description="Add a physical location your business operates from." />
      {created ? (
        <Alert data-testid="branch-created-banner">
          <AlertDescription>Branch created successfully.</AlertDescription>
        </Alert>
      ) : null}
      {updated ? (
        <Alert data-testid="branch-updated-banner">
          <AlertDescription>Branch updated successfully.</AlertDescription>
        </Alert>
      ) : null}
      {defaulted ? (
        <Alert data-testid="branch-defaulted-banner">
          <AlertDescription>Default branch updated successfully.</AlertDescription>
        </Alert>
      ) : null}
      {deactivated ? (
        <Alert data-testid="branch-deactivated-banner">
          <AlertDescription>Branch deactivated successfully.</AlertDescription>
        </Alert>
      ) : null}
      {reactivated ? (
        <Alert data-testid="branch-reactivated-banner">
          <AlertDescription>Branch reactivated successfully.</AlertDescription>
        </Alert>
      ) : null}
      {/* A fresh page load — BranchForm below mounts fresh here, giving it
          a brand-new creationKey. */}
      <BranchForm mode="create" businessId={businessId} />
    </div>
  );
}
