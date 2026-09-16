import { getBusinessMembership, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary, getManagementReportingAggregate } from "@/lib/reports/dal";
import { resolvePresetRange } from "@/lib/reports/ranges";
import { REPORT_RANGE_PRESET } from "@/lib/reports/constants";
import { ManagementOverview } from "@/components/dashboard/management-overview";

export default async function BusinessDashboardPage({
  params,
}: PageProps<"/[businessId]">) {
  const { businessId } = await params;
  const membership = await getBusinessMembership(businessId);
  const permissions = await getPermissions(businessId);

  if (permissions.has(PERMISSION.REPORTS_VIEW)) {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.LAST_30_DAYS);
    const [summary, reporting] = await Promise.all([
      getFinancialSummary(businessId, range.from, range.to),
      getManagementReportingAggregate(businessId, range.from, range.to),
    ]);
    return <ManagementOverview businessId={businessId} businessName={membership.businesses?.name ?? "Business"} summary={summary} reporting={reporting} />;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome to {membership.businesses?.name}
      </h1>
      <p className="mt-2 text-muted-foreground">
        You are signed in as {membership.roles?.name ?? "a member"}.
      </p>
    </div>
  );
}
