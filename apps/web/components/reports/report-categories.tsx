// Phase 1N-C1: workspace navigation for detail reports that do not exist
// yet (Sales & Revenue / Customers / Inventory / Branches land in
// C2–C4). These are deliberately NOT links — there is no route behind
// them yet, and a dead link is worse than no link. Each item states its
// own "Coming soon" status in text, not color alone, so it reads
// correctly with a screen reader and in dark mode.
const PLANNED_REPORT_CATEGORIES = [
  {
    name: "Sales & Revenue",
    description: "Revenue trends, order volume, and average order value over the selected period.",
  },
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

export function ReportCategories() {
  return (
    <section aria-labelledby="report-categories-heading" className="flex flex-col gap-3">
      <h2 id="report-categories-heading" className="text-lg font-semibold tracking-tight">
        More reports
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
