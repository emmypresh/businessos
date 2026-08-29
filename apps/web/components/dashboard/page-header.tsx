import type { ReactNode } from "react";

/**
 * The one consistent page-title block for every Phase 1F (and future)
 * route — title, an optional one-line description, and a right-aligned
 * actions slot (primary button, usually). Deliberately minimal: no
 * breadcrumbs implementation is built here (none of Phase 1F's routes are
 * nested deep enough to need one), but the prop exists so a route that
 * does can opt in without a second header component.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumbs ? <div className="text-sm text-muted-foreground">{breadcrumbs}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground text-pretty">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
