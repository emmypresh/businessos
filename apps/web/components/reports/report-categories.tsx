import Link from "next/link";
import { ArrowUpRight, LineChart, Users, Boxes, Building2 } from "lucide-react";

// One icon/accent per category, same --kpi-*-bg/-fg token convention as
// the rest of this pass (management-overview.tsx, financial-kpi-cards.tsx)
// — see management-overview.tsx's own KPI_ACCENTS comment for why these
// are tokens, not Tailwind `dark:` utilities.
const CATEGORY_ICONS = {
  "Sales & Revenue": { icon: LineChart, tile: "bg-kpi-blue-bg text-kpi-blue-fg" },
  Customers: { icon: Users, tile: "bg-kpi-purple-bg text-kpi-purple-fg" },
  Inventory: { icon: Boxes, tile: "bg-kpi-orange-bg text-kpi-orange-fg" },
  Branches: { icon: Building2, tile: "bg-kpi-cyan-bg text-kpi-cyan-fg" },
} as const;

// Phase 1N-C1/C2: workspace navigation for detail reports. Sales &
// Revenue is now a real, business-scoped link (C2) that preserves the
// caller's active range query string; Customers/Inventory/Branches
// remain deliberately NOT links — there is no route behind them yet
// (C3/C4), and a dead link is worse than no link. Each "Coming soon"
// item states its own status in text, not color alone, so it reads
// correctly with a screen reader and in dark mode.
// Phase 1N-C3: Customers and Inventory are now real, business-scoped links
// (same rangeSearch-preserving convention Sales & Revenue already uses).
// Phase 1N-C4: Branches is now a real, business-scoped link too — the last
// of the four categories, so PLANNED_REPORT_CATEGORIES is now empty and
// rendered as an empty list (harmless — see the map below).
const LINKED_REPORT_CATEGORIES = [
  {
    name: "Sales & Revenue",
    href: "sales",
    description: "Revenue trends, order volume, and average order value over the selected period.",
  },
  {
    name: "Customers",
    href: "customers",
    description: "New, returning, and repeat customer activity over the selected period.",
  },
  {
    name: "Inventory",
    href: "inventory",
    description: "Stock position, low/out-of-stock counts, and movement activity for the selected period.",
  },
  {
    name: "Branches",
    href: "branches",
    description: "Per-branch revenue, order volume, and drilldown detail for the selected period.",
  },
] as const;

const PLANNED_REPORT_CATEGORIES: readonly { name: keyof typeof CATEGORY_ICONS; description: string }[] = [];

export function ReportCategories({ businessId, rangeSearch }: { businessId: string; rangeSearch: string }) {
  return (
    <section aria-labelledby="report-categories-heading" className="flex flex-col gap-3">
      <h2 id="report-categories-heading" className="text-lg font-semibold tracking-tight">
        More reports
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LINKED_REPORT_CATEGORIES.map((category) => {
          const { icon: Icon, tile } = CATEGORY_ICONS[category.name];
          const href = `/${businessId}/reports/${category.href}${rangeSearch ? `?${rangeSearch}` : ""}`;
          return (
            <li key={category.name} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tile}`}>
                <Icon className="size-4.5" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-1">
                <Link
                  href={href}
                  className="flex items-center gap-1 rounded-md text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  {category.name} <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
                <p className="text-xs text-muted-foreground">{category.description}</p>
              </div>
            </li>
          );
        })}
        {PLANNED_REPORT_CATEGORIES.map((category) => {
          const { icon: Icon, tile } = CATEGORY_ICONS[category.name];
          return (
            <li
              key={category.name}
              className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-4 text-muted-foreground"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tile} opacity-70`}>
                  <Icon className="size-4.5" aria-hidden="true" />
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium">
                  Coming soon
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">{category.name}</span>
                <p className="text-xs">{category.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
