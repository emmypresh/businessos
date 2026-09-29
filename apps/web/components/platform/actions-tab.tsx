import { randomUUID } from "node:crypto";
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
import { SuspendBusinessDialog } from "@/components/platform/suspend-business-dialog";
import { ReactivateBusinessDialog } from "@/components/platform/reactivate-business-dialog";
import { ExtendTrialDialog } from "@/components/platform/extend-trial-dialog";
import Link from "next/link";
import {
  listPlatformBusinessActions,
  type PlatformBusinessActionContext,
} from "@/lib/platform/business-operations-dal";
import { PLATFORM_ACTION_LABEL } from "@/lib/validation/platform-actions";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatStateValue(state: Record<string, unknown>): string {
  return Object.entries(state)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

/**
 * Phase 1O-D — the "Platform Actions" section (phase instructions §30:
 * kept separate from Overview). Every button here is rendered ONLY when
 * the caller already holds the specific permission it needs AND the
 * business is in a state where the action is a legal transition — this is
 * UI convenience only; platform_suspend_business/platform_reactivate_business/
 * platform_extend_trial each independently re-check both facts again at
 * the database layer regardless of what this component decides to render
 * (phase instructions §23).
 */
export async function ActionsTab({
  businessId,
  overview,
  page,
  searchParams,
  canSuspend,
  canReactivate,
  canExtendTrial,
  canViewHistory,
  showDedicatedRouteLink = false,
}: {
  businessId: string;
  overview: PlatformBusinessActionContext;
  page: number;
  searchParams: URLSearchParams;
  canSuspend: boolean;
  canReactivate: boolean;
  canExtendTrial: boolean;
  canViewHistory: boolean;
  // Phase 1O-D remediation — shown only from the businesses.view-gated
  // support-console tab (?tab=actions), pointing at the dedicated
  // /actions route (item §8 of the remediation instructions: "the existing
  // support console MAY include a link to the dedicated route"). The
  // dedicated route itself never passes this — linking to itself would be
  // pointless — so it stays false there by default.
  showDedicatedRouteLink?: boolean;
}) {
  const historyResult = canViewHistory ? await listPlatformBusinessActions(businessId, page) : null;

  const status = overview.status;
  const isTrialing = overview.subscription?.status === "TRIALING" && overview.subscription.trial_ends_at;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Platform Actions
            <Badge variant={status === "active" ? "default" : status === "suspended" ? "destructive" : "secondary"}>
              {status}
            </Badge>
          </CardTitle>
          {showDedicatedRouteLink ? (
            <Link
              href={`/internal/admin/businesses/${businessId}/actions`}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Open dedicated actions view &rarr;
            </Link>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status === "archived" ? (
            <p className="text-sm text-muted-foreground">
              This business is archived. No controlled action is available for an archived
              business.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {canSuspend && status === "active" ? (
                <SuspendBusinessDialog
                  businessId={businessId}
                  businessName={overview.business_name}
                  idempotencyKey={randomUUID()}
                />
              ) : null}
              {canReactivate && status === "suspended" ? (
                <ReactivateBusinessDialog
                  businessId={businessId}
                  businessName={overview.business_name}
                  idempotencyKey={randomUUID()}
                />
              ) : null}
              {canExtendTrial && isTrialing ? (
                <ExtendTrialDialog
                  businessId={businessId}
                  currentTrialEndsAt={overview.subscription!.trial_ends_at as string}
                  idempotencyKey={randomUUID()}
                />
              ) : null}
              {!canSuspend && !canReactivate && !canExtendTrial ? (
                <p className="text-sm text-muted-foreground">
                  You don&apos;t hold any controlled-action permission for this business.
                </p>
              ) : null}
              {canExtendTrial && !isTrialing && status !== "archived" ? (
                <p className="text-sm text-muted-foreground">
                  Trial extension is only available while the subscription is in trial.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Action history</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!historyResult ? (
            <p className="text-sm text-muted-foreground">
              Action history is unavailable — this requires the separate platform.audit.view
              permission.
            </p>
          ) : historyResult.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No platform actions recorded yet.</p>
          ) : (
            <Table>
              <caption className="sr-only">Platform action history</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Actor</TableHead>
                  <TableHead scope="col">Action</TableHead>
                  <TableHead scope="col">Reason</TableHead>
                  <TableHead scope="col">Before → After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyResult.rows.map((row) => (
                  <TableRow key={row.action_id}>
                    <TableCell>{formatDateTime(row.occurred_at)}</TableCell>
                    <TableCell>{row.actor_email ?? "—"}</TableCell>
                    <TableCell>{PLATFORM_ACTION_LABEL[row.action_type] ?? row.action_type}</TableCell>
                    <TableCell>{row.reason}</TableCell>
                    <TableCell>
                      {formatStateValue(row.before_state)} → {formatStateValue(row.after_state)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {historyResult ? (
            <SupportPagination
              page={page}
              pageSize={historyResult.pageSize}
              totalCount={historyResult.totalCount}
              searchParams={searchParams}
              itemLabel="action(s)"
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
