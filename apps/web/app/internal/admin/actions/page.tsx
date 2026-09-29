import type { Metadata } from "next";
import Link from "next/link";
import { requireAnyPlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { listPlatformActionEligibleBusinesses } from "@/lib/platform/business-operations-dal";
import {
  parseActionSearch,
  parsePageParam,
  PLATFORM_ACTION_SEARCH_MIN_LENGTH,
} from "@/lib/validation/platform-business-operations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SupportPagination } from "@/components/platform/support-pagination";

export const metadata: Metadata = {
  title: "Find a business — Internal Administration",
};

// Phase 1O-D remediation — the smallest safe navigation mechanism for a
// caller who holds a controlled-action permission (suspend/reactivate/
// extend_trial) but NOT platform.businesses.view, and therefore cannot use
// the 1O-B business directory at /internal/admin/businesses. Deliberately
// NOT a Subscriptions console: search by name only, and every row exposes
// only id/name/status/trial state — the same minimal shape
// get_platform_business_action_context returns — before linking to the
// dedicated /actions route for that one business. Gated identically to
// that route (requireAnyPlatformPermission over the same three
// permissions), never on platform.businesses.view.
export default async function PlatformActionsLookupPage({
  searchParams,
}: PageProps<"/internal/admin/actions">) {
  await requireAnyPlatformPermission([
    PLATFORM_PERMISSION.BUSINESSES_SUSPEND,
    PLATFORM_PERMISSION.BUSINESSES_REACTIVATE,
    PLATFORM_PERMISSION.SUBSCRIPTIONS_EXTEND_TRIAL,
  ]);

  const rawSearchParams = await searchParams;
  const search = parseActionSearch(rawSearchParams.q);
  const page = parsePageParam(rawSearchParams.page);

  const { rows, totalCount, pageSize } = await listPlatformActionEligibleBusinesses(search, page);

  const urlSearchParams = new URLSearchParams();
  if (search) urlSearchParams.set("q", search);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Find a business</h2>
        <p className="text-sm text-muted-foreground">
          Search by business name to reach its platform actions ({PLATFORM_ACTION_SEARCH_MIN_LENGTH}{" "}
          characters minimum). Only businesses you can currently act on are shown — this search
          does not show members, branches, activity, or audit data.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex gap-2">
            <Input
              type="search"
              name="q"
              defaultValue={search ?? ""}
              placeholder="Business name"
              aria-label="Search by business name"
              minLength={PLATFORM_ACTION_SEARCH_MIN_LENGTH}
              className="max-w-sm"
            />
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {search
                ? "No actionable business matches this search."
                : `Enter at least ${PLATFORM_ACTION_SEARCH_MIN_LENGTH} characters of a business name to search.`}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">Businesses matching this search</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Business</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Subscription</TableHead>
                  <TableHead scope="col" className="sr-only">
                    Action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.business_id}>
                    <TableCell>{row.business_name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.business_status === "active"
                            ? "default"
                            : row.business_status === "suspended"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {row.business_status}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.subscription_status ?? "—"}</TableCell>
                    <TableCell>
                      <Link
                        href={`/internal/admin/businesses/${row.business_id}/actions`}
                        className="text-sm font-medium underline-offset-4 hover:underline"
                      >
                        Open actions
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <SupportPagination
            page={page}
            pageSize={pageSize}
            totalCount={totalCount}
            searchParams={urlSearchParams}
            itemLabel="business(es)"
          />
        </CardContent>
      </Card>
    </div>
  );
}
