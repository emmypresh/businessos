import Link from "next/link";
import { IdCard, Mail } from "lucide-react";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION, MEMBERSHIP_STATUS } from "@/lib/business/constants";
import { listStaffMembers, listInvitations } from "@/lib/staff/dal";
import { listActiveBranchesForPicker } from "@/lib/branches/dal";
import { parseStaffListFilters } from "@/lib/validation/staff";
import type { RoleName } from "@/lib/business/constants";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { StaffFilters } from "@/components/staff/staff-filters";
import { StaffListTable } from "@/components/staff/staff-list-table";
import { InvitationListTable } from "@/components/staff/invitation-list-table";
import { StaffTabs } from "@/components/staff/staff-tabs";

export default async function StaffPage({ params, searchParams }: PageProps<"/[businessId]/staff">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.STAFF_VIEW);
  const permissions = await getPermissions(businessId);
  const canInvite = permissions.has(PERMISSION.STAFF_INVITE);

  const { role, status, branchId } = parseStaffListFilters(query);
  const [members, branches] = await Promise.all([
    listStaffMembers(businessId, {
      role: role as RoleName | undefined,
      status: status === "suspended" ? MEMBERSHIP_STATUS.SUSPENDED : status === "active" ? MEMBERSHIP_STATUS.ACTIVE : undefined,
      branchId,
    }),
    listActiveBranchesForPicker(businessId),
  ]);

  // Do NOT fetch/list invitations for staff.view-only users — a separate
  // permission (staff.invite) independently gates this, both here and at
  // the database layer (business_invitations' own SELECT policy).
  const invitations = canInvite ? await listInvitations(businessId) : null;

  const hasFilters = Boolean(role || status || branchId);
  const tab = query.tab === "invitations" ? "invitations" : "members";

  const membersContent =
    members.length === 0 ? (
      <EmptyState
        icon={IdCard}
        title={hasFilters ? "No staff match your filters." : "No staff yet."}
        description={!hasFilters && canInvite ? "Invite someone to give them access to this business." : undefined}
      />
    ) : (
      <StaffListTable businessId={businessId} members={members} />
    );

  const invitationsContent = invitations ? (
    invitations.length === 0 ? (
      <EmptyState icon={Mail} title="No invitations yet." />
    ) : (
      <InvitationListTable businessId={businessId} invitations={invitations} />
    )
  ) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Staff"
        description="Manage who can access this business and where they can operate."
        actions={
          canInvite ? (
            <Link href={`/${businessId}/staff/invite`} className={buttonVariants()}>
              Invite staff
            </Link>
          ) : undefined
        }
      />

      <StaffFilters branches={branches} />

      <StaffTabs defaultTab={tab} membersContent={membersContent} invitationsContent={invitationsContent} />
    </div>
  );
}
