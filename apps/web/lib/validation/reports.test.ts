import { describe, expect, it } from "vitest";
import { CustomReportRangeSchema, ReportRangePresetSchema } from "./reports";

describe("CustomReportRangeSchema", () => {
  it("accepts dateFrom before dateTo", () => {
    const result = CustomReportRangeSchema.safeParse({ dateFrom: "2026-08-01", dateTo: "2026-08-27" });
    expect(result.success).toBe(true);
  });

  it("accepts dateFrom equal to dateTo (a single-day range)", () => {
    const result = CustomReportRangeSchema.safeParse({ dateFrom: "2026-08-27", dateTo: "2026-08-27" });
    expect(result.success).toBe(true);
  });

  it("rejects dateFrom after dateTo — a safe UI error, never sent to the RPC", () => {
    const result = CustomReportRangeSchema.safeParse({ dateFrom: "2026-08-27", dateTo: "2026-08-01" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed date", () => {
    const result = CustomReportRangeSchema.safeParse({ dateFrom: "not-a-date", dateTo: "2026-08-27" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field", () => {
    const result = CustomReportRangeSchema.safeParse({ dateFrom: "2026-08-01" });
    expect(result.success).toBe(false);
  });
});

describe("ReportRangePresetSchema", () => {
  it.each(["today", "last_7_days", "last_30_days", "this_month", "previous_month", "custom"])(
    "accepts %s",
    (preset) => {
      expect(ReportRangePresetSchema.safeParse(preset).success).toBe(true);
    }
  );

  it("rejects an unknown preset", () => {
    expect(ReportRangePresetSchema.safeParse("this_year").success).toBe(false);
  });
});
