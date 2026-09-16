import { describe, expect, it } from "vitest";
import { formatComparison } from "./comparison";

describe("formatComparison", () => {
  it("reports positive and negative percentage changes with a neutral textual label", () => {
    expect(formatComparison(120, 100)).toMatchObject({ state: "increase", percentage: 20, label: "Up 20% vs previous period" });
    expect(formatComparison(75, 100)).toMatchObject({ state: "decrease", percentage: -25, label: "Down 25% vs previous period" });
  });

  it("uses the magnitude of a negative prior value so comparisons remain finite", () => {
    expect(formatComparison(-50, -100)).toMatchObject({ state: "increase", percentage: 50, label: "Up 50% vs previous period" });
    expect(formatComparison(-150, -100)).toMatchObject({ state: "decrease", percentage: -50, label: "Down 50% vs previous period" });
  });

  it("never displays a percentage when the prior period is zero", () => {
    expect(formatComparison(20, 0)).toEqual({ state: "no-prior-data", percentage: null, label: "No prior data" });
    expect(formatComparison(0, 0)).toEqual({ state: "no-activity", percentage: null, label: "No activity in either period" });
  });

  it("reports unavailable values as no data instead of NaN or Infinity", () => {
    expect(formatComparison(null, 10)).toEqual({ state: "unavailable", percentage: null, label: "No comparison data" });
    expect(formatComparison(Number.NaN, 10)).toEqual({ state: "unavailable", percentage: null, label: "No comparison data" });
  });
});
