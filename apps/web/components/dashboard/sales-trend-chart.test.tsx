// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SalesTrendChart } from "./sales-trend-chart";
import { buildSalesTrendChartModel } from "@/lib/reports/sales-trend-chart";

describe("SalesTrendChart", () => {
  afterEach(cleanup);

  const salesTrend = [
    { date: "2026-09-14", revenue: 1500, orderCount: 3, averageOrderValue: 500 },
    { date: "2026-09-15", revenue: 0, orderCount: 0, averageOrderValue: 0 },
    { date: "2026-09-16", revenue: 900, orderCount: 2, averageOrderValue: 450 },
  ];
  const model = buildSalesTrendChartModel(salesTrend);

  function renderChart(overrides: Partial<Parameters<typeof SalesTrendChart>[0]> = {}) {
    return render(
      <SalesTrendChart
        businessId="business-a"
        points={model.points}
        hasActivity={model.hasActivity}
        currencyCode="NGN"
        rangeLabel="Last 30 days (UTC)"
        {...overrides}
      />
    );
  }

  it("renders an accessible chart with a title and description", () => {
    renderChart();
    const chart = screen.getByRole("img");
    expect(chart).toBeInTheDocument();
    expect(screen.getByText("Sales & revenue trend")).toBeInTheDocument();
    expect(screen.getByText(/Completed-sales revenue per day\. Last 30 days \(UTC\)\./)).toBeInTheDocument();
  });

  it("defaults to the revenue metric and shows exact currency-formatted values", () => {
    renderChart();
    expect(screen.getByText("Sep 14: NGN 1,500.00")).toBeInTheDocument();
    expect(screen.getByText("Sep 16: NGN 900.00")).toBeInTheDocument();
  });

  it("preserves the zero-activity day in the accessible data table rather than dropping it", () => {
    renderChart();
    const table = screen.getByText("Revenue by day, Last 30 days (UTC)").closest("table")!;
    expect(table).toHaveTextContent("Sep 15");
    expect(table).toHaveTextContent("NGN 0.00");
  });

  it("switches to the completed-sales metric on click without changing the points passed in (no new data fetch)", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole("button", { name: "Sales" }));
    expect(screen.getByText("Sep 14: 3")).toBeInTheDocument();
    expect(screen.getByText(/Completed sales count per day/)).toBeInTheDocument();
  });

  it("renders integer sales counts, never decimals", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole("button", { name: "Sales" }));
    expect(screen.queryByText(/Sep 14: 3\.0/)).not.toBeInTheDocument();
  });

  it("renders average order value safely as zero on a zero-sales day", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByRole("button", { name: "AOV" }));
    expect(screen.getByText("Sep 15: NGN 0.00")).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it("keyboard-focuses and activates the metric selector buttons", async () => {
    const user = userEvent.setup();
    renderChart();
    await user.tab();
    const salesButton = screen.getByRole("button", { name: "Sales" });
    while (document.activeElement !== salesButton) {
      await user.tab();
    }
    await user.keyboard("{Enter}");
    expect(salesButton).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a clear no-activity state instead of a misleading chart when every day is zero", () => {
    renderChart({ points: buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: 0, orderCount: 0, averageOrderValue: 0 },
    ]).points, hasActivity: false });
    expect(screen.getByText("No completed sales in this period")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("links the drilldown to the existing business-scoped financial report route only", () => {
    renderChart();
    const link = screen.getByRole("link", { name: /view financial report/i });
    expect(link).toHaveAttribute("href", "/business-a/reports");
  });

  it("is responsive: the chart svg scales to its container width", () => {
    renderChart();
    expect(screen.getByRole("img")).toHaveClass("w-full", "max-w-full");
  });

  it("does not render any AI-generated performance judgment copy", () => {
    renderChart();
    expect(screen.queryByText(/performing strongly|healthy|growing|best-performing/i)).not.toBeInTheDocument();
  });
});
