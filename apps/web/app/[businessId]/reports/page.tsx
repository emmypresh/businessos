import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getFinancialSummary } from "@/lib/reports/dal";
import { resolveReportRange } from "@/lib/reports/ranges";
import { REPORT_RANGE_PRESET, type ReportRangePreset } from "@/lib/reports/constants";
import { CustomReportRangeSchema } from "@/lib/validation/reports";
import { DateRangePicker } from "@/components/reports/date-range-picker";
import { FinancialKpiCards } from "@/components/reports/financial-kpi-cards";
import { FinancialCharts } from "@/components/reports/financial-charts";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
        {/* Deliberately avoids the word "profit" entirely, per §31 of the
            approved plan — not even in a minimal disclaimer — since
            "cash flow" on its own already communicates the distinction
            without introducing the term at all. */}
        <p className="text-sm text-muted-foreground">
          Gross sales, cash collected, outstanding sales, and expenses for the selected period.
        </p>
      </div>

      <DateRangePicker />

      {rangeError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{rangeError}</AlertDescription>
        </Alert>
      ) : !range ? (
        <p className="text-muted-foreground">Choose a start and end date to see the report.</p>
      ) : (
        <ReportContent businessId={businessId} from={range.from} to={range.to} />
      )}
    </div>
  );
}

async function ReportContent({ businessId, from, to }: { businessId: string; from: string; to: string }) {
  const summary = await getFinancialSummary(businessId, from, to);
  const hasActivity = summary.salesCount > 0 || summary.expenseCount > 0;

  return (
    <div className="flex flex-col gap-6">
      {!hasActivity ? (
        <Alert>
          <AlertDescription>No sales or expense activity in this range.</AlertDescription>
        </Alert>
      ) : null}
      <FinancialKpiCards summary={summary} />
      <FinancialCharts summary={summary} />
    </div>
  );
}
