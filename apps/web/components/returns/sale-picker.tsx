"use client";

import { useEffect, useId, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/currency";
import { searchReturnableSalesAction, type ReturnableSaleOption } from "@/lib/returns/actions";

/**
 * Search-as-you-type sale picker for return creation — mirrors
 * components/invoices/customer-picker.tsx's/payable-invoice-picker.tsx's
 * own debounce/cancel pattern exactly. Backed by
 * searchReturnableSalesAction, authorized on returns.manage ALONE — never
 * loads every sale client-side, and never requires sales.view (a
 * permission returns.manage does not imply — see that action's own
 * header comment).
 */
export function SalePicker({
  businessId,
  selected,
  onSelect,
  invalid,
  errorId,
}: {
  businessId: string;
  selected: ReturnableSaleOption | null;
  onSelect: (sale: ReturnableSaleOption | null) => void;
  invalid?: boolean;
  errorId?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReturnableSaleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const inputId = useId();

  useEffect(() => {
    if (selected) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchReturnableSalesAction(businessId, query)
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
      <div
        className="flex items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-sm"
        data-testid="sale-picker-selected"
      >
        <div className="min-w-0">
          <p className="truncate font-medium">
            {selected.saleNumber}
            {selected.customerName ? ` — ${selected.customerName}` : ""}
          </p>
          <p className="truncate text-muted-foreground">
            {selected.branchName} · {new Date(selected.completedAt).toLocaleDateString()} · {formatMoney(selected.total, "NGN")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Choose a different sale"
          onClick={() => onSelect(null)}
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Sale</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          placeholder="Search by sale # or customer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-invalid={invalid}
          aria-describedby={errorId}
        />
      </div>

      {query || results.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border bg-card p-1" data-testid="sale-picker-results">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No matching completed sales.</p>
          ) : (
            results.map((sale) => (
              <button
                key={sale.id}
                type="button"
                onClick={() => onSelect(sale)}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{sale.saleNumber}</span>
                  {sale.customerName ? ` — ${sale.customerName}` : ""}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatMoney(sale.total, "NGN")}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
