import type { Metadata } from "next";
import { requirePlatformPermission } from "@/lib/platform/dal";
import { PLATFORM_PERMISSION } from "@/lib/platform/constants";
import { listPlatformBusinesses } from "@/lib/platform/businesses-dal";
import { parsePlatformBusinessQuery } from "@/lib/validation/platform-businesses";
import { BusinessDirectoryFilters } from "@/components/platform/business-directory-filters";
import { BusinessDirectoryTable } from "@/components/platform/business-directory-table";
import { BusinessDirectoryPagination } from "@/components/platform/business-directory-pagination";

export const metadata: Metadata = {
  title: "Businesses — Internal Administration",
};

// Read-only for all of 1O-B — see lib/platform/businesses-dal.ts and
// supabase/migrations/20260929080000_platform_business_directory.sql.
// requirePlatformPermission enforces platform.businesses.view + AAL2 at
// the route layer; the RPC re-verifies both independently at the
// database layer (defense in depth, matching 1O-A's own precedent).
export default async function PlatformBusinessesPage({
  searchParams,
}: PageProps<"/internal/admin/businesses">) {
  await requirePlatformPermission(PLATFORM_PERMISSION.BUSINESSES_VIEW);

  const rawQuery = await searchParams;
  const query = parsePlatformBusinessQuery(rawQuery);
  const { rows, totalCount, pageSize } = await listPlatformBusinesses(query);

  const urlSearchParams = new URLSearchParams();
  if (query.q) urlSearchParams.set("q", query.q);
  if (query.country) urlSearchParams.set("country", query.country);
  if (query.currency) urlSearchParams.set("currency", query.currency);
  if (query.plan) urlSearchParams.set("plan", query.plan);
  if (query.status) urlSearchParams.set("status", query.status);
  if (query.sort !== "created_at") urlSearchParams.set("sort", query.sort);
  if (query.dir !== "desc") urlSearchParams.set("dir", query.dir);

  const hasActiveFilters = Boolean(
    query.q || query.country || query.currency || query.plan || query.status
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        {/* h1 — matches the rest of the app's own convention (every route's
            top-level heading is an h1); flagged by the 1O-E automated
            accessibility smoke pass as a pre-existing heading-hierarchy
            defect on this route. */}
        <h1 className="text-2xl font-semibold tracking-tight">Businesses</h1>
        <p className="text-sm text-muted-foreground">
          Read-only directory of every tenant business on BusinessOS.
        </p>
      </div>

      <BusinessDirectoryFilters />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {hasActiveFilters ? "No businesses match your search or filters." : "No businesses yet."}
        </p>
      ) : (
        <>
          <BusinessDirectoryTable rows={rows} />
          <BusinessDirectoryPagination
            page={query.page}
            pageSize={pageSize}
            totalCount={totalCount}
            searchParams={urlSearchParams}
          />
        </>
      )}
    </div>
  );
}
