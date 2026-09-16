// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManagementOverview } from "./management-overview";

describe("ManagementOverview", () => {
  it("renders only the trusted financial-summary fields and reaches the scoped report", () => {
    render(<ManagementOverview businessId="business-a" businessName="Acme Stores" summary={{ currencyCode: "NGN", grossSales: 1200, cashCollected: 900, outstandingSales: 300, expenses: 250, netCashFlow: 650, salesCount: 4, expenseCount: 2 }} reporting={{ salesTrend: [{ date: "2026-09-15", revenue: 1200, orderCount: 4, averageOrderValue: 300 }], customerSummary: { newCustomers: 2, returningCustomers: 1, repeatCustomers: 1 }, inventoryRisk: { lowStockProducts: 3, outOfStockProducts: 1, slowMovingProducts: 2 }, branchPerformance: [{ branchId: "branch-a", branchName: "Main", revenue: 1200, orderCount: 4 }], whatsappFollowUpCount: 2 }} />);
    expect(screen.getByRole("heading", { name: "Acme Stores" })).toBeInTheDocument();
    expect(screen.getByText("NGN 1,200.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /financial overview/i })).toHaveAttribute("href", "/business-a/reports");
    expect(screen.getByText("Cash collected − expenses")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp follow-up")).toBeInTheDocument();
    expect(screen.getByText(/unsold with stock/i)).toBeInTheDocument();
  });
});
