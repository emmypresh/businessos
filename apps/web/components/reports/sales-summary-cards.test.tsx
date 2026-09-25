// @vitest-environment jsdom
// Phase 1N-UI3: verifies the tablet responsive remediation for the grid
// itself (jsdom has no layout engine, so this asserts the exact Tailwind
// classes that drive column counts / spans, not rendered pixel widths —
// pixel-level clipping was verified separately by hand-computing the
// dashboard shell's known sidebar/padding widths against each breakpoint;
// see the KPI grid's own inline comment in sales-summary-cards.tsx).
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SalesSummaryCards } from "./sales-summary-cards";

describe("SalesSummaryCards — tablet responsive grid (Phase 1N-UI3)", () => {
  afterEach(cleanup);

  const props = { revenue: 208750.5, salesCount: 42, averageOrderValue: 4970.25, currencyCode: "NGN" };

  it("renders exactly three KPI cards with their unchanged labels", () => {
    render(<SalesSummaryCards {...props} />);
    expect(screen.getByTestId("kpi-sales-revenue")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-completed-sales")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-average-order-value")).toBeInTheDocument();
    expect(screen.getByText("Completed-sales revenue")).toBeInTheDocument();
    expect(screen.getByText("Completed sales")).toBeInTheDocument();
    expect(screen.getByText("Average order value")).toBeInTheDocument();
  });

  it("preserves exact formatted values", () => {
    render(<SalesSummaryCards {...props} />);
    expect(screen.getByText("₦208,750.50")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("₦4,970.25")).toBeInTheDocument();
  });

  it("uses 1 column by default (mobile), 2 at sm, and only 3 at xl — never 3 as early as sm", () => {
    render(<SalesSummaryCards {...props} />);
    const grid = screen.getByLabelText("Sales and revenue summary");
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).toContain("xl:grid-cols-3");
    expect(grid.className).not.toMatch(/(?<!x)l:grid-cols-3/);
  });

  it("spans the third (AOV) card across both tablet columns, collapsing to one column once 3-up activates", () => {
    render(<SalesSummaryCards {...props} />);
    const aovCard = screen.getByTestId("kpi-average-order-value");
    expect(aovCard.className).toContain("sm:col-span-2");
    expect(aovCard.className).toContain("xl:col-span-1");
  });

  it("never truncates, break-alls, break-words, or abbreviates the formatted values", () => {
    render(<SalesSummaryCards {...props} />);
    const revenueValue = screen.getByText("₦208,750.50");
    const aovValue = screen.getByText("₦4,970.25");
    for (const el of [revenueValue, aovValue]) {
      expect(el.className).not.toMatch(/truncate|break-all|break-words/);
    }
    expect(screen.queryByText(/K$|M$|B$/)).not.toBeInTheDocument();
  });

  it("keeps decorative KPI icons aria-hidden", () => {
    render(<SalesSummaryCards {...props} />);
    const icons = document.querySelectorAll("svg[aria-hidden='true']");
    expect(icons.length).toBe(3);
  });

  // Phase 1Q-0C: sales report summary currency-symbol coverage for all six
  // launch currencies.
  it.each([
    ["NGN", "₦"],
    ["GHS", "GH₵"],
    ["KES", "KSh"],
    ["ZAR", "R"],
    ["GBP", "£"],
    ["USD", "$"],
  ])("formats the %s revenue KPI with its product symbol, never the ISO code", (currencyCode, symbol) => {
    render(<SalesSummaryCards {...props} currencyCode={currencyCode} />);
    expect(screen.getByText(`${symbol}208,750.50`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${currencyCode} 208,750`))).not.toBeInTheDocument();
  });
});
