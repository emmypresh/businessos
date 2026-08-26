import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MEMBERSHIP_STATUS, type MembershipStatus } from "@/lib/business/constants";

type Member = {
  id: string;
  status: string;
  created_at: string;
  roles: { name: string } | null;
};

const STATUS_LABEL: Record<MembershipStatus, string> = {
  [MEMBERSHIP_STATUS.ACTIVE]: "Active",
  [MEMBERSHIP_STATUS.INVITED]: "Invited",
  [MEMBERSHIP_STATUS.SUSPENDED]: "Suspended",
  [MEMBERSHIP_STATUS.REMOVED]: "Removed",
};

export function MembersTable({ members }: { members: Member[] }) {
  if (members.length === 0) {
    return <p className="text-muted-foreground">No members found.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Joined</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.id}>
            <TableCell>{member.roles?.name ?? "—"}</TableCell>
            <TableCell>
              <Badge variant={member.status === MEMBERSHIP_STATUS.ACTIVE ? "default" : "secondary"}>
                {STATUS_LABEL[member.status as MembershipStatus] ?? member.status}
              </Badge>
            </TableCell>
            <TableCell>{new Date(member.created_at).toLocaleDateString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
