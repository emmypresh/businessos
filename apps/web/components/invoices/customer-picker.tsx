"use client";

import { useEffect, useId, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { searchCustomersForInvoiceAction, type InvoiceCustomerOption } from "@/lib/invoices/actions";

/**
 * Search-as-you-type customer picker for invoice creation — mirrors
 * components/sales/product-picker.tsx's own debounce/cancel pattern
 * exactly. Never loads the entire customer list client-side (tenant-
 * scoped search only, matching customers.view's own contract via
 * searchCustomersForInvoiceAction).
 */
export function CustomerPicker({
  businessId,
  selected,
  onSelect,
  invalid,
  errorId,
}: {
  businessId: string;
  selected: InvoiceCustomerOption | null;
  onSelect: (customer: InvoiceCustomerOption | null) => void;
  // Codex adversarial review, remediation round 1, Low 3: the search
  // input previously had no aria-invalid/aria-describedby association
  // with the customerId error paragraph rendered below it in
  // invoice-form.tsx at all — a screen reader user got no indication
  // which field a "Choose a customer." error referred to.
  invalid?: boolean;
  errorId?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InvoiceCustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const inputId = useId();

  useEffect(() => {
    if (selected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchCustomersForInvoiceAction(businessId, query)
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
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-sm">
        <span className="font-medium">{selected.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Change customer"
          onClick={() => {
            onSelect(null);
            setQuery("");
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Customer</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          placeholder="Search customers by name, phone, or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-invalid={invalid}
          aria-describedby={errorId}
        />
      </div>

      {query || results.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border bg-card p-1" data-testid="customer-picker-results">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No matching active customers.</p>
          ) : (
            results.map((customer) => (
              <button
                key={customer.id}
                type="button"
                onClick={() => onSelect(customer)}
                className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {customer.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
