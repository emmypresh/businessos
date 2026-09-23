// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagementOverview } from "./management-overview";

describe("ManagementOverview", () => {
  afterEach(cleanup);
  const currentSummary = { currencyCode: "NGN", grossSales: 1200, cashCollected: 900, outstandingSales: 300, expenses: 250, netCashFlow: 650, salesCount: 4, expenseCount: 2 };
  const priorSummary = { ...currentSummary, cashCollected: 0, netCashFlow: -100 };
  const currentReporting = { salesTrend: [{ date: "2026-09-15", revenue: 1200, orderCount: 4, averageOrderValue: 300 }], customerSummary: { newCustomers: 2, returningCustomers: 1, repeatCustomers: 1 }, inventoryRisk: { lowStockProducts: 3, outOfStockProducts: 1, slowMovingProducts: 2 }, branchPerformance: [{ branchId: "branch-a", branchName: "Main", revenue: 1200, orderCount: 4 }], whatsappFollowUpCount: 2 };
  const priorReporting = { ...currentReporting, salesTrend: [{ date: "2026-08-15", revenue: 1000, orderCount: 5, averageOrderValue: 200 }], customerSummary: { newCustomers: 0, returningCustomers: 2, repeatCustomers: 2 } };

  it("renders truthful KPI definitions, comparisons, responsive grid classes, and the real scoped report link", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    expect(screen.getByRole("heading", { name: "Acme Stores" })).toBeInTheDocument();
    expect(screen.getAllByText("NGN 1,200.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /financial overview/i })).toHaveAttribute("href", "/business-a/reports");
    expect(screen.getAllByText("Completed-sales revenue").length).toBeGreaterThan(0);
    expect(screen.getByText("Up 20% vs previous period")).toBeInTheDocument();
    expect(screen.getAllByText("No prior data").length).toBeGreaterThan(0);
    expect(screen.getByText("1 product out of stock")).toBeInTheDocument();
    expect(screen.queryByText(/health score|forecast|profit/i)).not.toBeInTheDocument();
    expect(screen.getByText("WhatsApp follow-up")).toBeInTheDocument();
    expect(screen.getByText("2 stocked products had no completed sale in this period")).toBeInTheDocument();
    expect(screen.getByLabelText("Last 30 days financial summary")).toHaveClass("sm:grid-cols-2", "lg:grid-cols-4", "kpi-5col:grid-cols-5!");
    expect(screen.getByLabelText("Customer and inventory insights")).toHaveClass("xl:grid-cols-3");
    expect(screen.getByRole("region", { name: "Branch performance" })).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("omits the WhatsApp card when the authorized aggregate withholds it and renders zero-safe no-activity text", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={{ ...currentSummary, cashCollected: 0, netCashFlow: 0 }} previousSummary={{ ...priorSummary, cashCollected: 0, netCashFlow: 0 }} reporting={{ ...currentReporting, salesTrend: [], whatsappFollowUpCount: null }} previousReporting={{ ...priorReporting, salesTrend: [] }} canViewCustomers canViewInventory />);
    expect(screen.queryByText("WhatsApp follow-up")).not.toBeInTheDocument();
    expect(screen.getAllByText("No activity in either period").length).toBeGreaterThan(0);
  });

  it("spans the fifth KPI card across the fourth row at lg without fabricating a sixth card", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    const netCashFlowCard = screen.getByText("Net cash flow").closest('[data-slot="card"]');
    expect(netCashFlowCard).toHaveClass("sm:col-span-2", "lg:col-span-2", "kpi-5col:col-span-1!");
    const kpiSection = screen.getByLabelText("Last 30 days financial summary");
    expect(kpiSection.querySelectorAll('[data-slot="card"]')).toHaveLength(5);
  });

  it("never lets a large currency KPI value break inside its digit groups (no break-words/break-all)", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={{ ...currentSummary, cashCollected: 1_234_567_890 }} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    const value = screen.getByText("NGN 1,234,567,890.00");
    expect(value).not.toHaveClass("break-words");
    expect(value).not.toHaveClass("break-all");
    // Only whitespace (the space between currency code and number) may be a
    // wrap point — never a mid-digit-group break, and never truncated.
    expect(value).not.toHaveClass("truncate");
    expect(value.textContent).toBe("NGN 1,234,567,890.00");
  });

  it.each([
    ["NGN 1,000.00", 1_000],
    ["NGN 100,000.00", 100_000],
    ["NGN 1,000,000.00", 1_000_000],
    ["NGN 100,000,000.00", 100_000_000],
    ["NGN 1,234,567,890.00", 1_234_567_890],
  ])("keeps the exact formatted currency text %s unchanged and free of break-words", (expectedText, cashCollected) => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={{ ...currentSummary, cashCollected }} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    const value = screen.getByText(expectedText);
    expect(value.textContent).toBe(expectedText);
    expect(value).not.toHaveClass("break-words");
    expect(value).not.toHaveClass("break-all");
    expect(value).toHaveClass("text-2xl", "tabular-nums", "min-w-0");
  });

  it("hides customer and inventory drilldown links when the caller lacks those permissions", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers={false} canViewInventory={false} />);
    expect(screen.queryByRole("link", { name: /view customers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view inventory/i })).not.toBeInTheDocument();
  });

  it("never emits a duplicate DOM id across the full composed overview render", () => {
    const { container } = render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={currentReporting} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it("does not render an empty WhatsApp grid slot when the aggregate withholds the count (no awkward empty grid hole)", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={{ ...currentReporting, whatsappFollowUpCount: null }} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    const insightsSection = screen.getByLabelText("Customer and inventory insights");
    expect(insightsSection).not.toHaveClass("xl:grid-cols-3");
    expect(insightsSection.querySelector(".lg\\:col-span-2")).not.toBeInTheDocument();
  });
});
