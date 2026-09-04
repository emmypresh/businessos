import Link from "next/link";
import { getBusinessMembership } from "@/lib/business/dal";
import {
  listNotificationsForCurrentUser,
  getNotificationBranchOptions,
} from "@/lib/notifications/dal";
import { NotificationFilterSchema } from "@/lib/validation/notifications";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NotificationFilters } from "@/components/notifications/notification-filters";
import { NotificationFeed } from "@/components/notifications/notification-feed";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { PaginationLink } from "@/components/pagination-link";
import { buttonVariants } from "@/components/ui/button";
import { Bell, Settings } from "lucide-react";

export default async function NotificationsPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/notifications">) {
  const { businessId } = await params;
  const query = await searchParams;

  // Permissionless personal inbox — gated on active business membership
  // ALONE (getBusinessMembership itself throws notFound() otherwise),
  // never any operational permission. See lib/notifications/dal.ts's own
  // header comment for the full rationale.
  await getBusinessMembership(businessId);

  const parsedFilters = NotificationFilterSchema.safeParse({
    search: typeof query.search === "string" ? query.search : undefined,
    category: typeof query.category === "string" ? query.category : undefined,
    severity: typeof query.severity === "string" ? query.severity : undefined,
    readState: typeof query.read === "string" ? query.read : undefined,
  });
  const filters = parsedFilters.success ? parsedFilters.data : {};
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const [{ rows, nextCursor }, branches] = await Promise.all([
    listNotificationsForCurrentUser(businessId, {
      search: filters.search,
      category: filters.category,
      severity: filters.severity,
      readState: filters.readState,
      cursor,
    }),
    getNotificationBranchOptions(businessId),
  ]);

  const branchNames = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  const hasFilters = Boolean(filters.search || filters.category || filters.severity || filters.readState);
  const baseParams = new URLSearchParams();
  if (filters.search) baseParams.set("search", filters.search);
  if (filters.category) baseParams.set("category", filters.category);
  if (filters.severity) baseParams.set("severity", filters.severity);
  if (filters.readState) baseParams.set("read", filters.readState);
  const baseHref = `/${businessId}/notifications?${baseParams.toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        actions={
          <>
            <MarkAllReadButton businessId={businessId} />
            <Link
              href={`/${businessId}/notifications/preferences`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Settings className="size-4" />
              Preferences
            </Link>
          </>
        }
      />

      <NotificationFilters />

      {rows.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={hasFilters ? "No notifications match your search." : "No notifications yet."}
          description={
            !hasFilters ? "Notifications about key business activity will appear here." : undefined
          }
        />
      ) : (
        <>
          <NotificationFeed businessId={businessId} notifications={rows} branchNames={branchNames} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
