"use client";

import { useId, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { buildSalesTrendChartModel, formatCompactCurrency } from "@/lib/reports/sales-trend-chart";

// Phase 1N-C4 — single-metric (revenue only, no toggle) daily trend for the
// selected branch drilldown. Reuses buildSalesTrendChartModel purely for
// its hydration-safe UTC day-key normalization/labeling (Phase 1Q-0C fix —
// see lib/reports/sales-trend-chart.ts's own header comment); orderCount
// and averageOrderValue are fed as 0 placeholders and never read here,
// since get_branch_detail_report's own trend field is revenue-only by
// design (§13 of the approved plan: one useful branch trend, revenue over
// time). This is a standalone component, not a reduced-props variant of
// SalesTrendReportChart — that component's metric toggle has no meaning
// here (there is no per-branch daily sales-count/AOV series).
type Props = {
  points: { date: string; revenue: number }[];
  currencyCode: string;
  rangeLabel: string;
};

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const PADDING = { top: 16, right: 16, bottom: 28, left: 8 };

export function BranchTrendChart({ points, currencyCode, rangeLabel }: Props) {
  const descriptionId = useId();
  const gradientId = useId();

  const model = useMemo(
    () => buildSalesTrendChartModel(points.map((p) => ({ date: p.date, revenue: p.revenue, orderCount: 0, averageOrderValue: 0 }))),
    [points]
  );

  const values = model.points.map((p) => p.revenue);
  const maxValue = Math.max(1, ...values);

  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const coordinates = model.points.map((point, index) => {
    const x = model.points.length === 1 ? PADDING.left + plotWidth / 2 : PADDING.left + (index / (model.points.length - 1)) * plotWidth;
    const y = PADDING.top + plotHeight - (point.revenue / maxValue) * plotHeight;
    return { x, y, point };
  });

  const linePath = coordinates.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
  const areaPath =
    coordinates.length > 0
      ? `${linePath} L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${(PADDING.top + plotHeight).toFixed(2)} L ${coordinates[0].x.toFixed(2)} ${(PADDING.top + plotHeight).toFixed(2)} Z`
      : "";

  const tickCount = Math.min(model.points.length, 5);
  const tickIndexes = tickCount <= 1 ? [0] : Array.from({ length: tickCount }, (_, i) => Math.round((i * (model.points.length - 1)) / (tickCount - 1)));
  const uniqueTickIndexes = Array.from(new Set(tickIndexes));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue trend</CardTitle>
        <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
          Daily completed-sales revenue at this branch {rangeLabel}.
        </p>
      </CardHeader>
      <CardContent>
        {!model.hasActivity ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed py-10 pl-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No completed sales were recorded at this branch in this period.</p>
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
              <circle
                key={c.point.date}
                cx={c.x}
                cy={c.y}
                r="3"
                className="fill-primary"
                {...{ title: `${c.point.label}: ${formatMoney(c.point.revenue, currencyCode, { display: "symbol" })}` }}
              />
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
              {formatCompactCurrency(maxValue, currencyCode)}
            </text>
          </svg>
        )}
      </CardContent>
    </Card>
  );
}
