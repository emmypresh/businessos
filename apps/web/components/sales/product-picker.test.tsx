// @vitest-environment jsdom
// Phase 1Q-0C Codex follow-up (finding 2): product-picker previously
// rendered `${product.currencyCode} ${product.sellingPrice.toFixed(2)}` —
// this proves it now uses the shared symbol formatter, across currencies.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductPicker } from "./product-picker";
import type { SaleProductOption } from "@/lib/sales/dal";

const searchProductsForSaleAction = vi.fn<
  (businessId: string, search: string, branchId?: string) => Promise<SaleProductOption[]>
>();

vi.mock("@/lib/sales/actions", () => ({
  searchProductsForSaleAction: (...args: [string, string, string?]) => searchProductsForSaleAction(...args),
}));

describe("ProductPicker — currency symbol display", () => {
  afterEach(() => {
    cleanup();
    searchProductsForSaleAction.mockReset();
  });

  it.each([
    ["GHS", "GH₵1,500.00"],
    ["KES", "KSh1,500.00"],
    ["USD", "$1,500.00"],
  ])("renders a %s product price with its symbol, never the raw ISO code", async (currency, expected) => {
    searchProductsForSaleAction.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        sku: "SKU-1",
        sellingPrice: 1500,
        currencyCode: currency,
        trackInventory: true,
        quantity: 10,
      },
    ]);

    render(<ProductPicker businessId="biz-1" branchId="branch-1" onAdd={() => {}} />);

    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    expect(screen.queryByText(`${currency} 1500.00`)).not.toBeInTheDocument();
  });
});
