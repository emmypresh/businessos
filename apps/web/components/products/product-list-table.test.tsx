// @vitest-environment jsdom
// Phase 1Q-0C: product price currency-symbol coverage — the list table
// used to interpolate the raw ISO currency_code next to the price
// ("NGN 1,234.56"); it now goes through lib/currency.ts's formatMoney in
// "symbol" display mode, same as every other tenant money surface.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductListTable } from "./product-list-table";
import type { ProductListRow } from "@/lib/products/dal";

function makeProduct(overrides: Partial<ProductListRow> = {}): ProductListRow {
  return {
    id: "product-a",
    business_id: "business-a",
    name: "Sample product",
    description: null,
    sku: "SKU-1",
    barcode: null,
    category: null,
    unit: "unit",
    selling_price: 1234.56,
    currency_code: "NGN",
    track_inventory: true,
    low_stock_threshold: 5,
    status: "active",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    quantity: 10,
    ...overrides,
  };
}

describe("ProductListTable", () => {
  afterEach(cleanup);

  it.each([
    ["NGN", "₦"],
    ["GHS", "GH₵"],
    ["KES", "KSh"],
    ["ZAR", "R"],
    ["GBP", "£"],
    ["USD", "$"],
  ])("renders the selling price for a %s product with its product symbol, never the ISO code", (currencyCode, symbol) => {
    render(
      <ProductListTable
        businessId="business-a"
        products={[makeProduct({ currency_code: currencyCode })]}
      />
    );
    expect(screen.getByText(`${symbol}1,234.56`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${currencyCode} 1,234`))).not.toBeInTheDocument();
  });
});
