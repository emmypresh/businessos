import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformBusinessRow } from "@/lib/platform/businesses-dal";

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function subscriptionBadgeVariant(status: string | null): "secondary" | "default" | "destructive" | "outline" {
  switch (status) {
    case "ACTIVE":
      return "default";
    case "TRIALING":
      return "secondary";
    case "PAST_DUE":
      return "destructive";
    case "CANCELED":
    case "EXPIRED":
      return "outline";
    default:
      return "outline";
  }
}

export function BusinessDirectoryTable({ rows }: { rows: PlatformBusinessRow[] }) {
  return (
    <Table>
      <caption className="sr-only">Internal business directory</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Business</TableHead>
          <TableHead scope="col">Owner</TableHead>
          <TableHead scope="col">Country</TableHead>
          <TableHead scope="col">Currency</TableHead>
          <TableHead scope="col">Timezone</TableHead>
          <TableHead scope="col">Plan</TableHead>
          <TableHead scope="col">Subscription</TableHead>
          <TableHead scope="col" className="text-right">
            Branches
          </TableHead>
          <TableHead scope="col" className="text-right">
            Members
          </TableHead>
          <TableHead scope="col">Created</TableHead>
          <TableHead scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.business_id}>
            <TableCell className="font-medium">
              <Link
                href={`/internal/admin/businesses/${row.business_id}`}
                className="underline-offset-4 hover:underline focus-visible:underline"
              >
                {row.business_name}
              </Link>
              <div className="text-xs text-muted-foreground">{row.slug}</div>
            </TableCell>
            <TableCell>{row.owner_email ?? "—"}</TableCell>
            <TableCell>{row.country_code}</TableCell>
            <TableCell>{row.currency_code}</TableCell>
            <TableCell className="whitespace-nowrap">{row.timezone}</TableCell>
            <TableCell>{row.plan_code ?? "—"}</TableCell>
            <TableCell>
              {row.subscription_status ? (
                <Badge variant={subscriptionBadgeVariant(row.subscription_status)}>
                  {row.subscription_status}
                  {row.cancel_at_period_end ? " · ending" : ""}
                </Badge>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right">
              {row.active_branch_count}/{row.branch_count}
            </TableCell>
            <TableCell className="text-right">{row.member_count}</TableCell>
            <TableCell>{formatDate(row.created_at)}</TableCell>
            <TableCell>
              <Badge variant={row.status === "active" ? "default" : "outline"}>{row.status}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
