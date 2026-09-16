import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

// Phase 1N-C1/C2: workspace navigation for detail reports. Sales &
// Revenue is now a real, business-scoped link (C2) that preserves the
// caller's active range query string; Customers/Inventory/Branches
// remain deliberately NOT links — there is no route behind them yet
// (C3/C4), and a dead link is worse than no link. Each "Coming soon"
// item states its own status in text, not color alone, so it reads
// correctly with a screen reader and in dark mode.
const PLANNED_REPORT_CATEGORIES = [
  {
    name: "Customers",
    description: "New, returning, and repeat customer activity over the selected period.",
  },
  {
    name: "Inventory",
    description: "Low-stock, out-of-stock, and slow-moving product activity.",
  },
  {
    name: "Branches",
    description: "Per-branch revenue and order volume for the selected period.",
  },
] as const;

export function ReportCategories({ businessId, rangeSearch }: { businessId: string; rangeSearch: string }) {
  const salesHref = `/${businessId}/reports/sales${rangeSearch ? `?${rangeSearch}` : ""}`;

  return (
    <section aria-labelledby="report-categories-heading" className="flex flex-col gap-3">
      <h2 id="report-categories-heading" className="text-lg font-semibold tracking-tight">
        More reports
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <li className="flex flex-col gap-1 rounded-lg border border-border bg-background p-4">
          <Link
            href={salesHref}
            className="flex items-center justify-between gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <span className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline">
              Sales &amp; Revenue <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </span>
          </Link>
          <p className="text-xs text-muted-foreground">
            Revenue trends, order volume, and average order value over the selected period.
          </p>
        </li>
        {PLANNED_REPORT_CATEGORIES.map((category) => (
          <li
            key={category.name}
            className="flex flex-col gap-1 rounded-lg border border-dashed border-border bg-muted/30 p-4 text-muted-foreground"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{category.name}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium">
                Coming soon
              </span>
            </div>
            <p className="text-xs">{category.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
