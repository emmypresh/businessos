"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
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

type Props = {
  businessId: string;
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

// Wider aspect ratio (was 640x220, ~2.9:1) so the responsive SVG
// (preserveAspectRatio + w-full) settles at an ArchitectUI-like
// ~300-380px visible height at typical dashboard content widths instead
// of growing past 600px on ultrawide screens — see this file's own
// `max-w-5xl` wrapper below, which additionally caps the rendered width
// so the card never has to stretch this tall even at extreme viewports.
const CHART_WIDTH = 960;
const CHART_HEIGHT = 300;
const PADDING = { top: 16, right: 16, bottom: 28, left: 8 };

export function SalesTrendChart({ businessId, points, hasActivity, currencyCode, rangeLabel }: Props) {
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

  const tickCount = Math.min(points.length, 5);
  const tickIndexes = tickCount <= 1
    ? [0]
    : Array.from({ length: tickCount }, (_, i) => Math.round((i * (points.length - 1)) / (tickCount - 1)));
  const uniqueTickIndexes = Array.from(new Set(tickIndexes));

  return (
    <Card>
      <CardHeader className="gap-3 border-b pb-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>Sales &amp; revenue trend</CardTitle>
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
            <p className="font-medium text-foreground">No completed sales in this period</p>
            <p>{rangeLabel}. Try a different range or check back once sales complete.</p>
          </div>
        ) : (
          <>
            {/* max-w-5xl caps the rendered width on ultrawide viewports —
                without it, the responsive SVG (w-full) grows tall in
                lockstep with an unbounded-width card, which is exactly
                the "chart is too tall on ultrawide" defect this pass
                fixes. Chart data/points are unaffected; only the visual
                render size changes. */}
            <svg
              role="img"
              aria-labelledby={descriptionId}
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              className="mx-auto w-full max-w-5xl"
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
                // A nested <title> CHILD ELEMENT here (rather than a
                // `title` attribute) reproduces a confirmed SSR/hydration
                // mismatch: React 19's built-in document-metadata
                // ("Float") support treats every <title> host element as
                // a hoistable page-title resource by tag name alone, not
                // namespace-aware — it strips this SVG tooltip title's
                // text out of its SSR position (leaving <title></title>
                // empty for all 30 points), while the client keeps it
                // inline post-hydration, producing a 100% reproducible
                // React error #418 on every dashboard load. The `title`
                // attribute form below renders the same native
                // hover-tooltip behavior without going through that
                // element-hoisting path. The sr-only <table> further
                // below remains the real accessible-name mechanism for
                // this chart; this is a mouse-hover convenience only.
                <circle
                  key={c.point.date}
                  cx={c.x}
                  cy={c.y}
                  r="3"
                  className="fill-primary"
                  // `title` is a valid, browser-supported global attribute
                  // on SVG elements (renders the same native hover
                  // tooltip), but @types/react's SVGProps doesn't list it
                  // — spread it in rather than widening the whole
                  // element's prop type.
                  {...{ title: `${c.point.label}: ${formatMetricValue(metric, c.value, currencyCode)}` }}
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
                {formatAxisTick(metric, maxValue, currencyCode)}
              </text>
            </svg>
            <table className="sr-only">
              <caption>{config.label} by day, {rangeLabel}</caption>
              <thead>
                <tr><th scope="col">Date</th><th scope="col">{config.label}</th></tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.date}><td>{point.label}</td><td>{formatMetricValue(metric, metricValue(point, metric), currencyCode)}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="mt-4">
          <Link href={`/${businessId}/reports`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            View financial report <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
