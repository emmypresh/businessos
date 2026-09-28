import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberFilters } from "@/components/platform/member-filters";
import { SupportPagination } from "@/components/platform/support-pagination";
import { listPlatformBusinessMembers } from "@/lib/platform/business-operations-dal";
import type { MemberQuery } from "@/lib/validation/platform-business-operations";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export async function MembersTab({
  businessId,
  query,
  searchParams,
}: {
  businessId: string;
  query: MemberQuery;
  searchParams: URLSearchParams;
}) {
  const { rows, totalCount, pageSize } = await listPlatformBusinessMembers(businessId, query);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members ({totalCount})</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <MemberFilters />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members match these filters.</p>
        ) : (
          <Table>
            <caption className="sr-only">Members</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Email</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Primary branch</TableHead>
                <TableHead scope="col">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((member) => (
                <TableRow key={member.member_id}>
                  <TableCell>{member.email ?? "—"}</TableCell>
                  <TableCell>{member.role}</TableCell>
                  <TableCell>
                    <Badge variant={member.status === "active" ? "default" : "outline"}>
                      {member.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{member.primary_branch_name ?? "—"}</TableCell>
                  <TableCell>{formatDateTime(member.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <SupportPagination
          page={query.page}
          pageSize={pageSize}
          totalCount={totalCount}
          searchParams={searchParams}
          itemLabel="member(s)"
        />
      </CardContent>
    </Card>
  );
}
