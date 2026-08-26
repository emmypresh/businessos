import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Shared "Load more" control for every keyset-paginated list in this domain. */
export function PaginationLink({
  href,
  nextCursor,
}: {
  href: string;
  nextCursor: string | null;
}) {
  if (!nextCursor) return null;

  const url = new URL(href, "http://placeholder.local");
  url.searchParams.set("cursor", nextCursor);

  return (
    <Link
      href={`${url.pathname}${url.search}`}
      className={buttonVariants({ variant: "outline", className: "w-fit" })}
    >
      Load more
    </Link>
  );
}
