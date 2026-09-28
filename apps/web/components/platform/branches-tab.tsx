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
import type { PlatformBusinessOverview } from "@/lib/platform/business-operations-dal";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function BranchesTab({ overview }: { overview: PlatformBusinessOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Branches ({overview.active_branch_count} active / {overview.branch_count} total)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {overview.branches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No branches.</p>
        ) : (
          <Table>
            <caption className="sr-only">Branches for {overview.business_name}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Members</TableHead>
                <TableHead scope="col">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.branches.map((branch) => (
                <TableRow key={branch.branch_id}>
                  <TableCell>{branch.name}</TableCell>
                  <TableCell>{branch.code ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={branch.status === "ACTIVE" ? "default" : "outline"}>
                      {branch.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{branch.member_count}</TableCell>
                  <TableCell>{formatDateTime(branch.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
