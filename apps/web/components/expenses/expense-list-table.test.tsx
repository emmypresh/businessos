// @vitest-environment jsdom
// Phase 1Q-0C: expense amount currency-symbol coverage — mirrors
// product-list-table.test.tsx's own six-currency check.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExpenseListTable } from "./expense-list-table";
import type { ExpenseRow } from "@/lib/expenses/dal";

function makeExpense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "expense-a",
    business_id: "business-a",
    expense_number: "EXP-0001",
    category_id: "category-a",
    category_name_snapshot: "Utilities",
    branch_id: null,
    branch_name_snapshot: null,
    amount: 4321.5,
    currency_code: "NGN",
    payment_method: "CASH",
    payee: "Acme Power Co.",
    reference: null,
    notes: null,
    incurred_at: "2026-09-01T00:00:00Z",
    status: "POSTED",
    created_by: "user-a",
    created_at: "2026-09-01T00:00:00Z",
    voided_at: null,
    voided_by: null,
    void_reason: null,
    ...overrides,
  } as ExpenseRow;
}

describe("ExpenseListTable", () => {
  afterEach(cleanup);

  it.each([
    ["NGN", "₦"],
    ["GHS", "GH₵"],
    ["KES", "KSh"],
    ["ZAR", "R"],
    ["GBP", "£"],
    ["USD", "$"],
  ])("renders the expense amount for a %s expense with its product symbol, never the ISO code", (currencyCode, symbol) => {
    render(
      <ExpenseListTable
        businessId="business-a"
        expenses={[makeExpense({ currency_code: currencyCode })]}
      />
    );
    expect(screen.getByText(`${symbol}4,321.50`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${currencyCode} 4,321`))).not.toBeInTheDocument();
  });
});
