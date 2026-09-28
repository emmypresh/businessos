import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SupportPagination } from "@/components/platform/support-pagination";
import { listPlatformBusinessAudit } from "@/lib/platform/business-operations-dal";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Independently re-checks platform.audit.view at the RPC/database layer
 * (listPlatformBusinessAudit returns null on insufficient_privilege,
 * never a thrown error) — this component never assumes the caller has
 * access merely because BusinessSupportTabs rendered a link to it. See
 * phase instruction #3 and #28.
 */
export async function AuditTab({
  businessId,
  page,
  searchParams,
}: {
  businessId: string;
  page: number;
  searchParams: URLSearchParams;
}) {
  const result = await listPlatformBusinessAudit(businessId, page);

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Audit</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Audit history is unavailable — this requires the separate platform.audit.view
            permission.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { rows, totalCount, pageSize } = result;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit history.</p>
        ) : (
          <Table>
            <caption className="sr-only">Audit history</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">When</TableHead>
                <TableHead scope="col">Actor</TableHead>
                <TableHead scope="col">Action</TableHead>
                <TableHead scope="col">Entity</TableHead>
                <TableHead scope="col">Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry, index) => (
                // Audit rows have no client-visible stable id in this
                // summarized shape — index is safe here for the same
                // reason the frozen 1O-B member list's key is (server-
                // rendered once per request, never reordered client-side).
                <TableRow key={index}>
                  <TableCell>{formatDateTime(entry.occurred_at)}</TableCell>
                  <TableCell>{entry.actor_email ?? "—"}</TableCell>
                  <TableCell>{entry.action}</TableCell>
                  <TableCell>{entry.entity_type ?? "—"}</TableCell>
                  <TableCell>{entry.summary}</TableCell>
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
          itemLabel="record(s)"
        />
      </CardContent>
    </Card>
  );
}
