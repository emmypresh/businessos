import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PlatformBusinessOverview } from "@/lib/platform/business-operations-dal";

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

export function OverviewTab({ overview }: { overview: PlatformBusinessOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground">Status</p>
          <Badge variant={overview.status === "active" ? "default" : "outline"}>{overview.status}</Badge>
        </div>
        <div>
          <p className="text-muted-foreground">Country</p>
          <p>{overview.country_code}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Currency</p>
          <p>{overview.currency_code}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Timezone</p>
          <p>{overview.timezone}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Created</p>
          <p>{formatDateTime(overview.created_at)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Owner</p>
          <p>{overview.owner_email ?? "—"}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Active members</p>
          <p>{overview.member_count}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Branches</p>
          <p>
            {overview.active_branch_count} active / {overview.branch_count} total
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
