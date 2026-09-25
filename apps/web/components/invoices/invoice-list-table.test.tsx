// @vitest-environment jsdom
// Phase 1Q-0C: invoice total currency-symbol coverage — mirrors
// product-list-table.test.tsx's own six-currency check.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InvoiceListTable } from "./invoice-list-table";
import type { InvoiceRow } from "@/lib/invoices/dal";

function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "invoice-a",
    business_id: "business-a",
    invoice_number: "INV-0001",
    customer_id: "customer-a",
    customer_name_snapshot: "Acme Retail",
    customer_phone_snapshot: null,
    customer_email_snapshot: null,
    branch_id: "branch-a",
    branch_name_snapshot: "Main",
    status: "ISSUED",
    issued_at: "2026-09-01T00:00:00Z",
    due_date: null,
    total_amount: 9876.5,
    amount_paid: 1000,
    currency_code: "NGN",
    notes: null,
    created_by: "user-a",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    voided_at: null,
    voided_by: null,
    ...overrides,
  };
}

describe("InvoiceListTable", () => {
  afterEach(cleanup);

  it.each([
    ["NGN", "₦"],
    ["GHS", "GH₵"],
    ["KES", "KSh"],
    ["ZAR", "R"],
    ["GBP", "£"],
    ["USD", "$"],
  ])("renders the invoice total for a %s invoice with its product symbol, never the ISO code", (currencyCode, symbol) => {
    render(
      <InvoiceListTable
        businessId="business-a"
        invoices={[makeInvoice({ currency_code: currencyCode })]}
      />
    );
    expect(screen.getByText(`${symbol}9,876.50`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${currencyCode} 9,876`))).not.toBeInTheDocument();
  });
});
