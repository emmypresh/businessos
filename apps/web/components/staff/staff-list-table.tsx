import Link from "next/link";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MEMBERSHIP_STATUS } from "@/lib/business/constants";
import type { StaffMemberRow } from "@/lib/staff/dal";

// No email/display name column — see lib/staff/dal.ts's own header
// comment for why none is safely available in the current schema. "You"
// marks the caller's own row; every other row identifies itself by role
// only, which is honest rather than inventing a name.
function IdentityCell({ member }: { member: StaffMemberRow }) {
  return (
    <div className="flex flex-col">
      <span className="font-medium">{member.is_self ? "You" : "Team member"}</span>
      <span className="font-mono text-xs text-muted-foreground">{member.id.slice(0, 8)}</span>
    </div>
  );
}

export function StaffListTable({ businessId, members }: { businessId: string; members: StaffMemberRow[] }) {
  if (members.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Staff member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Primary branch</TableHead>
          <TableHead>Assigned branches</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Joined</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const primary = member.branches.find((b) => b.is_primary);
          const others = member.branches.filter((b) => !b.is_primary);
          return (
            <TableRow key={member.id}>
              <TableCell>
                <Link href={`/${businessId}/staff/${member.id}`} className="hover:underline">
                  <IdentityCell member={member} />
                </Link>
              </TableCell>
              <TableCell>{member.role_name.charAt(0) + member.role_name.slice(1).toLowerCase()}</TableCell>
              <TableCell className="text-muted-foreground">{primary?.branch_name ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">
                {others.length > 0 ? others.map((b) => b.branch_name).join(", ") : primary ? "—" : "None assigned"}
              </TableCell>
              <TableCell>
                <StatusBadge
                  status={member.status === MEMBERSHIP_STATUS.ACTIVE ? "ACTIVE" : "SUSPENDED"}
                  label={member.status === MEMBERSHIP_STATUS.ACTIVE ? "Active" : "Suspended"}
                />
              </TableCell>
              <TableCell className="text-muted-foreground">{new Date(member.created_at).toLocaleDateString()}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
