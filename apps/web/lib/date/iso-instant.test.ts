import { describe, expect, it } from "vitest";
import { isValidOffsetBearingInstant } from "./iso-instant";

describe("isValidOffsetBearingInstant", () => {
  it.each([
    "2026-08-31T14:30:00.000Z",
    "2026-08-31T15:30:00+01:00",
    "2026-08-31T15:30:00.123+01:00",
    "2024-02-29T12:00:00Z",
  ])("accepts %s", (value) => {
    expect(isValidOffsetBearingInstant(value)).toBe(true);
  });

  // Codex adversarial review, remediation round 3: JS Date normalization
  // must never define validity — each of these is exactly the kind of
  // impossible calendar date `new Date(...)`/`Date.parse(...)` would
  // silently roll into a DIFFERENT, valid instant instead of rejecting.
  it.each([
    "2026-02-30T15:30:00Z", // February never has a 30th
    "2026-02-29T15:30:00Z", // 2026 is not a leap year
    "2026-04-31T15:30:00Z", // April has only 30 days
    "2026-13-01T15:30:00Z", // month 13 does not exist
    "2026-00-10T15:30:00Z", // month 0 does not exist
    "2026-01-32T15:30:00Z", // January has only 31 days
    "2026-08-31T24:00:00Z", // hour 24 does not exist (0-23 only)
    "2026-08-31T23:60:00Z", // minute 60 does not exist (0-59 only)
    "2026-08-31T23:59:60Z", // no leap-second support — 60 is rejected
    "2026-08-31T15:30", // no seconds, no offset — timezone-less
    "2026-08-31T15:30:00", // seconds but still no offset
    "2026-08-31", // date only, no time at all
    "15:30", // time only, no date at all
    "random text",
  ])("rejects %s", (value) => {
    expect(isValidOffsetBearingInstant(value)).toBe(false);
  });

  // Full Gregorian leap-year rule: divisible by 4, except divisible by
  // 100, unless ALSO divisible by 400.
  describe("leap year rule", () => {
    it("2024-02-29 is valid (divisible by 4, not by 100)", () => {
      expect(isValidOffsetBearingInstant("2024-02-29T12:00:00Z")).toBe(true);
    });
    it("2026-02-29 is invalid (not divisible by 4)", () => {
      expect(isValidOffsetBearingInstant("2026-02-29T12:00:00Z")).toBe(false);
    });
    it("2000-02-29 is valid (divisible by 400)", () => {
      expect(isValidOffsetBearingInstant("2000-02-29T12:00:00Z")).toBe(true);
    });
    it("2100-02-29 is invalid (divisible by 100, not by 400)", () => {
      expect(isValidOffsetBearingInstant("2100-02-29T12:00:00Z")).toBe(false);
    });
  });

  // Codex adversarial review, remediation round 3: numeric offsets must
  // themselves be real — a shape-only regex match is not enough.
  describe("offset validation", () => {
    it.each(["+14:00", "-12:00", "+05:30", "+00:00", "-00:00"])(
      "accepts the legitimate offset %s",
      (offset) => {
        expect(isValidOffsetBearingInstant(`2026-08-31T15:30:00${offset}`)).toBe(true);
      }
    );

    it.each(["+24:00", "+12:60", "-25:00"])("rejects the impossible offset %s", (offset) => {
      expect(isValidOffsetBearingInstant(`2026-08-31T15:30:00${offset}`)).toBe(false);
    });
  });
});
