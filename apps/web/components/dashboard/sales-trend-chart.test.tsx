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

  // The per-point hover tooltip is a `title` ATTRIBUTE on each <circle>
  // (never a nested <title> child element — that form is hoisted by
  // React 19's document-metadata support regardless of SVG namespace,
  // which reproduced as a 100%-reproducible server/client hydration
  // mismatch; see the fix in sales-trend-chart.tsx). Query it as an
  // attribute, not as DOM text content.
  function tooltipCircle(container: HTMLElement, text: string) {
    return container.querySelector(`circle[title="${text}"]`);
  }

  it("renders an accessible chart with a title and description", () => {
    renderChart();
    const chart = screen.getByRole("img");
    expect(chart).toBeInTheDocument();
    expect(screen.getByText("Sales & revenue trend")).toBeInTheDocument();
    expect(screen.getByText(/Completed-sales revenue per day\. Last 30 days \(UTC\)\./)).toBeInTheDocument();
  });

  it("defaults to the revenue metric and shows exact currency-formatted values", () => {
    const { container } = renderChart();
    expect(tooltipCircle(container, "Sep 14: ₦1,500.00")).toBeInTheDocument();
    expect(tooltipCircle(container, "Sep 16: ₦900.00")).toBeInTheDocument();
  });

  it("preserves the zero-activity day in the accessible data table rather than dropping it", () => {
    renderChart();
    const table = screen.getByText("Revenue by day, Last 30 days (UTC)").closest("table")!;
    expect(table).toHaveTextContent("Sep 15");
    expect(table).toHaveTextContent("₦0.00");
  });

  it("switches to the completed-sales metric on click without changing the points passed in (no new data fetch)", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.click(screen.getByRole("button", { name: "Sales" }));
    expect(tooltipCircle(container, "Sep 14: 3")).toBeInTheDocument();
    expect(screen.getByText(/Completed sales count per day/)).toBeInTheDocument();
  });

  it("renders integer sales counts, never decimals", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.click(screen.getByRole("button", { name: "Sales" }));
    expect(tooltipCircle(container, "Sep 14: 3")).toBeInTheDocument();
    expect(tooltipCircle(container, "Sep 14: 3.0")).not.toBeInTheDocument();
  });

  it("renders average order value safely as zero on a zero-sales day", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.click(screen.getByRole("button", { name: "AOV" }));
    expect(tooltipCircle(container, "Sep 15: ₦0.00")).toBeInTheDocument();
    expect(container.querySelector('circle[title*="NaN"], circle[title*="Infinity"]')).not.toBeInTheDocument();
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
    expect(screen.getByRole("img")).toHaveClass("w-full", "max-w-5xl");
  });

  it("does not render any AI-generated performance judgment copy", () => {
    renderChart();
    expect(screen.queryByText(/performing strongly|healthy|growing|best-performing/i)).not.toBeInTheDocument();
  });

  it("gives each chart instance a unique gradient id with a matching fill reference, avoiding collisions when multiple charts render in one document (B2-OBS-001)", () => {
    const { container: containerA } = renderChart();
    const { container: containerB } = renderChart();

    const gradientA = containerA.querySelector("linearGradient");
    const gradientB = containerB.querySelector("linearGradient");
    expect(gradientA).toBeInTheDocument();
    expect(gradientB).toBeInTheDocument();

    const gradientIdA = gradientA!.getAttribute("id")!;
    const gradientIdB = gradientB!.getAttribute("id")!;
    expect(gradientIdA).not.toEqual(gradientIdB);

    const fillA = containerA.querySelector("path.text-primary[fill^='url(#']");
    const fillB = containerB.querySelector("path.text-primary[fill^='url(#']");
    expect(fillA!.getAttribute("fill")).toBe(`url(#${gradientIdA})`);
    expect(fillB!.getAttribute("fill")).toBe(`url(#${gradientIdB})`);
  });

  // Phase 1Q-0C hydration regression: the frozen aggregate's `date` field
  // can arrive as a full timestamptz string (e.g. "2026-08-26 00:00:00+00",
  // from get_management_reporting_aggregate's generate_series resolving to
  // its timestamptz overload) rather than "2026-08-26" — this reproduced
  // as a server/client hydration mismatch on this exact chart's tooltip
  // <title>. buildSalesTrendChartModel now normalizes the day key before
  // this component ever sees it, so the rendered label is the plain,
  // stable "Aug 26" form regardless of which shape the aggregate returns.
  // (Phase 1Q-0D: a second, independent hydration mismatch was later
  // found and fixed on this same tooltip — see tooltipCircle's own
  // comment above — the day-key normalization this test covers remains
  // necessary and unrelated to that fix.)
  it("renders a stable calendar-day label even when fed a full timestamptz day key (hydration regression)", () => {
    const timestamptzModel = buildSalesTrendChartModel([
      { date: "2026-08-26 00:00:00+00", revenue: 500, orderCount: 1, averageOrderValue: 500 },
    ]);
    const { container } = renderChart({ points: timestamptzModel.points, hasActivity: timestamptzModel.hasActivity });
    expect(tooltipCircle(container, "Aug 26: ₦500.00")).toBeInTheDocument();
    expect(container.querySelector('circle[title*="00:00:00"]')).not.toBeInTheDocument();
  });

  it.each([
    ["NG", "NGN", "₦"],
    ["GH", "GHS", "GH₵"],
    ["US", "USD", "$"],
  ])("shows the correct %s tooltip value in symbol form, never the ISO code", (_country, currencyCode, symbol) => {
    const { container } = renderChart({ currencyCode });
    expect(tooltipCircle(container, `Sep 14: ${symbol}1,500.00`)).toBeInTheDocument();
    expect(container.querySelector(`circle[title*="${currencyCode} 1,500"]`)).not.toBeInTheDocument();
  });

  it("keeps the description aria-labelledby relationship valid and per-instance unique across multiple chart instances", () => {
    const { container: containerA } = renderChart();
    const { container: containerB } = renderChart();

    for (const container of [containerA, containerB]) {
      const svg = container.querySelector("svg[role='img']")!;
      const labelledBy = svg.getAttribute("aria-labelledby")!;
      const description = container.querySelector(`#${CSS.escape(labelledBy)}`);
      expect(description).toBeInTheDocument();
    }

    const idA = containerA.querySelector("svg[role='img']")!.getAttribute("aria-labelledby");
    const idB = containerB.querySelector("svg[role='img']")!.getAttribute("aria-labelledby");
    expect(idA).not.toEqual(idB);
  });
});
