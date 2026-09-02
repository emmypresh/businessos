import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listActivityEvents, getActivityBranchOptions, getActivityActorOptions } from "@/lib/audit/dal";
import { ActivityFilterSchema } from "@/lib/validation/audit";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ActivityFilters } from "@/components/activity/activity-filters";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { PaginationLink } from "@/components/pagination-link";
import { Activity } from "lucide-react";

export default async function ActivityPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/activity">) {
  const { businessId } = await params;
  const query = await searchParams;

  // audit.view is required to even reach this page — never staff.view,
  // branches.view, or any other unrelated permission (see
  // lib/audit/dal.ts's own header comments on why the branch/actor
  // filters below never depend on either).
  await requirePermissionOrNotFound(businessId, PERMISSION.AUDIT_VIEW);

  const parsedFilters = ActivityFilterSchema.safeParse({
    search: typeof query.search === "string" ? query.search : undefined,
    category: typeof query.category === "string" ? query.category : undefined,
    branchId: typeof query.branch === "string" ? query.branch : undefined,
    actorUserId: typeof query.actor === "string" ? query.actor : undefined,
    dateFrom: typeof query.from === "string" ? query.from : undefined,
    dateTo: typeof query.to === "string" ? query.to : undefined,
  });
  const filters = parsedFilters.success ? parsedFilters.data : {};
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const [allBranches, allActors] = await Promise.all([
    getActivityBranchOptions(businessId),
    getActivityActorOptions(businessId),
  ]);
  const branchId = filters.branchId && allBranches.some((b) => b.id === filters.branchId) ? filters.branchId : undefined;
  const actorUserId =
    filters.actorUserId && allActors.some((a) => a.userId === filters.actorUserId) ? filters.actorUserId : undefined;

  const { rows, nextCursor } = await listActivityEvents(businessId, {
    search: filters.search,
    category: filters.category,
    branchId,
    actorUserId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    cursor,
  });

  const branchNames = Object.fromEntries(allBranches.map((b) => [b.id, b.name]));

  const hasFilters = Boolean(filters.search || filters.category || branchId || actorUserId || filters.dateFrom || filters.dateTo);
  const baseParams = new URLSearchParams();
  if (filters.search) baseParams.set("search", filters.search);
  if (filters.category) baseParams.set("category", filters.category);
  if (branchId) baseParams.set("branch", branchId);
  if (actorUserId) baseParams.set("actor", actorUserId);
  if (filters.dateFrom) baseParams.set("from", filters.dateFrom);
  if (filters.dateTo) baseParams.set("to", filters.dateTo);
  const baseHref = `/${businessId}/activity?${baseParams.toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity" />

      <ActivityFilters
        branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))}
        actors={allActors}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={hasFilters ? "No activity matches your search." : "No activity has been recorded yet."}
          description={
            !hasFilters
              ? "Activity recorded from now on — sales, returns, invoices, and other key actions — will appear here."
              : undefined
          }
        />
      ) : (
        <>
          <ActivityFeed events={rows} branchNames={branchNames} />
          <PaginationLink href={baseHref} nextCursor={nextCursor} />
        </>
      )}
    </div>
  );
}
