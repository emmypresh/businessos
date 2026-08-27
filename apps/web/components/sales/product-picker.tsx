"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { searchProductsForSaleAction } from "@/lib/sales/actions";
import type { SaleProductOption } from "@/lib/sales/dal";

/**
 * Search-as-you-type product picker for the sale-creation flow. Debounced
 * client search calling the read-only searchProductsForSaleAction
 * (independently gated on sales.create server-side) — never queries
 * cost_price, never calls a cost accessor RPC. Only active products are
 * ever returned by that action.
 */
export function ProductPicker({
  businessId,
  onAdd,
}: {
  businessId: string;
  onAdd: (product: SaleProductOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SaleProductOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchProductsForSaleAction(businessId, query)
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
  }, [businessId, query]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search products by name or SKU"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-label="Search products"
        />
      </div>

      {query || results.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border bg-card p-1" data-testid="product-picker-results">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No matching active products.</p>
          ) : (
            results.map((product) => (
              <button
                key={product.id}
                type="button"
                onClick={() => onAdd(product)}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="flex flex-col">
                  <span className="font-medium">{product.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {product.sku ?? "No SKU"} ·{" "}
                    {product.trackInventory ? `${product.quantity} in stock` : "Not tracked"}
                  </span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                  {product.currencyCode} {product.sellingPrice.toFixed(2)}
                  <Button type="button" size="sm" variant="outline" tabIndex={-1}>
                    Add
                  </Button>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
