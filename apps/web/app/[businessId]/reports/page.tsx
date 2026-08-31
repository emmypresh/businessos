import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary } from "@/lib/reports/dal";
import { resolveReportRange } from "@/lib/reports/ranges";
import { REPORT_RANGE_PRESET, type ReportRangePreset } from "@/lib/reports/constants";
import { CustomReportRangeSchema } from "@/lib/validation/reports";
import { listReportBranchOptions } from "@/lib/branches/dal";
import { BRANCH_STATUS } from "@/lib/branches/constants";
import { DateRangePicker } from "@/components/reports/date-range-picker";
import { FinancialKpiCards } from "@/components/reports/financial-kpi-cards";
import { FinancialCharts } from "@/components/reports/financial-charts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { z } from "zod";

const BranchParamSchema = z.uuid();

const PRESET_VALUES = Object.values(REPORT_RANGE_PRESET);

// This route requires ONLY reports.view — never sales.view, never
// expenses.view. It renders EXCLUSIVELY through getFinancialSummary
// (get_financial_summary), which runs under its own dedicated BYPASSRLS
// reader role for exactly this reason: a caller holding reports.view
// without sales.view/expenses.view must still see the real aggregate,
// and no raw sale/expense row is ever queried or rendered on this page —
// see lib/reports/dal.ts's own header comment. This is the single most
// important invariant of Phase 1E's reporting surface; do not add a
// listSales/listExpenses call to this file.
export default async function ReportsPage({
  params,
  searchParams,
}: PageProps<"/[businessId]/reports">) {
  const { businessId } = await params;
  const query = await searchParams;

  await requirePermissionOrNotFound(businessId, PERMISSION.REPORTS_VIEW);

  // Phase 1G: reports.view is a broad, business-wide financial-oversight
  // permission (see get_financial_summary's own header comment) — the
  // branch picker offers EVERY branch of the business, active or
  // INACTIVE, since historical reporting for a since-deactivated branch
  // must remain available (inactive only ever means "no new operational
  // activity"). A malformed or foreign `?branch=` value is validated
  // against this exact list and silently dropped (falls back to
  // company-wide) if it doesn't match a real branch — never forwarded to
  // the RPC as a raw, unverified value, and never disclosing whether a
  // rejected id merely doesn't exist or belongs to another business.
  const allBranches = await listReportBranchOptions(businessId);
  const rawBranchParam = typeof query.branch === "string" ? query.branch : undefined;
  const branchParamParsed = rawBranchParam ? BranchParamSchema.safeParse(rawBranchParam) : undefined;
  const selectedBranch =
    branchParamParsed?.success ? allBranches.find((b) => b.id === branchParamParsed.data) : undefined;
  const branchId = selectedBranch?.id;

  const presetParam = typeof query.preset === "string" ? query.preset : undefined;
  const preset: ReportRangePreset = PRESET_VALUES.includes(presetParam as ReportRangePreset)
    ? (presetParam as ReportRangePreset)
    : REPORT_RANGE_PRESET.LAST_30_DAYS;

  let rangeError: string | null = null;
  let custom: { dateFrom: string; dateTo: string } | null = null;

  if (preset === REPORT_RANGE_PRESET.CUSTOM) {
    const parsed = CustomReportRangeSchema.safeParse({
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    if (parsed.success) {
      custom = parsed.data;
    } else if (typeof query.dateFrom === "string" || typeof query.dateTo === "string") {
      // Only surface an error once the caller has actually attempted a
      // custom range (both fields blank on first load is not an error —
      // it's just "pick a range yet").
      rangeError = parsed.error.issues[0]?.message ?? "Enter a valid date range.";
    }
  }

  const range = rangeError ? null : resolveReportRange(preset, custom);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Financial overview</h1>
        {/* The selected scope is always visible right under the title —
            a branch-filtered report must never look visually
            indistinguishable from the company-wide one. */}
        {/* data-testid: Codex adversarial review, application-layer
            round 3, Medium 2 fixed the branch Select's own closed
            trigger to also display a real label ("Company-wide") instead
            of a raw sentinel/UUID — meaning this paragraph's plain-text
            scope label and the Select's own trigger text can now be
            identical simultaneously, which a plain getByText(..., {exact:
            true}) can no longer disambiguate. This testid is what E2E
            asserts against instead. */}
        <p className="text-sm font-medium text-foreground" data-testid="report-scope-label">
          {selectedBranch ? selectedBranch.name : "Company-wide"}
          {selectedBranch?.status === BRANCH_STATUS.INACTIVE ? " (inactive)" : ""}
        </p>
        {/* Deliberately avoids the word "profit" entirely, per §31 of the
            approved plan — not even in a minimal disclaimer — since
            "cash flow" on its own already communicates the distinction
            without introducing the term at all. */}
        <p className="text-sm text-muted-foreground">
          Gross sales, cash collected, outstanding sales, and expenses for the selected period.
        </p>
      </div>

      <DateRangePicker branches={allBranches.map((b) => ({ id: b.id, name: b.name, status: b.status }))} />

      {rangeError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{rangeError}</AlertDescription>
        </Alert>
      ) : !range ? (
        <p className="text-muted-foreground">Choose a start and end date to see the report.</p>
      ) : (
        <ReportContent businessId={businessId} from={range.from} to={range.to} branchId={branchId} />
      )}
    </div>
  );
}

async function ReportContent({
  businessId,
  from,
  to,
  branchId,
}: {
  businessId: string;
  from: string;
  to: string;
  branchId: string | undefined;
}) {
  const summary = await getFinancialSummary(businessId, from, to, branchId);
  const hasActivity = summary.salesCount > 0 || summary.expenseCount > 0;

  return (
    <div className="flex flex-col gap-6">
      {!hasActivity ? (
        <Alert>
          <AlertDescription>
            {branchId
              ? "No sales or expense activity for this branch in this range."
              : "No sales or expense activity in this range."}
          </AlertDescription>
        </Alert>
      ) : null}
      <FinancialKpiCards summary={summary} />
      <FinancialCharts summary={summary} />
    </div>
  );
}
