import Link from "next/link";
import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getInventoryOverview, getLocationsForBranch } from "@/lib/inventory/dal";
import { listInventoryFilterBranchOptions } from "@/lib/branches/dal";
import { buttonVariants } from "@/components/ui/button";
import { InventoryOverviewTable } from "@/components/inventory/inventory-overview-table";
import { InventoryBranchFilter } from "@/components/inventory/inventory-branch-filter";
import { PaginationLink } from "@/components/pagination-link";

const ALL_BRANCHES_LABEL = "All branches";

// Codex adversarial review, application-layer round 2, Blocker 3:
// inventory.view is a business-wide read permission, exactly like
// sales.view/reports.view — it was never gated on branch assignment
// before Phase 1G. Branch awareness here is a FILTER/context enhancement
// on top of that existing business-wide visibility, never a new
// authorization boundary: a caller with inventory.view sees every branch's
// stock by default (preserving the pre-Phase-1G default exactly), and may
// optionally narrow to one specific branch. This is why the branch picker
// itself is business-wide (listInventoryFilterBranchOptions), never the
// caller's own operational assignment (getOperationalBranchOptions) —
// unlike sales/opening-stock/inventory-ADJUSTMENT, which genuinely are
// tied to where the caller can operate.
export default async function InventoryPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/inventory">) {
  const { businessId } = await params;
  const query = await searchParams;
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;

  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.INVENTORY_VIEW);
  const canAdjust = permissions.has(PERMISSION.INVENTORY_ADJUST);

  const branches = await listInventoryFilterBranchOptions(businessId);
  const rawBranch = typeof query.branch === "string" ? query.branch : undefined;
  const selectedBranch = rawBranch ? branches.find((b) => b.id === rawBranch) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <div className="flex items-center gap-2">
          <Link href={`/${businessId}/inventory/history`} className={buttonVariants({ variant: "outline" })}>
            History
          </Link>
          {canAdjust ? (
            <Link href={`/${businessId}/inventory/adjust`} className={buttonVariants()}>
              Adjust stock
            </Link>
          ) : null}
        </div>
      </div>

      <InventoryBranchFilter branches={branches} allLabel={ALL_BRANCHES_LABEL} />
      <InventoryOverviewContent
        businessId={businessId}
        selectedBranchId={selectedBranch?.id}
        scopeLabel={selectedBranch?.name ?? ALL_BRANCHES_LABEL}
        rawBranchParam={rawBranch}
        cursor={cursor}
      />
    </div>
  );
}

async function InventoryOverviewContent({
  businessId,
  selectedBranchId,
  scopeLabel,
  rawBranchParam,
  cursor,
}: {
  businessId: string;
  selectedBranchId: string | undefined;
  scopeLabel: string;
  rawBranchParam: string | undefined;
  cursor: string | undefined;
}) {
  // A malformed or unrecognized `?branch=` value (including "all") never
  // reaches here as selectedBranchId at all — the page above already
  // resolved it against the real business-wide branch list, silently
  // falling back to "All branches" (locationIds omitted, business-wide)
  // for anything that doesn't match a real ACTIVE branch.
  const locationIds = selectedBranchId
    ? (await getLocationsForBranch(businessId, selectedBranchId)).map((l) => l.id)
    : undefined;

  const { rows, nextCursor } = await getInventoryOverview(businessId, { cursor, locationIds, scopeLabel });

  const baseHref =
    `/${businessId}/inventory?` +
    new URLSearchParams(rawBranchParam ? { branch: rawBranchParam } : {}).toString();

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground">
        {selectedBranchId ? `No stock at ${scopeLabel} yet.` : "No tracked products yet."}
      </p>
    );
  }

  return (
    <>
      <InventoryOverviewTable businessId={businessId} rows={rows} />
      <PaginationLink href={baseHref} nextCursor={nextCursor} />
    </>
  );
}
