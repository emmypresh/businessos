"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NavItem = {
  href: string;
  label: string;
  // A pre-rendered icon ELEMENT (e.g. `<Package className="size-4" />`),
  // never a component reference (`LucideIcon`) — dashboard-shell.tsx (a
  // Server Component) constructs `sections` and passes it into this
  // Client Component as a prop; React's RSC serialization only supports
  // plain data and already-rendered elements crossing that boundary, not
  // raw function/class references. Confirmed the hard way: passing a
  // `LucideIcon` component reference here throws "Only plain objects can
  // be passed to Client Components from Server Components" at request
  // time in every environment (dev and prod alike). Active-state
  // recoloring is done by wrapping the element in a colored `<span>`
  // below (Lucide icons use `stroke="currentColor"`, so the wrapper's
  // text color is inherited) rather than by cloning a className onto it.
  icon: ReactNode;
  /** Nested/secondary item (e.g. Expenses > Categories) — rendered smaller, indented. */
  nested?: boolean;
  /** Highlight as active on an exact match only, not any sub-path — used for the dashboard root link so it doesn't stay lit while on every other page. */
  exact?: boolean;
};

export type NavSection = {
  label?: string;
  items: NavItem[];
};

/**
 * The one nav-rendering implementation shared by the desktop sidebar and
 * the mobile drawer (dashboard-shell.tsx renders this twice, once in
 * each). A Client Component only for `usePathname()` — every item it's
 * given has ALREADY been permission-filtered server-side in
 * dashboard-shell.tsx; this component has no authorization logic of its
 * own and never fetches anything.
 */
// Codex adversarial review, application-layer round 2, Low 8: the OLD
// per-item check (`pathname === href || pathname.startsWith(href + "/")`)
// let a PARENT item and its nested CHILD both match at once — e.g. on
// /expenses/categories, "Expenses" (href /expenses) matched via the
// prefix check AND "Categories" (href /expenses/categories) matched
// exactly, so both got aria-current="page" simultaneously (invalid — at
// most one element on a page should carry aria-current="page"). Fixed by
// computing the single BEST match across every item up front: an exact
// match always wins outright; otherwise the LONGEST matching href
// prefix wins (so a nested child's longer, more specific href always
// beats its parent's shorter one). `exact` items still only ever match
// their own exact path, never a prefix, so the dashboard-root link
// behaves exactly as before.
function findActiveHref(sections: NavSection[], pathname: string): string | undefined {
  let bestHref: string | undefined;
  let bestIsExact = false;
  let bestLength = -1;

  for (const section of sections) {
    for (const item of section.items) {
      const isExactMatch = pathname === item.href;
      const isPrefixMatch = !item.exact && pathname.startsWith(`${item.href}/`);
      if (!isExactMatch && !isPrefixMatch) continue;

      // An exact match always outranks a prefix match, regardless of
      // length; among matches of the SAME kind, the longer href (the
      // more specific route) wins.
      if (isExactMatch && !bestIsExact) {
        bestHref = item.href;
        bestIsExact = true;
        bestLength = item.href.length;
      } else if (isExactMatch === bestIsExact && item.href.length > bestLength) {
        bestHref = item.href;
        bestIsExact = isExactMatch;
        bestLength = item.href.length;
      }
    }
  }

  return bestHref;
}

export function SidebarNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const activeHref = findActiveHref(sections, pathname);

  return (
    <nav className="flex flex-col gap-5 text-sm">
      {sections.map((section, i) => (
        <div key={section.label ?? i} className="flex flex-col gap-1">
          {/* Codex adversarial review, application-layer round 2, Low 7:
              measured 4.22:1 at /50 opacity — below the 4.5:1 WCAG AA
              threshold. Raised to /60 (verified 5.65:1 against
              --sidebar), matching the role-label text right above the
              nav in dashboard-shell.tsx, which already used /60. */}
          {section.label ? (
            <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-sidebar-foreground/60 uppercase">
              {section.label}
            </p>
          ) : null}
          {section.items.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sidebar-foreground/85 transition-colors",
                  item.nested && "pl-8 text-[13px] text-sidebar-foreground/65",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                )}
              >
                <span className={cn("flex size-4 shrink-0 [&>svg]:size-4", active && "text-sidebar-primary")}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
