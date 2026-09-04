"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Bell, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NotificationFeed } from "@/components/notifications/notification-feed";
import { getRecentNotificationsAction, markNotificationsSeenAction } from "@/lib/notifications/actions";
import { UNREAD_BADGE_CAP } from "@/lib/notifications/constants";
import type { NotificationRow } from "@/lib/notifications/dal";

// No Realtime — the unread count badge is whatever the server rendered
// for this page load (see DashboardShell's own getUnreadNotificationCount
// call); it is intentionally NOT recomputed client-side while the
// dropdown is open (opening it only marks items SEEN, never READ, and
// even an explicit read from inside the dropdown is reflected on the
// next navigation/page load, not live) — matching this phase's own
// explicit "may refresh on navigation/request... never fake live
// updates" instruction exactly. The recent list itself is fetched ONCE,
// on demand, the first time the dropdown opens per page load.
export function NotificationBell({
  businessId,
  initialUnreadCount,
}: {
  businessId: string;
  initialUnreadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && !loaded) {
      startTransition(async () => {
        try {
          const recent = await getRecentNotificationsAction(businessId);
          setRows(recent);
          setLoaded(true);
          // Opening the bell marks the visible RECENT slice as seen
          // (glanced at) — never as read. Read is reserved for an
          // explicit click on an item, or "mark all read" on the full
          // page — see this phase's own recommended read/seen split.
          const unseenIds = recent.filter((r) => r.seenAt === null).map((r) => r.id);
          if (unseenIds.length > 0) {
            void markNotificationsSeenAction(businessId, unseenIds);
          }
        } catch {
          setError(true);
        }
      });
    }
  }

  const badgeText = initialUnreadCount > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(initialUnreadCount);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={initialUnreadCount > 0 ? `Notifications, ${initialUnreadCount} unread` : "Notifications"}
            data-testid="notification-bell-trigger"
          />
        }
      >
        <Bell className="size-5" aria-hidden="true" />
        {initialUnreadCount > 0 ? (
          <span
            aria-hidden="true"
            data-testid="notification-unread-badge"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground"
          >
            {badgeText}
          </span>
        ) : null}
      </SheetTrigger>
      <SheetContent data-testid="notification-bell-sheet" side="right">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>Recent activity for this business.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {isPending && !loaded ? (
            <div className="flex items-center justify-center py-8" data-testid="notification-bell-loading">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : error ? (
            <EmptyState title="Unable to load notifications." description="Please try again." />
          ) : rows.length === 0 ? (
            <EmptyState icon={Bell} title="No notifications yet." />
          ) : (
            <NotificationFeed businessId={businessId} notifications={rows} />
          )}
        </div>
        <div className="border-t p-4">
          <Link
            href={`/${businessId}/notifications`}
            onClick={() => setOpen(false)}
            className={buttonVariants({ variant: "outline", size: "sm", className: "w-full" })}
          >
            View all notifications
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
