import type { ManagementReportingAggregate } from "@/lib/reports/dal";
import { getCurrencySymbol } from "@/lib/currency";

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

const DAY_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Normalizes a day key from the frozen aggregate to a plain "YYYY-MM-DD"
 * calendar day. Phase 1Q-0C hydration fix: the aggregate's `date` field is
 * documented as a plain UTC calendar day, but the underlying RPC builds it
 * from `generate_series(p_from::date, ..., interval '1 day')` — Postgres
 * has no `date`+`interval` series overload, so it resolves to the
 * `timestamptz` one, and `d.day::text` can come back as a full timestamptz
 * string (e.g. "2026-08-26 00:00:00+00") rather than "2026-08-26". The
 * previous `` `${date}T00:00:00Z` `` concatenation assumed the clean form;
 * fed the full-timestamp form instead, it built a non-standard, doubly-
 * timestamped string whose Date.parse result is implementation-defined —
 * Node (SSR) and the browser (hydration) can legitimately disagree on it,
 * which reproduced as exactly this chart's hydration mismatch. Extracting
 * the leading YYYY-MM-DD with a strict regex (never Date.parse on the raw
 * aggregate value) makes both the `date` key and the `label` deterministic
 * and identical server/client regardless of which form the aggregate
 * returns — no RPC/query/migration change involved, this is app-layer
 * normalization only.
 */
function normalizeDayKey(date: string): string {
  const match = DAY_KEY_PATTERN.exec(date);
  return match ? match[1] : date;
}

function formatUtcDayLabel(dayKey: string): string {
  const parsed = new Date(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dayKey;
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
    .map((day) => {
      const dayKey = normalizeDayKey(day.date);
      return {
        date: dayKey,
        label: formatUtcDayLabel(dayKey),
        revenue: safeNumber(day.revenue),
        salesCount: safeNonNegativeInteger(day.orderCount),
        averageOrderValue: safeNumber(day.averageOrderValue),
      };
    });

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

/** Compact axis-tick formatting for large amounts (e.g. "₦1.2M"). Display only — never used for tooltip exact values. Phase 1Q-0C: uses the same deterministic product symbol table as formatMoney's "symbol" mode, never the ISO code. "en-US" grouping is fixed deliberately (not business-locale-driven) to match formatMoney's own digit-grouping determinism — this chart renders for every launch country, not just NG. */
export function formatCompactCurrency(amount: number, currencyCode: string): string {
  const formatted = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(amount);
  return `${getCurrencySymbol(currencyCode)}${formatted}`;
}

export function formatIntegerTick(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}
