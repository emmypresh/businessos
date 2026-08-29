import Link from "next/link";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BranchRow } from "@/lib/branches/dal";

export function BranchListTable({ businessId, branches }: { businessId: string; branches: BranchRow[] }) {
  if (branches.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Branch</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {branches.map((branch) => {
          const location = [branch.city, branch.state].filter(Boolean).join(", ");
          return (
            <TableRow key={branch.id}>
              <TableCell>
                <Link href={`/${businessId}/branches/${branch.id}`} className="font-medium hover:underline">
                  {branch.name}
                </Link>
                {branch.code ? <p className="text-xs text-muted-foreground">{branch.code}</p> : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{location || "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={branch.status} />
                  {branch.is_default ? <StatusBadge status="DEFAULT" /> : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
