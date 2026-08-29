import { StatusBadge } from "@/components/dashboard/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RevokeInvitationDialog } from "@/components/staff/revoke-invitation-dialog";
import { INVITATION_STATUS } from "@/lib/staff/constants";
import type { InvitationRow } from "@/lib/staff/dal";

// Effective status — a PENDING row whose expires_at has already passed
// but hasn't been lazily materialized to EXPIRED yet server-side (see
// create_business_invitation's/accept_business_invitation's own "lazy,
// opportunistic" comment) still reads as Expired here, not Pending, so
// this list never shows a stale invitation as if it were still usable.
function effectiveStatus(invitation: InvitationRow): string {
  if (invitation.status === INVITATION_STATUS.PENDING && new Date(invitation.expires_at) <= new Date()) {
    return INVITATION_STATUS.EXPIRED;
  }
  return invitation.status;
}

export function InvitationListTable({ businessId, invitations }: { businessId: string; invitations: InvitationRow[] }) {
  if (invitations.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Branches</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.map((invitation) => {
          const status = effectiveStatus(invitation);
          const primary = invitation.branches.find((b) => b.is_primary);
          return (
            <TableRow key={invitation.id}>
              <TableCell className="font-medium">{invitation.email}</TableCell>
              <TableCell>{invitation.role_name.charAt(0) + invitation.role_name.slice(1).toLowerCase()}</TableCell>
              <TableCell className="text-muted-foreground">
                {primary ? primary.branch_name : "—"}
                {invitation.branches.length > 1 ? ` +${invitation.branches.length - 1}` : ""}
              </TableCell>
              <TableCell>
                <StatusBadge status={status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{new Date(invitation.expires_at).toLocaleDateString()}</TableCell>
              <TableCell className="text-right">
                {status === INVITATION_STATUS.PENDING ? (
                  <RevokeInvitationDialog businessId={businessId} invitationId={invitation.id} />
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
