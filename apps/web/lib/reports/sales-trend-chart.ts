import type { ManagementReportingAggregate } from "@/lib/reports/dal";

export const SALES_TREND_METRIC = {
  REVENUE: "revenue",
  SALES: "sales",
  AOV: "aov",
} as const;

export type SalesTrendMetric = (typeof SALES_TREND_METRIC)[keyof typeof SALES_TREND_METRIC];

export type SalesTrendChartPoint = {
  /** UTC calendar day, e.g. "2026-09-15" — the frozen aggregate's own bucket key, never reinterpreted. */
  date: string;
  /** Human-readable UTC date label for axis ticks/tooltips (e.g. "Sep 15") — display only, never used for ordering. */
  label: string;
  /** Completed-sales revenue for the day, exactly as returned by the frozen aggregate. */
  revenue: number;
  /** Completed sales count for the day — always a non-negative integer. */
  salesCount: number;
  /** Daily completed-sales revenue / completed-sales count, or 0 on a zero-sales day — the frozen aggregate's own value, never recomputed here. */
  averageOrderValue: number;
};

export type SalesTrendChartModel = {
  points: SalesTrendChartPoint[];
  /** True when at least one day in the period has completed-sales revenue or count. */
  hasActivity: boolean;
};

function formatUtcDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * Converts the frozen daily sales_trend aggregate (lib/reports/dal.ts's
 * ManagementReportingAggregate.salesTrend) into presentation-safe chart
 * points. Purely presentational: it never recomputes revenue, count, or
 * average order value — those are the frozen aggregate's own numbers —
 * it only sorts defensively by date, guards against non-finite values,
 * and adds a display label. Zero-activity days are preserved, never
 * dropped, so the x-axis represents the whole selected period.
 */
export function buildSalesTrendChartModel(salesTrend: ManagementReportingAggregate["salesTrend"]): SalesTrendChartModel {
  const points = [...salesTrend]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((day) => ({
      date: day.date,
      label: formatUtcDayLabel(day.date),
      revenue: safeNumber(day.revenue),
      salesCount: safeNonNegativeInteger(day.orderCount),
      averageOrderValue: safeNumber(day.averageOrderValue),
    }));

  return {
    points,
    hasActivity: points.some((point) => point.revenue !== 0 || point.salesCount !== 0),
  };
}

export function metricValue(point: SalesTrendChartPoint, metric: SalesTrendMetric): number {
  if (metric === SALES_TREND_METRIC.REVENUE) return point.revenue;
  if (metric === SALES_TREND_METRIC.SALES) return point.salesCount;
  return point.averageOrderValue;
}

export const SALES_TREND_METRIC_CONFIG: Record<SalesTrendMetric, { label: string; shortLabel: string; description: string }> = {
  [SALES_TREND_METRIC.REVENUE]: { label: "Revenue", shortLabel: "Revenue", description: "Completed-sales revenue per day." },
  [SALES_TREND_METRIC.SALES]: { label: "Completed sales", shortLabel: "Sales", description: "Completed sales count per day." },
  [SALES_TREND_METRIC.AOV]: { label: "Average order value", shortLabel: "AOV", description: "Daily completed-sales revenue divided by daily completed sales count." },
};

/** Compact axis-tick formatting for large Naira amounts (e.g. "NGN 1.2M"). Display only — never used for tooltip exact values. */
export function formatCompactCurrency(amount: number, currencyCode: string): string {
  const formatted = new Intl.NumberFormat("en-NG", { notation: "compact", maximumFractionDigits: 1 }).format(amount);
  return `${currencyCode} ${formatted}`;
}

export function formatIntegerTick(value: number): string {
  return new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 }).format(Math.round(value));
}
