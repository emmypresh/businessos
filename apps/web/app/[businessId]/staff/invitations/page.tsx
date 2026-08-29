import Link from "next/link";
import { Mail } from "lucide-react";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listInvitations } from "@/lib/staff/dal";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InvitationListTable } from "@/components/staff/invitation-list-table";

/**
 * Codex adversarial review, application-layer round 2, Medium 1: an
 * independent invitation-management surface reachable on staff.invite
 * ALONE — the existing /[businessId]/staff page (Members + Invitations
 * tabs) requires staff.view just to load at all
 * (requirePermissionOrNotFound(businessId, PERMISSION.STAFF_VIEW) in that
 * page), which correctly 404s a staff.invite-only caller — they never
 * even reach the Invitations tab. This route requires ONLY staff.invite,
 * fetches ONLY invitation data (listInvitations — never
 * listStaffMembers/getStaffMember), and is the accessible destination
 * dashboard-shell.tsx's own nav link points a staff.invite-only,
 * staff.view-less caller to.
 */
export default async function StaffInvitationsPage({ params }: PageProps<"/[businessId]/staff/invitations">) {
  const { businessId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.STAFF_INVITE);

  const invitations = await listInvitations(businessId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invitations"
        description="Invitations you've sent to give people access to this business."
        actions={
          <Link href={`/${businessId}/staff/invite`} className={buttonVariants()}>
            Invite staff
          </Link>
        }
      />

      {invitations.length === 0 ? (
        <EmptyState icon={Mail} title="No invitations yet." />
      ) : (
        <InvitationListTable businessId={businessId} invitations={invitations} />
      )}
    </div>
  );
}
