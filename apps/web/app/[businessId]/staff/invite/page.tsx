import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listInvitationBranchOptions } from "@/lib/staff/dal";
import { PageHeader } from "@/components/dashboard/page-header";
import { InviteStaffForm } from "@/components/staff/invite-staff-form";

export default async function InviteStaffPage({ params }: PageProps<"/[businessId]/staff/invite">) {
  const { businessId } = await params;

  // staff.invite is required to even reach this page.
  await requirePermissionOrNotFound(businessId, PERMISSION.STAFF_INVITE);

  // Codex adversarial review, application-layer round 2, Medium 1: NOT
  // listActiveBranchesForPicker (lib/branches/dal.ts) — that reads
  // business_branches directly, which is gated on branches.view, a
  // DIFFERENT permission a staff.invite holder is not guaranteed to also
  // have. listInvitationBranchOptions calls the dedicated, narrowly
  // scoped get_invitation_branch_options RPC instead, authorized on
  // staff.invite alone.
  const branches = await listInvitationBranchOptions(businessId);

  // A successful invite/revoke (lib/staff/actions.ts) redirects to
  // /staff?tab=invitations (staff.view holders) or the independent
  // /staff/invitations route (staff.invite-only callers) — either way,
  // that destination shows the invitation itself as live confirmation,
  // so no success banner is needed on THIS page anymore.
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invite staff"
        description="Send an invitation to give someone access to this business."
        breadcrumbs={
          <Link href={`/${businessId}/staff/invitations`} className="hover:underline">
            Invitations
          </Link>
        }
      />
      <InviteStaffForm businessId={businessId} branches={branches} />
    </div>
  );
}
