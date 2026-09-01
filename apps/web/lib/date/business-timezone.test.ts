import { describe, expect, it } from "vitest";
import { businessTodayDateString } from "./business-timezone";

describe("businessTodayDateString", () => {
  it("returns the Africa/Lagos calendar date, not the UTC one, near midnight", () => {
    // 00:30 Africa/Lagos (UTC+1) on Sep 1 == 23:30 UTC on Aug 31.
    expect(businessTodayDateString(new Date("2026-08-31T23:30:00.000Z"))).toBe("2026-09-01");
  });

  it("matches the UTC date away from the midnight boundary", () => {
    expect(businessTodayDateString(new Date("2026-08-31T12:00:00.000Z"))).toBe("2026-08-31");
  });

  it("still rolls over correctly just before the Lagos boundary", () => {
    // 23:59 Africa/Lagos on Aug 31 == 22:59 UTC on Aug 31 — still Aug 31.
    expect(businessTodayDateString(new Date("2026-08-31T22:59:00.000Z"))).toBe("2026-08-31");
  });
});
