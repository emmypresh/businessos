import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

function hrefFor(searchParams: URLSearchParams, page: number): string {
  const params = new URLSearchParams(searchParams);
  if (page <= 1) {
    params.delete("page");
  } else {
    params.set("page", String(page));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Shared pagination nav for the Members/Activity/Audit tabs. */
export function SupportPagination({
  page,
  pageSize,
  totalCount,
  searchParams,
  itemLabel,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  searchParams: URLSearchParams;
  itemLabel: string;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav aria-label={`${itemLabel} pagination`} className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages} &middot; {totalCount} {itemLabel}
      </p>
      <div className="flex items-center gap-2">
        {hasPrevious ? (
          <Link href={hrefFor(searchParams, page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
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
          <Link href={hrefFor(searchParams, page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
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
