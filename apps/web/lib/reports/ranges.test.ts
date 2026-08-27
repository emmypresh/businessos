import { describe, expect, it } from "vitest";
import { resolvePresetRange, resolveCustomRange, resolveReportRange } from "./ranges";
import { REPORT_RANGE_PRESET } from "./constants";

// A fixed instant, deliberately mid-day and mid-month (not a boundary
// itself), so every preset's own boundary math is exercised rather than
// accidentally coinciding with `now`.
const NOW = new Date("2026-08-15T14:30:00.000Z");

describe("resolvePresetRange (every boundary is an explicit [from, to) pair, never an inclusive-end hack)", () => {
  it("TODAY: [start of today UTC, start of tomorrow UTC)", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.TODAY, NOW);
    expect(range).toEqual({
      from: "2026-08-15T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("LAST_7_DAYS: today plus the six days before it", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.LAST_7_DAYS, NOW);
    expect(range).toEqual({
      from: "2026-08-09T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("LAST_30_DAYS: today plus the twenty-nine days before it", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.LAST_30_DAYS, NOW);
    expect(range).toEqual({
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("THIS_MONTH: [start of this month, start of next month)", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.THIS_MONTH, NOW);
    expect(range).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });
  });

  it("PREVIOUS_MONTH: [start of previous month, start of this month)", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.PREVIOUS_MONTH, NOW);
    expect(range).toEqual({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
  });

  it("PREVIOUS_MONTH correctly crosses a year boundary (January -> previous December)", () => {
    const range = resolvePresetRange(REPORT_RANGE_PRESET.PREVIOUS_MONTH, new Date("2027-01-10T00:00:00.000Z"));
    expect(range).toEqual({
      from: "2026-12-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
  });

  it("every relative preset produces a strictly increasing from < to pair", () => {
    for (const preset of [
      REPORT_RANGE_PRESET.TODAY,
      REPORT_RANGE_PRESET.LAST_7_DAYS,
      REPORT_RANGE_PRESET.LAST_30_DAYS,
      REPORT_RANGE_PRESET.THIS_MONTH,
      REPORT_RANGE_PRESET.PREVIOUS_MONTH,
    ] as const) {
      const range = resolvePresetRange(preset, NOW);
      expect(new Date(range.from).getTime(), preset).toBeLessThan(new Date(range.to).getTime());
    }
  });
});

describe("resolveCustomRange", () => {
  it("resolves a single-day range to a 24-hour [from, to) window", () => {
    const range = resolveCustomRange({ dateFrom: "2026-08-15", dateTo: "2026-08-15" });
    expect(range).toEqual({
      from: "2026-08-15T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("the end date is fully included via the exclusive next-day boundary", () => {
    const range = resolveCustomRange({ dateFrom: "2026-08-01", dateTo: "2026-08-27" });
    expect(range).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-28T00:00:00.000Z",
    });
  });
});

describe("resolveReportRange", () => {
  it("resolves a non-custom preset regardless of the custom argument", () => {
    const range = resolveReportRange(REPORT_RANGE_PRESET.TODAY, null, NOW);
    expect(range).toEqual({ from: "2026-08-15T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" });
  });

  it("resolves CUSTOM using the supplied custom range", () => {
    const range = resolveReportRange(
      REPORT_RANGE_PRESET.CUSTOM,
      { dateFrom: "2026-08-01", dateTo: "2026-08-05" },
      NOW
    );
    expect(range).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z" });
  });

  it("returns null for CUSTOM with no custom range supplied — never a fabricated zero-width range", () => {
    expect(resolveReportRange(REPORT_RANGE_PRESET.CUSTOM, null, NOW)).toBeNull();
  });
});
