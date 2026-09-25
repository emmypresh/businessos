import { StatusBadge, type StatusTone } from "@/components/dashboard/status-badge";
import { INVOICE_STATUS_LABEL, isInvoiceOverdue, type InvoiceStatus } from "@/lib/invoices/constants";

const INVOICE_STATUS_TONE: Record<InvoiceStatus, StatusTone> = {
  ISSUED: "info",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  VOID: "neutral",
};

/**
 * OVERDUE is never a status this badge can literally show for a stored
 * value — it is derived (see lib/invoices/constants.ts's own
 * isInvoiceOverdue) and rendered as a SEPARATE, additional badge
 * alongside the real DB-authoritative status, never in place of it. This
 * keeps "what the database says" and "what today's date implies"
 * visually distinct, and never risks the two disagreeing under one
 * label.
 */
export function InvoiceStatusBadge({
  status,
  dueDate,
  balance,
  timezone,
}: {
  status: string;
  dueDate: string | null;
  balance: number;
  // Phase 1Q-0C: the invoice's own business's IANA timezone, threaded
  // from the business-details loader by every call site. Optional (and
  // defaults to Africa/Lagos inside isInvoiceOverdue) only so a caller
  // that genuinely has no business record yet still renders something
  // sane, never because per-business timezone is optional in principle.
  timezone?: string;
}) {
  const knownStatus = (status in INVOICE_STATUS_LABEL ? status : "ISSUED") as InvoiceStatus;
  const overdue = isInvoiceOverdue({ status, dueDate, balance }, new Date(), timezone);

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="invoice-status-badge">
      <StatusBadge status={status} label={INVOICE_STATUS_LABEL[knownStatus]} tone={INVOICE_STATUS_TONE[knownStatus]} />
      {overdue ? <StatusBadge status="OVERDUE" label="Overdue" tone="destructive" /> : null}
    </span>
  );
}
