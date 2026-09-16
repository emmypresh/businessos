import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import type { ManagementReportingAggregate } from "@/lib/reports/dal";

type BranchRow = ManagementReportingAggregate["branchPerformance"][number];

type Props = {
  branches: BranchRow[];
  currencyCode: string;
};

/**
 * Rows come straight from get_management_reporting_aggregate's
 * branch_performance array (20260916090000_management_reporting_aggregates.sql),
 * which already applies private.has_branch_access per branch and orders by
 * branch name — this component never re-fetches, re-filters, or re-sorts by
 * revenue, so it can never imply a business-wide ranking across branches the
 * caller cannot see. Only branch_id, branch_name, revenue, and order_count
 * exist on the row; no profit, margin, score, or target-attainment field is
 * ever introduced here.
 */
export function BranchPerformance({ branches, currencyCode }: Props) {
  const hasBranches = branches.length > 0;

  return (
    <Card role="region" aria-labelledby="branch-performance-heading">
      <CardHeader>
        <CardTitle id="branch-performance-heading">Branch performance</CardTitle>
        <p className="text-sm text-muted-foreground">
          Completed sales for the last 30 days (UTC), for the {branches.length} branch{branches.length === 1 ? "" : "es"} you are assigned to.
        </p>
      </CardHeader>
      <CardContent>
        {hasBranches ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Branch</TableHead>
                <TableHead scope="col" className="text-right">Completed-sales revenue</TableHead>
                <TableHead scope="col" className="text-right">Completed sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.map((branch) => (
                <TableRow key={branch.branchId}>
                  <TableCell className="font-medium">{branch.branchName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(branch.revenue, currencyCode)}</TableCell>
                  <TableCell className="text-right tabular-nums">{branch.orderCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No branch performance data is available for your assigned branches in this period.</p>
        )}
      </CardContent>
    </Card>
  );
}
