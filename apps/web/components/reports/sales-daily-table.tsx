import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import type { SalesTrendChartPoint } from "@/lib/reports/sales-trend-chart";

// Phase 1N-C2. A visible, accessible daily breakdown — never client-side
// paginated (max 366 rows, matching the 366-day range cap; the shared
// components/ui/table.tsx wraps this in a horizontal-scroll container, not
// a page-shrinking one). `points` is exactly buildSalesTrendChartModel's
// own output: already sorted chronologically ascending by the frozen
// aggregate's UTC calendar-day bucket, with zero-activity days retained,
// never dropped or reordered here.
//
// UI3: wraps the table in the same report-card framing (bordered/shadowed
// Card, border-b header) as financial-charts.tsx's comparison panels and
// sales-trend-report-chart.tsx, so the daily breakdown reads as a report
// panel rather than a bare table floating on the canvas. The page's own
// "sales-daily-heading" id/aria-labelledby wiring is unchanged — this
// component still renders that exact heading text as its CardTitle.
export function SalesDailyTable({ points, currencyCode }: { points: SalesTrendChartPoint[]; currencyCode: string }) {
  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle className="text-base">Daily breakdown</CardTitle>
        <p className="text-sm text-muted-foreground">Revenue, completed sales, and average order value by day.</p>
      </CardHeader>
      <CardContent className="pt-4">
        <Table>
          <TableCaption className="sr-only">Daily completed-sales revenue, completed sales, and average order value</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col" className="text-right">Revenue</TableHead>
              <TableHead scope="col" className="text-right">Completed sales</TableHead>
              <TableHead scope="col" className="text-right">Average order value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point) => (
              <TableRow key={point.date}>
                {/* point.date (e.g. "2026-09-15"), not point.label ("Sep 15")
                    — the table needs an unambiguous, year-inclusive UTC date
                    even across a range that spans a year boundary; the
                    abbreviated label is reserved for the chart's compact
                    axis ticks/tooltips only. */}
                <TableCell>{point.date}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(point.revenue, currencyCode)}</TableCell>
                <TableCell className="text-right tabular-nums">{point.salesCount}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(point.averageOrderValue, currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
