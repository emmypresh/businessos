"use client";

import { useState } from "react";
import {
  ShoppingCart,
  Undo2,
  Wallet,
  FileText,
  CreditCard,
  Boxes,
  UserRound,
  Building2,
  IdCard,
  Package,
  Activity as ActivityIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { MetadataView } from "@/components/activity/metadata-view";
import { normalizeActionLabel, AUDIT_CATEGORY_LABEL, RESOURCE_TYPE_LABEL, type AuditCategory } from "@/lib/audit/constants";
import type { ActivityEventRow } from "@/lib/audit/dal";

const CATEGORY_ICON: Record<string, typeof ActivityIcon> = {
  COMMERCE: ShoppingCart,
  INVENTORY: Boxes,
  FINANCE: Wallet,
  CUSTOMER: UserRound,
  ORGANIZATION: Building2,
  SECURITY: IdCard,
  SYSTEM: ActivityIcon,
};

// Overrides the category icon for a couple of actions where a more
// specific icon reads better than the generic category one.
const ACTION_ICON: Record<string, typeof ActivityIcon> = {
  "return.created": Undo2,
  "invoice.created": FileText,
  "payment.recorded": CreditCard,
  "product.created": Package,
};

function actorLabel(event: ActivityEventRow): string {
  return event.actor_name_snapshot ?? event.actor_email_snapshot ?? (event.actor_type === "SYSTEM" ? "System" : "Unknown");
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ActivityFeed({
  events,
  branchNames,
}: {
  events: ActivityEventRow[];
  branchNames: Record<string, string>;
}) {
  const [selected, setSelected] = useState<ActivityEventRow | null>(null);

  if (events.length === 0) return null;

  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border" data-testid="activity-feed">
        {events.map((event) => {
          const Icon = ACTION_ICON[event.action] ?? CATEGORY_ICON[event.category] ?? ActivityIcon;
          const branchName = event.branch_id ? branchNames[event.branch_id] : null;
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => setSelected(event)}
                className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="activity-row"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {actorLabel(event)} — {normalizeActionLabel(event.action)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    <time dateTime={event.created_at}>{formatTimestamp(event.created_at)}</time>
                    {branchName ? ` · ${branchName}` : ""}
                    {event.resource_label_snapshot ? ` · ${event.resource_label_snapshot}` : ""}
                  </p>
                </div>
                <StatusBadge
                  status={event.category}
                  label={AUDIT_CATEGORY_LABEL[event.category as AuditCategory] ?? event.category}
                  tone="info"
                  className="shrink-0"
                />
              </button>
            </li>
          );
        })}
      </ul>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent data-testid="activity-detail-sheet">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{normalizeActionLabel(selected.action)}</SheetTitle>
                <SheetDescription>
                  <time dateTime={selected.created_at}>{formatTimestamp(selected.created_at)}</time>
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 text-sm">
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt className="text-muted-foreground">Actor</dt>
                  <dd className="text-right">{actorLabel(selected)}</dd>
                  <dt className="text-muted-foreground">Category</dt>
                  <dd className="text-right">
                    {AUDIT_CATEGORY_LABEL[selected.category as AuditCategory] ?? selected.category}
                  </dd>
                  {selected.branch_id ? (
                    <>
                      <dt className="text-muted-foreground">Branch</dt>
                      <dd className="text-right">{branchNames[selected.branch_id] ?? "—"}</dd>
                    </>
                  ) : null}
                  {selected.resource_type ? (
                    <>
                      <dt className="text-muted-foreground">Resource</dt>
                      <dd className="text-right">
                        {RESOURCE_TYPE_LABEL[selected.resource_type] ?? selected.resource_type}
                        {selected.resource_label_snapshot ? ` — ${selected.resource_label_snapshot}` : ""}
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Outcome</dt>
                  <dd className="text-right">
                    <StatusBadge
                      status={selected.outcome}
                      tone={selected.outcome === "SUCCESS" ? "success" : "destructive"}
                    />
                  </dd>
                </dl>
                <div>
                  <p className="mb-1 font-medium">Details</p>
                  <MetadataView metadata={selected.metadata} />
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
