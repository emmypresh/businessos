import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * The one consistent "nothing here yet" / "no results" surface for
 * Phase 1F lists — deliberately plain (a bordered panel, an icon, a
 * sentence, an optional action), not an illustrated marketing-style empty
 * state. Reused for both "genuinely empty" and "filtered to nothing"
 * cases; callers pass the appropriate description/action for each.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      {Icon ? <Icon aria-hidden="true" className="size-8 text-muted-foreground" /> : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-sm text-muted-foreground text-pretty">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
