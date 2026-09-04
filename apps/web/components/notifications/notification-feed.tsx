"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  CreditCard,
  Undo2,
  Wallet,
  IdCard,
  Building2,
  Bell as BellIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { StatusBadge, type StatusTone } from "@/components/dashboard/status-badge";
import { MetadataView } from "@/components/activity/metadata-view";
import {
  NOTIFICATION_CATEGORY_LABEL,
  RESOURCE_TYPE_LABEL,
  normalizeNotificationTypeLabel,
  type NotificationCategory,
} from "@/lib/notifications/constants";
import { resolveNotificationResourceLink } from "@/lib/notifications/resource-links";
import { markNotificationReadAction, markNotificationUnreadAction } from "@/lib/notifications/actions";
import type { NotificationRow } from "@/lib/notifications/dal";

const TYPE_ICON: Record<string, typeof BellIcon> = {
  "payment.recorded": CreditCard,
  "return.completed": Undo2,
  "expense.posted": Wallet,
  "staff.invited": IdCard,
  "branch.deactivated": Building2,
};

const SEVERITY_TONE: Record<string, StatusTone> = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  CRITICAL: "destructive",
};

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function NotificationFeed({
  businessId,
  notifications,
  branchNames = {},
}: {
  businessId: string;
  notifications: NotificationRow[];
  branchNames?: Record<string, string>;
}) {
  const [rows, setRows] = useState(notifications);
  const [selected, setSelected] = useState<NotificationRow | null>(null);
  const [, startTransition] = useTransition();

  if (rows.length === 0) return null;

  function actionFormData(notificationId: string): FormData {
    const fd = new FormData();
    fd.set("businessId", businessId);
    fd.set("notificationId", notificationId);
    return fd;
  }

  function toggleRead(row: NotificationRow) {
    const nowRead = row.readAt === null;
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, readAt: nowRead ? new Date().toISOString() : null } : r))
    );
    startTransition(() => {
      const fd = actionFormData(row.id);
      void (nowRead ? markNotificationReadAction(undefined, fd) : markNotificationUnreadAction(undefined, fd));
    });
  }

  function openDetail(row: NotificationRow) {
    setSelected(row);
    if (row.readAt === null) {
      setRows((prev) => (prev.map((r) => (r.id === row.id ? { ...r, readAt: new Date().toISOString() } : r))));
      startTransition(() => {
        void markNotificationReadAction(undefined, actionFormData(row.id));
      });
    }
  }

  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border" data-testid="notification-feed">
        {rows.map((row) => {
          const Icon = TYPE_ICON[row.notification_type] ?? BellIcon;
          const branchName = row.branch_id ? branchNames[row.branch_id] : null;
          const unread = row.readAt === null;
          return (
            <li key={row.id}>
              <div
                className={`flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-accent/50 ${unread ? "bg-accent/20" : ""}`}
                data-testid="notification-row"
                data-unread={unread}
              >
                <button
                  type="button"
                  onClick={() => openDetail(row)}
                  className="flex flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="relative mt-0.5 shrink-0">
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    {unread ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm ${unread ? "font-semibold" : "font-medium"}`}>{row.title}</p>
                    {row.body ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.body}</p> : null}
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      <time dateTime={row.created_at}>{formatTimestamp(row.created_at)}</time>
                      {branchName ? ` · ${branchName}` : ""}
                    </p>
                  </div>
                </button>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <StatusBadge
                    status={row.severity}
                    label={row.severity.charAt(0) + row.severity.slice(1).toLowerCase()}
                    tone={SEVERITY_TONE[row.severity] ?? "neutral"}
                  />
                  <button
                    type="button"
                    onClick={() => toggleRead(row)}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    data-testid="notification-toggle-read"
                  >
                    {unread ? "Mark read" : "Mark unread"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent data-testid="notification-detail-sheet">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{selected.title}</SheetTitle>
                <SheetDescription>
                  <time dateTime={selected.created_at}>{formatTimestamp(selected.created_at)}</time>
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 text-sm">
                {selected.body ? <p className="text-sm">{selected.body}</p> : null}
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt className="text-muted-foreground">Category</dt>
                  <dd className="text-right">
                    {NOTIFICATION_CATEGORY_LABEL[selected.category as NotificationCategory] ?? selected.category}
                  </dd>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="text-right">{normalizeNotificationTypeLabel(selected.notification_type)}</dd>
                  {selected.branch_id ? (
                    <>
                      <dt className="text-muted-foreground">Branch</dt>
                      <dd className="text-right">{branchNames[selected.branch_id] ?? "—"}</dd>
                    </>
                  ) : null}
                  {selected.resource_type ? (
                    <>
                      <dt className="text-muted-foreground">Related to</dt>
                      <dd className="text-right">
                        {(() => {
                          const label = RESOURCE_TYPE_LABEL[selected.resource_type] ?? selected.resource_type;
                          const href = resolveNotificationResourceLink(
                            businessId,
                            selected.resource_type,
                            selected.resource_id
                          );
                          return href ? (
                            <Link href={href} className="text-primary underline-offset-2 hover:underline">
                              {label}
                            </Link>
                          ) : (
                            label
                          );
                        })()}
                      </dd>
                    </>
                  ) : null}
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
