import { describe, expect, it } from "vitest";
import {
  parseReportRangeQuery,
  formatReportRangeLabel,
  buildReportRangeSearchParams,
  MAX_REPORT_RANGE_DAYS,
  EXCESSIVE_RANGE_MESSAGE,
} from "./report-range-query";
import { REPORT_RANGE_PRESET } from "./constants";

const NOW = new Date("2026-08-15T14:30:00.000Z");

describe("parseReportRangeQuery", () => {
  it("defaults to last_30_days when no preset is given", () => {
    const result = parseReportRangeQuery({}, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.preset).toBe(REPORT_RANGE_PRESET.LAST_30_DAYS);
    expect(result.query.range).toEqual({
      from: "2026-07-17T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("resolves last_7_days", () => {
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.LAST_7_DAYS }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2026-08-09T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("resolves last_30_days explicitly", () => {
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.LAST_30_DAYS }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range.from).toBe("2026-07-17T00:00:00.000Z");
  });

  it("resolves last_90_days-equivalent presets are not invented — 90 days is out of scope for C1 presets", () => {
    // Documented scope decision: the preset set is TODAY/7/30/THIS_MONTH/
    // PREVIOUS_MONTH/CUSTOM, matching the frozen constants.ts enum exactly
    // — this module never adds a preset value ranges.ts/constants.ts don't
    // already define.
    const result = parseReportRangeQuery({ preset: "last_90_days" }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.preset).toBe(REPORT_RANGE_PRESET.LAST_30_DAYS);
  });

  it("resolves this_month", () => {
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.THIS_MONTH }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });
  });

  it("resolves previous_month", () => {
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.PREVIOUS_MONTH }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
  });

  it("resolves a valid custom range", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2026-08-01", dateTo: "2026-08-10" },
      NOW
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-11T00:00:00.000Z",
    });
    expect(result.query.custom).toEqual({ dateFrom: "2026-08-01", dateTo: "2026-08-10" });
  });

  it("rejects an invalid date string", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "not-a-date", dateTo: "2026-08-10" },
      NOW
    );
    expect(result.status).toBe("error");
  });

  it("rejects an impossible calendar date", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2026-02-30", dateTo: "2026-03-01" },
      NOW
    );
    expect(result.status).toBe("error");
  });

  it("rejects from >= to", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2026-08-27", dateTo: "2026-08-01" },
      NOW
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.message).toMatch(/start date must be on or before/i);
  });

  it("rejects a custom range wider than the maximum", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2020-01-01", dateTo: "2026-08-15" },
      NOW
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.message).toBe(EXCESSIVE_RANGE_MESSAGE);
  });

  it("accepts a custom range exactly at the maximum", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2025-08-16", dateTo: "2026-08-15" },
      NOW
    );
    expect(result.status).toBe("ok");
  });

  it("falls back to an unknown preset -> default, never a thrown error", () => {
    const result = parseReportRangeQuery({ preset: "quarterly" }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.preset).toBe(REPORT_RANGE_PRESET.LAST_30_DAYS);
  });

  it("treats a custom preset with no dates yet as pending, not an error", () => {
    const result = parseReportRangeQuery({ preset: "custom" }, NOW);
    expect(result.status).toBe("pending");
  });

  it("treats a custom preset with only one date supplied as an error, not pending", () => {
    const result = parseReportRangeQuery({ preset: "custom", dateFrom: "2026-08-01" }, NOW);
    expect(result.status).toBe("error");
  });

  it("resolves correctly across a UTC calendar-day boundary independent of local timezone", () => {
    const lateUtcNow = new Date("2026-08-15T23:59:59.000Z");
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.TODAY }, lateUtcNow);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2026-08-15T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("resolves a leap-year custom range correctly", () => {
    const result = parseReportRangeQuery(
      { preset: "custom", dateFrom: "2028-02-28", dateTo: "2028-02-29" },
      new Date("2028-03-01T00:00:00.000Z")
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.range).toEqual({
      from: "2028-02-28T00:00:00.000Z",
      to: "2028-03-01T00:00:00.000Z",
    });
  });

  it("produces a half-open end boundary — the label never displays the exclusive `to` day itself", () => {
    const result = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.TODAY }, NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.query.label).toBe("Aug 15, 2026, UTC");
  });

  it("is deterministic given an explicit `now` — never reads the caller's local Date/timezone", () => {
    const a = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.LAST_7_DAYS }, NOW);
    const b = parseReportRangeQuery({ preset: REPORT_RANGE_PRESET.LAST_7_DAYS }, new Date(NOW.getTime()));
    expect(a).toEqual(b);
  });
});

describe("formatReportRangeLabel", () => {
  it("formats a multi-day range as an inclusive-looking, UTC-labeled string", () => {
    expect(
      formatReportRangeLabel({ from: "2026-08-18T00:00:00.000Z", to: "2026-09-17T00:00:00.000Z" })
    ).toBe("Aug 18, 2026 – Sep 16, 2026, UTC");
  });

  it(`MAX_REPORT_RANGE_DAYS matches the frozen management-aggregate cap`, () => {
    expect(MAX_REPORT_RANGE_DAYS).toBe(366);
  });
});

describe("buildReportRangeSearchParams", () => {
  it("carries a preset forward", () => {
    expect(buildReportRangeSearchParams({ preset: "last_7_days" }).toString()).toBe("preset=last_7_days");
  });

  it("carries preset plus custom dateFrom/dateTo forward", () => {
    const params = buildReportRangeSearchParams({ preset: "custom", dateFrom: "2026-08-01", dateTo: "2026-08-10" });
    expect(params.get("preset")).toBe("custom");
    expect(params.get("dateFrom")).toBe("2026-08-01");
    expect(params.get("dateTo")).toBe("2026-08-10");
  });

  it("never includes a branch key — this module has no branch opinion", () => {
    const params = buildReportRangeSearchParams({ preset: "last_30_days" });
    expect(params.has("branch")).toBe(false);
    expect(Array.from(params.keys())).toEqual(["preset"]);
  });

  it("omits unset fields rather than emitting empty query keys", () => {
    expect(buildReportRangeSearchParams({}).toString()).toBe("");
  });
});
