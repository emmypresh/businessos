import Link from "next/link";
import { requirePermissionOrNotFound, getPermissions } from "@/lib/business/dal";
import { PERMISSION, MEMBERSHIP_STATUS } from "@/lib/business/constants";
import { getStaffMember } from "@/lib/staff/dal";
import { listActiveBranchesForPicker } from "@/lib/branches/dal";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { ChangeRoleDialog } from "@/components/staff/change-role-dialog";
import { EditBranchAccessSheet } from "@/components/staff/edit-branch-access-sheet";
import { SuspendMemberDialog, ReactivateMemberForm } from "@/components/staff/member-status-actions";

export default async function StaffMemberPage({ params }: PageProps<"/[businessId]/staff/[memberId]">) {
  const { businessId, memberId } = await params;

  await requirePermissionOrNotFound(businessId, PERMISSION.STAFF_VIEW);
  const permissions = await getPermissions(businessId);
  const canManage = permissions.has(PERMISSION.STAFF_MANAGE);

  const [member, branches] = await Promise.all([
    getStaffMember(businessId, memberId),
    listActiveBranchesForPicker(businessId),
  ]);

  const isActive = member.status === MEMBERSHIP_STATUS.ACTIVE;
  // Self-management is NEVER valid, for any of these four RPCs
  // (CANNOT_MANAGE_SELF is unconditional — see
  // member_management_rpcs.sql's own header comment) — this is one piece
  // of RPC-enforced hierarchy the UI can safely and permanently hide
  // rather than merely surface as an error after the fact. Every OTHER
  // hierarchy rule (CANNOT_MANAGE_OWNER/CANNOT_ASSIGN_OWNER_ROLE/
  // LAST_OWNER_REQUIRED) depends on the CALLER's own current role, which
  // this page does not look up — those remain enforced by the RPC and
  // surfaced via lib/errors.ts's mapping if attempted, per the brief's own
  // "UI may hide known-impossible actions, but must still rely on RPC
  // enforcement" allowance.
  const canManageThisMember = canManage && !member.is_self;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={member.is_self ? "You" : "Staff member"}
        breadcrumbs={
          <Link href={`/${businessId}/staff`} className="hover:underline">
            Staff
          </Link>
        }
        actions={
          canManageThisMember ? (
            <>
              <ChangeRoleDialog businessId={businessId} memberId={member.id} currentRole={member.role_name} />
              <EditBranchAccessSheet
                businessId={businessId}
                memberId={member.id}
                branches={branches}
                currentAssignments={member.branches}
              />
              {isActive ? (
                <SuspendMemberDialog businessId={businessId} memberId={member.id} />
              ) : (
                <ReactivateMemberForm businessId={businessId} memberId={member.id} />
              )}
            </>
          ) : undefined
        }
      />

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Profile</h2>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">Role</dt>
              <dd className="text-sm">{member.role_name.charAt(0) + member.role_name.slice(1).toLowerCase()}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">Joined</dt>
              <dd className="text-sm">{new Date(member.created_at).toLocaleDateString()}</dd>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Status</h2>
            <StatusBadge status={isActive ? "ACTIVE" : "SUSPENDED"} label={isActive ? "Active" : "Suspended"} />
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardContent className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Access</h2>
            {member.branches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No branches assigned.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {member.branches.map((b) => (
                  <li key={b.branch_id} className="flex items-center gap-2 text-sm">
                    <span>{b.branch_name}</span>
                    {b.is_primary ? <StatusBadge status="DEFAULT" label="Primary" /> : null}
                    {b.branch_status !== "ACTIVE" ? <StatusBadge status="INACTIVE" /> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
