import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

// Phase 1O-E — small, reusable platform console primitives. Introduced
// because the Overview/Businesses/Business-detail redesign repeats the same
// "bounded panel with a header and an empty state" and "KPI tile" shapes
// several times each; each primitive here is used at least three times
// across this phase's pages, which is the bar phase instructions §33 sets
// for a new abstraction ("do not create abstraction for one-off markup").

export function PlatformPanel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PlatformSectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {/* h1 to match the rest of the app's own established convention —
            every tenant route's top-level heading is an h1 (e.g.
            app/[businessId]/customers/page.tsx), never an h2. An automated
            accessibility smoke pass over the pre-1O-E shell caught this
            page-title level as the one real heading-hierarchy defect (see
            tests/e2e/internal-admin-a11y.spec.ts). */}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PlatformStatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-xs">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon ? (
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground [&>svg]:size-4">
            {icon}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PlatformEmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-kpi-emerald-bg text-kpi-emerald-fg",
  ACTIVE: "bg-kpi-emerald-bg text-kpi-emerald-fg",
  TRIALING: "bg-kpi-orange-bg text-kpi-orange-fg",
  suspended: "bg-destructive/10 text-destructive",
  PAST_DUE: "bg-destructive/10 text-destructive",
  CANCELED: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
};

// Shared bounded pagination for every new 1O-E platform-wide list (Audit,
// Subscriptions, Support) — mirrors business-directory-pagination.tsx's own
// established shape (Previous/Next only, disabled-state span instead of a
// dead link, page-count text), generalized with a `noun` label instead of
// duplicating three near-identical copies.
export function PlatformPagination({
  page,
  pageSize,
  totalCount,
  searchParams,
  noun,
  ariaLabel,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  searchParams: URLSearchParams;
  noun: string;
  ariaLabel: string;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  function hrefFor(targetPage: number): string {
    const params = new URLSearchParams(searchParams);
    if (targetPage <= 1) params.delete("page");
    else params.set("page", String(targetPage));
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  return (
    <nav aria-label={ariaLabel} className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages} &middot; {totalCount} {noun}
        {totalCount === 1 ? "" : "s"}
      </p>
      <div className="flex items-center gap-2">
        {hasPrevious ? (
          <Link href={hrefFor(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Previous
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none opacity-50" })}
          >
            Previous
          </span>
        )}
        {hasNext ? (
          <Link href={hrefFor(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Next
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none opacity-50" })}
          >
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function PlatformStatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tone)}>
      {status}
    </span>
  );
}
