import { describe, expect, it } from "vitest";
import { REPORT_RANGE_PRESET, REPORT_RANGE_PRESET_LABEL, REPORT_RANGE_UTC_HELPER_TEXT } from "./constants";

// Codex adversarial review (2nd pass), Finding 4.E — pins the exact
// visible label/helper text strings the UTC-semantics fix (Finding 2,
// 1st pass) requires. lib/reports/report-source-safety.test.ts's own
// STATIC SOURCE GUARD separately proves DateRangePicker actually
// consumes these constants (not a hardcoded, possibly-diverged copy) —
// this file is the one place the exact wording itself is pinned.
describe("REPORT_RANGE_PRESET_LABEL — every relative preset is explicitly labeled (UTC)", () => {
  it("matches the exact required label text for every relative preset", () => {
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.TODAY]).toBe("Today (UTC)");
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.LAST_7_DAYS]).toBe("Last 7 days (UTC)");
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.LAST_30_DAYS]).toBe("Last 30 days (UTC)");
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.THIS_MONTH]).toBe("This month (UTC)");
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.PREVIOUS_MONTH]).toBe("Previous month (UTC)");
  });

  it("every relative preset's label ends with the literal \"(UTC)\" suffix", () => {
    const relativePresets = [
      REPORT_RANGE_PRESET.TODAY,
      REPORT_RANGE_PRESET.LAST_7_DAYS,
      REPORT_RANGE_PRESET.LAST_30_DAYS,
      REPORT_RANGE_PRESET.THIS_MONTH,
      REPORT_RANGE_PRESET.PREVIOUS_MONTH,
    ] as const;
    for (const preset of relativePresets) {
      expect(REPORT_RANGE_PRESET_LABEL[preset], preset).toMatch(/\(UTC\)$/);
    }
  });

  it("CUSTOM is deliberately unsuffixed — the UTC caveat is communicated via the always-visible helper text instead", () => {
    expect(REPORT_RANGE_PRESET_LABEL[REPORT_RANGE_PRESET.CUSTOM]).toBe("Custom");
  });
});

describe("REPORT_RANGE_UTC_HELPER_TEXT", () => {
  it("is the exact required helper copy", () => {
    expect(REPORT_RANGE_UTC_HELPER_TEXT).toBe(
      "Reporting periods use UTC. Business timezone settings are not yet available."
    );
  });

  it("mentions UTC explicitly (case-sensitive, not buried in unrelated prose)", () => {
    expect(REPORT_RANGE_UTC_HELPER_TEXT).toContain("UTC");
  });
});
