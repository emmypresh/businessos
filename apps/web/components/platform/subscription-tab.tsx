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

export function SubscriptionTab({ overview }: { overview: PlatformBusinessOverview }) {
  const subscription = overview.subscription;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        {subscription ? (
          <>
            <div>
              <p className="text-muted-foreground">Plan</p>
              <p>{subscription.plan_name ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <Badge>{subscription.status}</Badge>
            </div>
            {subscription.status === "TRIALING" ? (
              <div>
                <p className="text-muted-foreground">Trial ends</p>
                <p>{formatDateTime(subscription.trial_ends_at)}</p>
              </div>
            ) : (
              <div>
                <p className="text-muted-foreground">Current period ends</p>
                <p>{formatDateTime(subscription.current_period_ends_at)}</p>
              </div>
            )}
            {subscription.cancel_at_period_end ? (
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
  );
}
