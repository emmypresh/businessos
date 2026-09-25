import { describe, expect, it } from "vitest";
import { buildSalesTrendChartModel, formatCompactCurrency, formatIntegerTick, metricValue, SALES_TREND_METRIC } from "./sales-trend-chart";

describe("buildSalesTrendChartModel", () => {
  it("preserves frozen daily revenue, order count, and average order value exactly", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: 1500, orderCount: 3, averageOrderValue: 500 },
      { date: "2026-09-15", revenue: 900, orderCount: 2, averageOrderValue: 450 },
    ]);
    expect(model.points[0]).toMatchObject({ date: "2026-09-14", revenue: 1500, salesCount: 3, averageOrderValue: 500 });
    expect(model.points[1]).toMatchObject({ date: "2026-09-15", revenue: 900, salesCount: 2, averageOrderValue: 450 });
  });

  it("sorts daily buckets into chronological order regardless of input order", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-16", revenue: 100, orderCount: 1, averageOrderValue: 100 },
      { date: "2026-09-14", revenue: 200, orderCount: 2, averageOrderValue: 100 },
      { date: "2026-09-15", revenue: 300, orderCount: 3, averageOrderValue: 100 },
    ]);
    expect(model.points.map((p) => p.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("keeps sales count as a non-negative integer", () => {
    const model = buildSalesTrendChartModel([{ date: "2026-09-14", revenue: 0, orderCount: 3.0, averageOrderValue: 0 }]);
    expect(Number.isInteger(model.points[0].salesCount)).toBe(true);
  });

  it("preserves zero-activity days rather than dropping them", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: 500, orderCount: 1, averageOrderValue: 500 },
      { date: "2026-09-15", revenue: 0, orderCount: 0, averageOrderValue: 0 },
    ]);
    expect(model.points).toHaveLength(2);
    expect(model.points[1]).toMatchObject({ date: "2026-09-15", revenue: 0, salesCount: 0, averageOrderValue: 0 });
  });

  it("reports hasActivity=false when every day in the period is zero", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: 0, orderCount: 0, averageOrderValue: 0 },
      { date: "2026-09-15", revenue: 0, orderCount: 0, averageOrderValue: 0 },
    ]);
    expect(model.hasActivity).toBe(false);
  });

  it("reports hasActivity=true when at least one day has revenue or sales", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: 0, orderCount: 0, averageOrderValue: 0 },
      { date: "2026-09-15", revenue: 250, orderCount: 1, averageOrderValue: 250 },
    ]);
    expect(model.hasActivity).toBe(true);
  });

  it("never produces NaN or Infinity even from a malformed non-finite input", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-09-14", revenue: Number.NaN, orderCount: Number.POSITIVE_INFINITY, averageOrderValue: Number.NaN },
    ]);
    expect(Number.isFinite(model.points[0].revenue)).toBe(true);
    expect(Number.isFinite(model.points[0].salesCount)).toBe(true);
    expect(Number.isFinite(model.points[0].averageOrderValue)).toBe(true);
  });

  it("produces a readable UTC day label without shifting the bucket's date", () => {
    const model = buildSalesTrendChartModel([{ date: "2026-01-01", revenue: 0, orderCount: 0, averageOrderValue: 0 }]);
    expect(model.points[0].date).toBe("2026-01-01");
    expect(model.points[0].label).toBe("Jan 1");
  });

  it("returns an empty model for an empty aggregate", () => {
    const model = buildSalesTrendChartModel([]);
    expect(model.points).toEqual([]);
    expect(model.hasActivity).toBe(false);
  });

  // Phase 1Q-0C hydration regression: get_management_reporting_aggregate's
  // `d.day::text` (generate_series resolving to the timestamptz overload,
  // never a plain `date`) can come back as a full timestamptz string like
  // "2026-08-26 00:00:00+00" rather than "2026-08-26" — this reproduced as
  // a server/client hydration mismatch (implementation-defined Date.parse
  // of the previous `` `${date}T00:00:00Z` `` concatenation). Both the
  // `date` key and the `label` must normalize to the plain calendar day
  // regardless of which form the aggregate returns, deterministically, no
  // Date.parse on the raw value involved.
  it("normalizes a full timestamptz day key to a plain YYYY-MM-DD date and a stable label", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-08-26 00:00:00+00", revenue: 100, orderCount: 1, averageOrderValue: 100 },
    ]);
    expect(model.points[0].date).toBe("2026-08-26");
    expect(model.points[0].label).toBe("Aug 26");
  });

  it("normalizes an ISO timestamp day key (with T/Z) identically to the plain form", () => {
    const model = buildSalesTrendChartModel([
      { date: "2026-08-26T00:00:00.000Z", revenue: 0, orderCount: 0, averageOrderValue: 0 },
    ]);
    expect(model.points[0].date).toBe("2026-08-26");
    expect(model.points[0].label).toBe("Aug 26");
  });
});

describe("metricValue", () => {
  const point = { date: "2026-09-14", label: "Sep 14", revenue: 1000, salesCount: 4, averageOrderValue: 250 };
  it("selects the field matching each metric mode", () => {
    expect(metricValue(point, SALES_TREND_METRIC.REVENUE)).toBe(1000);
    expect(metricValue(point, SALES_TREND_METRIC.SALES)).toBe(4);
    expect(metricValue(point, SALES_TREND_METRIC.AOV)).toBe(250);
  });
});

describe("formatCompactCurrency", () => {
  it("formats large amounts compactly with the currency symbol, not the ISO code", () => {
    expect(formatCompactCurrency(1200000, "NGN")).toBe("₦1.2M");
  });

  // Phase 1Q-0C: all six launch currencies' symbols, compact-formatted —
  // mirrors lib/currency.ts's own CURRENCY_SYMBOLS table exactly.
  it.each([
    ["NGN", "₦"],
    ["GHS", "GH₵"],
    ["KES", "KSh"],
    ["ZAR", "R"],
    ["GBP", "£"],
    ["USD", "$"],
  ])("uses the %s symbol (%s) for compact axis ticks", (code, symbol) => {
    expect(formatCompactCurrency(1200000, code)).toBe(`${symbol}1.2M`);
  });
});

describe("formatIntegerTick", () => {
  it("never renders a decimal for a count value", () => {
    expect(formatIntegerTick(4.0)).toBe("4");
    expect(formatIntegerTick(1234)).toBe("1,234");
  });
});
