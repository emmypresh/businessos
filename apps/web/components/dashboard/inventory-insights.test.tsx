// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InventoryInsights } from "./inventory-insights";

describe("InventoryInsights", () => {
  afterEach(cleanup);

  const current = { outOfStockProducts: 5, lowStockProducts: 8, slowMovingProducts: 12 };

  it("renders real out-of-stock, low-stock, and unsold-with-stock counts", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.getByText("Inventory insights")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Inventory insights" })).toBeInTheDocument();
    expect(screen.getByText("5 products out of stock")).toBeInTheDocument();
    expect(screen.getByText("8 products at or below their low-stock threshold")).toBeInTheDocument();
    expect(screen.getByText("12 stocked products had no completed sale in this period")).toBeInTheDocument();
  });

  it("renders truthful current-state definition text for out of stock and low stock", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.getByText("Aggregate stock across active locations is zero.")).toBeInTheDocument();
    expect(screen.getByText("Stock is above zero but at or below the product's configured low-stock threshold.")).toBeInTheDocument();
  });

  it("renders truthful period-based definition text for unsold with stock", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.getByText("Stock is positive and no completed sale was recorded for the product in this period.")).toBeInTheDocument();
    expect(screen.getByText("Current stock status, plus product activity for the last 30 days (UTC).")).toBeInTheDocument();
  });

  it("never applies success/increase styling classes to risk counts and shows no numeric comparison for them", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.queryByText(/vs previous period/i)).not.toBeInTheDocument();
  });

  it("shows truthful zero states for all three inventory risk metrics", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={{ outOfStockProducts: 0, lowStockProducts: 0, slowMovingProducts: 0 }} />);
    expect(screen.getByText("No products are currently out of stock.")).toBeInTheDocument();
    expect(screen.getByText("No products are currently at or below their low-stock threshold.")).toBeInTheDocument();
    expect(screen.getByText("No stocked products went unsold in this period.")).toBeInTheDocument();
  });

  it("never fabricates inventory value, reorder recommendations, or raw product names", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.queryByText(/inventory value|stock worth|capital tied up|reorder|days until stockout|demand forecast|dead stock|overstocked/i)).not.toBeInTheDocument();
  });

  it("links to the real business-scoped inventory route when the caller can view inventory", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory current={current} />);
    expect(screen.getByRole("link", { name: /view inventory/i })).toHaveAttribute("href", "/business-a/inventory");
  });

  it("omits the inventory drilldown link when the caller lacks inventory.view", () => {
    render(<InventoryInsights businessId="business-a" canViewInventory={false} current={current} />);
    expect(screen.queryByRole("link", { name: /view inventory/i })).not.toBeInTheDocument();
  });
});
