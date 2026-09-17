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
    expect(screen.getByLabelText("Last 30 days financial summary")).toHaveClass("sm:grid-cols-2", "lg:grid-cols-4");
    expect(screen.getByRole("region", { name: "Branch performance" })).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("omits the WhatsApp card when the authorized aggregate withholds it and renders zero-safe no-activity text", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={{ ...currentSummary, cashCollected: 0, netCashFlow: 0 }} previousSummary={{ ...priorSummary, cashCollected: 0, netCashFlow: 0 }} reporting={{ ...currentReporting, salesTrend: [], whatsappFollowUpCount: null }} previousReporting={{ ...priorReporting, salesTrend: [] }} canViewCustomers canViewInventory />);
    expect(screen.queryByText("WhatsApp follow-up")).not.toBeInTheDocument();
    expect(screen.getAllByText("No activity in either period").length).toBeGreaterThan(0);
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
    const { container } = render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={currentSummary} previousSummary={priorSummary} reporting={{ ...currentReporting, whatsappFollowUpCount: null }} previousReporting={priorReporting} canViewCustomers canViewInventory />);
    expect(container.querySelector(".lg\\:col-span-2")).not.toBeInTheDocument();
  });
});
