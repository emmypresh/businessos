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
}: {
  status: string;
  dueDate: string | null;
  balance: number;
}) {
  const knownStatus = (status in INVOICE_STATUS_LABEL ? status : "ISSUED") as InvoiceStatus;
  const overdue = isInvoiceOverdue({ status, dueDate, balance });

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="invoice-status-badge">
      <StatusBadge status={status} label={INVOICE_STATUS_LABEL[knownStatus]} tone={INVOICE_STATUS_TONE[knownStatus]} />
      {overdue ? <StatusBadge status="OVERDUE" label="Overdue" tone="destructive" /> : null}
    </span>
  );
}
