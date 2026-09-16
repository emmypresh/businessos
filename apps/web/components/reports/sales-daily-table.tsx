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
export function SalesDailyTable({ points, currencyCode }: { points: SalesTrendChartPoint[]; currencyCode: string }) {
  return (
    <Table>
      <TableCaption className="sr-only">Daily completed-sales revenue, completed sales, and average order value</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Date</TableHead>
          <TableHead scope="col">Revenue</TableHead>
          <TableHead scope="col">Completed sales</TableHead>
          <TableHead scope="col">Average order value</TableHead>
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
            <TableCell>{formatMoney(point.revenue, currencyCode)}</TableCell>
            <TableCell>{point.salesCount}</TableCell>
            <TableCell>{formatMoney(point.averageOrderValue, currencyCode)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
