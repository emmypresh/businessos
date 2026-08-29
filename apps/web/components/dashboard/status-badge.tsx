import { cn } from "@/lib/utils";

/**
 * The one standardized status presentation for every Phase 1F status
 * value (branches: ACTIVE/INACTIVE/DEFAULT; staff: ACTIVE/SUSPENDED;
 * invitations: PENDING/ACCEPTED/REVOKED/EXPIRED) — a colored dot PLUS the
 * status word, never color alone (the word is what a screen reader
 * announces, and what distinguishes two statuses for a color-blind
 * reader). Semantic tone tokens only (success/warning/destructive/info/
 * primary/muted) — never a hardcoded Tailwind color — so this
 * automatically stays correct in dark mode along with everything else
 * that consumes those tokens.
 */
export type StatusTone = "success" | "warning" | "destructive" | "info" | "primary" | "neutral";

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  primary: "bg-primary",
  neutral: "bg-muted-foreground",
};

const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  primary: "text-primary",
  neutral: "text-muted-foreground",
};

// Every status word Phase 1F ever renders, and the ONE tone each maps to
// — a single source of truth so "Active" always looks the same whether
// it's a branch, a staff member, or (eventually) something else.
const STATUS_TONE: Record<string, StatusTone> = {
  ACTIVE: "success",
  INACTIVE: "neutral",
  SUSPENDED: "destructive",
  PENDING: "warning",
  ACCEPTED: "success",
  REVOKED: "destructive",
  EXPIRED: "neutral",
  DEFAULT: "primary",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  SUSPENDED: "Suspended",
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REVOKED: "Revoked",
  EXPIRED: "Expired",
  DEFAULT: "Default",
};

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  /** One of the known Phase 1F status keys (ACTIVE, PENDING, ...). */
  status: string;
  /** Override the displayed word — the status key itself is used otherwise. */
  label?: string;
  /** Override the tone — inferred from `status` otherwise, falling back to neutral for an unrecognized value. */
  tone?: StatusTone;
  className?: string;
}) {
  const resolvedTone = tone ?? STATUS_TONE[status] ?? "neutral";
  const resolvedLabel = label ?? STATUS_LABEL[status] ?? status;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-4xl border border-border bg-card px-2 py-0.5 text-xs font-medium",
        TONE_TEXT[resolvedTone],
        className
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[resolvedTone])} />
      {resolvedLabel}
    </span>
  );
}
