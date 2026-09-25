// @vitest-environment jsdom
// Phase 1Q-0C Codex follow-up (finding 2): sale-list-table previously
// rendered `${sale.currency_code} ${sale.total.toFixed(2)}` — a raw ISO
// code, never the shared symbol formatter. This proves the migration to
// formatMoney(..., { display: "symbol" }) across NGN/GHS/KES/GBP/USD.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleListTable } from "./sale-list-table";
import type { SaleRow } from "@/lib/sales/dal";

function makeSale(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: "sale-1",
    business_id: "biz-1",
    customer_id: null,
    customer_name_snapshot: null,
    customer_phone_snapshot: null,
    customer_email_snapshot: null,
    customer_address_snapshot: null,
    inventory_location_id: "loc-1",
    inventory_location_name_snapshot: "Main store",
    branch_id: "branch-1",
    branch_name_snapshot: "Main branch",
    sale_number: "SALE-000001",
    status: "COMPLETED",
    payment_status: "PAID",
    payment_method: "CASH",
    subtotal: 1234.56,
    discount: 0,
    total: 1234.56,
    amount_paid: 1234.56,
    currency_code: "NGN",
    notes: null,
    created_by: "user-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    cancelled_at: null,
    ...overrides,
  };
}

describe("SaleListTable — currency symbol display", () => {
  afterEach(cleanup);

  it.each([
    ["NGN", "₦1,234.56"],
    ["GHS", "GH₵1,234.56"],
    ["KES", "KSh1,234.56"],
    ["GBP", "£1,234.56"],
    ["USD", "$1,234.56"],
  ])("renders a %s sale total with its symbol, never the raw ISO code", (currency, expected) => {
    render(<SaleListTable businessId="biz-1" sales={[makeSale({ currency_code: currency })]} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(`${currency} 1234.56`)).not.toBeInTheDocument();
  });
});
