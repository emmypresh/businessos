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
import { SupportPagination } from "@/components/platform/support-pagination";
import { listPlatformBusinessActivity } from "@/lib/platform/business-operations-dal";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const CATEGORY_VARIANT: Record<string, "default" | "outline"> = {
  Sale: "default",
  Expense: "outline",
  "Invoice Payment": "default",
  Return: "outline",
  WhatsApp: "outline",
};

export async function ActivityTab({
  businessId,
  page,
  searchParams,
}: {
  businessId: string;
  page: number;
  searchParams: URLSearchParams;
}) {
  const { rows, totalCount, pageSize } = await listPlatformBusinessActivity(businessId, page);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <Table>
            <caption className="sr-only">Recent activity</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">When</TableHead>
                <TableHead scope="col">Category</TableHead>
                <TableHead scope="col">Summary</TableHead>
                <TableHead scope="col">Branch</TableHead>
                <TableHead scope="col">Actor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <TableRow key={event.reference_id}>
                  <TableCell>{formatDateTime(event.occurred_at)}</TableCell>
                  <TableCell>
                    <Badge variant={CATEGORY_VARIANT[event.category] ?? "outline"}>
                      {event.category}
                    </Badge>
                  </TableCell>
                  <TableCell>{event.summary}</TableCell>
                  <TableCell>{event.branch_name ?? "—"}</TableCell>
                  <TableCell>{event.actor_email ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <SupportPagination
          page={page}
          pageSize={pageSize}
          totalCount={totalCount}
          searchParams={searchParams}
          itemLabel="event(s)"
        />
      </CardContent>
    </Card>
  );
}
