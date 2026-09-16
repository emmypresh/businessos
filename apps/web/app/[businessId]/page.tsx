import { getBusinessMembership, getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary, getManagementReportingAggregate } from "@/lib/reports/dal";
import { resolveComparableRange, resolvePresetRange } from "@/lib/reports/ranges";
import { REPORT_RANGE_PRESET } from "@/lib/reports/constants";
import { ManagementOverview } from "@/components/dashboard/management-overview";

export default async function BusinessDashboardPage({
  params,
}: PageProps<"/[businessId]">) {
  const { businessId } = await params;
  const membership = await getBusinessMembership(businessId);
  const permissions = await getPermissions(businessId);

  if (permissions.has(PERMISSION.REPORTS_VIEW)) {
    const range = resolveComparableRange(resolvePresetRange(REPORT_RANGE_PRESET.LAST_30_DAYS));
    const [summary, previousSummary, reporting, previousReporting] = await Promise.all([
      getFinancialSummary(businessId, range.current.from, range.current.to),
      getFinancialSummary(businessId, range.previous.from, range.previous.to),
      getManagementReportingAggregate(businessId, range.current.from, range.current.to),
      getManagementReportingAggregate(businessId, range.previous.from, range.previous.to),
    ]);
    return <ManagementOverview businessId={businessId} businessName={membership.businesses?.name ?? "Business"} summary={summary} previousSummary={previousSummary} reporting={reporting} previousReporting={previousReporting} />;
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
