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

  it("accepts an explicit business timezone (Phase 1Q-0B)", () => {
    // 00:30 America/New_York (UTC-4 in September, EDT) on Sep 1 == 04:30
    // UTC on Sep 1 — still rolls to Sep 1 local even though it's already
    // past midnight UTC on the SAME day, exercising DST handling a fixed
    // offset (the pre-1Q-0B implementation) could not have supported.
    expect(businessTodayDateString(new Date("2026-09-01T04:30:00.000Z"), "America/New_York")).toBe("2026-09-01");
    // 23:30 America/New_York on Aug 31 == 03:30 UTC on Sep 1 — still Aug 31 local.
    expect(businessTodayDateString(new Date("2026-09-01T03:30:00.000Z"), "America/New_York")).toBe("2026-08-31");
  });

  it("defaults to Africa/Lagos when no timezone is supplied", () => {
    expect(businessTodayDateString(new Date("2026-08-31T23:30:00.000Z"))).toBe(
      businessTodayDateString(new Date("2026-08-31T23:30:00.000Z"), "Africa/Lagos")
    );
  });
});
