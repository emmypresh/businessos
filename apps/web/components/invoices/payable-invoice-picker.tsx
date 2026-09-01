"use client";

import { useEffect, useId, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/currency";
import { INVOICE_STATUS_LABEL } from "@/lib/invoices/constants";
import { searchPayableInvoicesAction, type PayableInvoiceOption } from "@/lib/invoices/actions";
import { PaymentForm } from "@/components/invoices/payment-form";

/**
 * Codex adversarial review, remediation round 1, Medium 4: the dedicated
 * payment-recording surface (/[businessId]/payments/record) for a
 * payments.record-only caller (no invoices.view). Mirrors
 * components/invoices/customer-picker.tsx's own search-as-you-type/
 * debounce/cancel pattern exactly — never loads every outstanding
 * invoice client-side. Once an invoice is selected, renders the SAME
 * PaymentForm the invoice detail page's own PaymentForm uses (no
 * duplicated payment-recording logic).
 */
export function PayableInvoicePicker({ businessId }: { businessId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PayableInvoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<PayableInvoiceOption | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (selected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchPayableInvoicesAction(businessId, query)
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [businessId, query, selected]);

  if (selected) {
    const balance = selected.totalAmount - selected.amountPaid;
    return (
      <div className="flex flex-col gap-4" data-testid="payable-invoice-selected">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-sm">
          <div>
            <p className="font-medium">{selected.invoiceNumber}</p>
            <p className="text-muted-foreground">
              {selected.customerName} — {selected.branchName} — {formatMoney(balance, "NGN")} outstanding
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Choose a different invoice" onClick={() => setSelected(null)}>
            <X className="size-4" />
          </Button>
        </div>
        <PaymentForm businessId={businessId} invoiceId={selected.id} balance={balance} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Invoice</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          placeholder="Search by invoice number or customer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      {query || results.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border bg-card p-1" data-testid="payable-invoice-results">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No matching outstanding invoices.</p>
          ) : (
            results.map((invoice) => (
              <button
                key={invoice.id}
                type="button"
                onClick={() => setSelected(invoice)}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span>
                  <span className="font-medium">{invoice.invoiceNumber}</span> — {invoice.customerName}
                </span>
                <span className="text-muted-foreground">
                  {formatMoney(invoice.totalAmount - invoice.amountPaid, "NGN")} due
                  {" · "}
                  {INVOICE_STATUS_LABEL[invoice.status as keyof typeof INVOICE_STATUS_LABEL] ?? invoice.status}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
