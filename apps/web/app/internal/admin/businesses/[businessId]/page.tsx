import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { getPlatformBusinessDetail } from "@/lib/platform/businesses-dal";
import { IdSchema } from "@/lib/validation/platform-businesses";
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

export const metadata: Metadata = {
  title: "Business detail — Internal Administration",
};

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

// Read-only single-business summary. A malformed businessId, a
// nonexistent business, and (structurally, before this page ever
// renders) an unauthorized caller all resolve to the same 404 — see
// get_platform_business_detail's own header comment in
// supabase/migrations/20260929080000_platform_business_directory.sql.
export default async function PlatformBusinessDetailPage({
  params,
}: PageProps<"/internal/admin/businesses/[businessId]">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW);

  const { businessId } = await params;
  const parsedId = IdSchema.safeParse(businessId);
  if (!parsedId.success) {
    notFound();
  }

  const detail = await getPlatformBusinessDetail(parsedId.data);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/internal/admin/businesses"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; Businesses
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{detail.business_name}</h2>
        <p className="text-sm text-muted-foreground">{detail.slug}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Status</p>
            <Badge variant={detail.status === "active" ? "default" : "outline"}>{detail.status}</Badge>
          </div>
          <div>
            <p className="text-muted-foreground">Country</p>
            <p>{detail.country_code}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Currency</p>
            <p>{detail.currency_code}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Timezone</p>
            <p>{detail.timezone}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Created</p>
            <p>{formatDateTime(detail.created_at)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Owner</p>
            <p>{detail.owner_email ?? "—"}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          {detail.subscription ? (
            <>
              <div>
                <p className="text-muted-foreground">Plan</p>
                <p>{detail.subscription.plan_name}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <Badge>{detail.subscription.status}</Badge>
              </div>
              {detail.subscription.status === "TRIALING" ? (
                <div>
                  <p className="text-muted-foreground">Trial ends</p>
                  <p>{formatDateTime(detail.subscription.trial_ends_at)}</p>
                </div>
              ) : (
                <div>
                  <p className="text-muted-foreground">Current period ends</p>
                  <p>{formatDateTime(detail.subscription.current_period_ends_at)}</p>
                </div>
              )}
              {detail.subscription.cancel_at_period_end ? (
                <div>
                  <p className="text-muted-foreground">Cancellation</p>
                  <p>Scheduled at period end</p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">No subscription record.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Branches ({detail.active_branch_count} active / {detail.branch_count} total)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {detail.branches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No branches.</p>
          ) : (
            <Table>
              <caption className="sr-only">Branches for {detail.business_name}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Code</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.branches.map((branch) => (
                  <TableRow key={branch.branch_id}>
                    <TableCell>{branch.name}</TableCell>
                    <TableCell>{branch.code ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={branch.status === "ACTIVE" ? "default" : "outline"}>
                        {branch.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(branch.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members ({detail.member_count})</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members.</p>
          ) : (
            <Table>
              <caption className="sr-only">Members for {detail.business_name}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Email</TableHead>
                  <TableHead scope="col">Role</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Primary branch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.members.map((member, index) => (
                  // Members carry no stable client-visible id in this
                  // read-only summary — index is safe here because the
                  // list is server-rendered once per request, never
                  // reordered or mutated client-side.
                  <TableRow key={index}>
                    <TableCell>{member.email ?? "—"}</TableCell>
                    <TableCell>{member.role}</TableCell>
                    <TableCell>
                      <Badge variant={member.status === "active" ? "default" : "outline"}>
                        {member.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{member.primary_branch_name ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
