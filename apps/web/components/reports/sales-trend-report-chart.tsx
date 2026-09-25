"use client";

import { useId, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import {
  SALES_TREND_METRIC,
  SALES_TREND_METRIC_CONFIG,
  formatCompactCurrency,
  formatIntegerTick,
  metricValue,
  type SalesTrendChartPoint,
  type SalesTrendMetric,
} from "@/lib/reports/sales-trend-chart";

// Phase 1N-C2. Report-specific presentation only — reuses the frozen
// lib/reports/sales-trend-chart.ts model/metric helpers exactly as
// components/dashboard/sales-trend-chart.tsx does (same metric config,
// same safe-number guards, same "thin the x-axis, keep every underlying
// point" long-range behavior), but is its own component rather than a
// modification of the B2 dashboard chart: this one has no "View financial
// report" link (a detail report page needs its own Back to Reports
// affordance instead, rendered by the page itself) and no `businessId`
// prop. B2's own component and its semantics are unchanged by this file.
type Props = {
  points: SalesTrendChartPoint[];
  hasActivity: boolean;
  currencyCode: string;
  rangeLabel: string;
};

const METRIC_ORDER: SalesTrendMetric[] = [SALES_TREND_METRIC.REVENUE, SALES_TREND_METRIC.SALES, SALES_TREND_METRIC.AOV];

function formatMetricValue(metric: SalesTrendMetric, value: number, currencyCode: string): string {
  if (metric === SALES_TREND_METRIC.SALES) return formatIntegerTick(value);
  return formatMoney(value, currencyCode, { display: "symbol" });
}

function formatAxisTick(metric: SalesTrendMetric, value: number, currencyCode: string): string {
  if (metric === SALES_TREND_METRIC.SALES) return formatIntegerTick(value);
  return formatCompactCurrency(value, currencyCode);
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 28, left: 8 };

export function SalesTrendReportChart({ points, hasActivity, currencyCode, rangeLabel }: Props) {
  const [metric, setMetric] = useState<SalesTrendMetric>(SALES_TREND_METRIC.REVENUE);
  const descriptionId = useId();
  const gradientId = useId();
  const config = SALES_TREND_METRIC_CONFIG[metric];

  const values = useMemo(() => points.map((point) => metricValue(point, metric)), [points, metric]);
  const maxValue = useMemo(() => Math.max(1, ...values), [values]);

  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const coordinates = points.map((point, index) => {
    const value = values[index];
    const x = points.length === 1 ? PADDING.left + plotWidth / 2 : PADDING.left + (index / (points.length - 1)) * plotWidth;
    const y = PADDING.top + plotHeight - (value / maxValue) * plotHeight;
    return { x, y, value, point };
  });

  const linePath = coordinates.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
  const areaPath = coordinates.length > 0
    ? `${linePath} L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${(PADDING.top + plotHeight).toFixed(2)} L ${coordinates[0].x.toFixed(2)} ${(PADDING.top + plotHeight).toFixed(2)} Z`
    : "";

  // Long-range behavior: the x-axis shows at most 5 labels regardless of
  // how many days are in the period (up to 366), but every underlying
  // point still gets its own circle/tooltip and its own row in the
  // accessible daily table rendered alongside this chart — no data is
  // silently dropped, only the visual tick density is thinned.
  const tickCount = Math.min(points.length, 5);
  const tickIndexes = tickCount <= 1
    ? [0]
    : Array.from({ length: tickCount }, (_, i) => Math.round((i * (points.length - 1)) / (tickCount - 1)));
  const uniqueTickIndexes = Array.from(new Set(tickIndexes));

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>Daily trend</CardTitle>
            <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
              {config.description} {rangeLabel}.
            </p>
          </div>
          <div role="group" aria-label="Chart metric" className="inline-flex shrink-0 gap-1 rounded-lg bg-muted p-[3px]">
            {METRIC_ORDER.map((option) => {
              const isActive = option === metric;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setMetric(option)}
                  className={`min-h-8 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${isActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {SALES_TREND_METRIC_CONFIG[option].shortLabel}
                </button>
              );
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasActivity ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed py-10 pl-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No completed sales were recorded in this period.</p>
            <p>Try a different range once sales complete.</p>
          </div>
        ) : (
          <svg
            role="img"
            aria-labelledby={descriptionId}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full max-w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line x1={PADDING.left} y1={PADDING.top + plotHeight} x2={CHART_WIDTH - PADDING.right} y2={PADDING.top + plotHeight} stroke="currentColor" strokeOpacity="0.15" />
            <path d={areaPath} fill={`url(#${gradientId})`} className="text-primary" />
            <path d={linePath} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
            {coordinates.map((c) => (
              <circle key={c.point.date} cx={c.x} cy={c.y} r="3" className="fill-primary">
                <title>
                  {c.point.label}: {formatMetricValue(metric, c.value, currencyCode)}
                </title>
              </circle>
            ))}
            {uniqueTickIndexes.map((index) => {
              const c = coordinates[index];
              if (!c) return null;
              return (
                <text key={c.point.date} x={c.x} y={CHART_HEIGHT - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {c.point.label}
                </text>
              );
            })}
            <text x={PADDING.left} y={PADDING.top} className="fill-muted-foreground text-[11px]">
              {formatAxisTick(metric, maxValue, currencyCode)}
            </text>
          </svg>
        )}
      </CardContent>
    </Card>
  );
}
