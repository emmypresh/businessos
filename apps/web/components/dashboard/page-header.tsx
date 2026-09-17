import type { ReactNode } from "react";

/**
 * The one consistent page-title block for every Phase 1F (and future)
 * route — title, an optional one-line description, and a right-aligned
 * actions slot (primary button, usually). Deliberately minimal: no
 * breadcrumbs implementation is built here (none of Phase 1F's routes are
 * nested deep enough to need one), but the prop exists so a route that
 * does can opt in without a second header component.
 *
 * `icon` is an opt-in ArchitectUI-style accent tile rendered to the left
 * of the title. Every existing caller omits it, so this is visually a
 * no-op for them — it exists so UI2/UI3 can adopt the tile per-page
 * without a second header component.
 */
export function PageHeader({
  title,
  description,
  icon,
  breadcrumbs,
  actions,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground [&>svg]:size-5">
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-1">
          {breadcrumbs ? <div className="text-sm text-muted-foreground">{breadcrumbs}</div> : null}
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground text-pretty">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
