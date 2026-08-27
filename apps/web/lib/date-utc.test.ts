import { describe, expect, it } from "vitest";
import {
  startOfUtcDay,
  addUtcDays,
  startOfUtcMonth,
  parseCalendarDateUtc,
  calendarDayStartUtc,
  calendarDayEndExclusiveUtc,
  isRealTimestampInstant,
} from "./date-utc";

describe("startOfUtcDay / addUtcDays / startOfUtcMonth", () => {
  it("startOfUtcDay truncates to UTC midnight", () => {
    expect(startOfUtcDay(new Date("2026-08-15T14:30:00.000Z")).toISOString()).toBe(
      "2026-08-15T00:00:00.000Z"
    );
  });

  it("addUtcDays moves by exactly N*24h, crossing month/year boundaries correctly", () => {
    expect(addUtcDays(new Date("2026-08-15T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-08-16T00:00:00.000Z"
    );
    expect(addUtcDays(new Date("2026-12-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("startOfUtcMonth truncates to the 1st of the month at UTC midnight", () => {
    expect(startOfUtcMonth(new Date("2026-08-15T14:30:00.000Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
  });
});

describe("parseCalendarDateUtc", () => {
  it("parses a well-formed calendar date to UTC midnight", () => {
    expect(parseCalendarDateUtc("2026-08-26")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("rejects a non-YYYY-MM-DD shape", () => {
    expect(parseCalendarDateUtc("2026-8-26")).toBeNull();
    expect(parseCalendarDateUtc("08/26/2026")).toBeNull();
    expect(parseCalendarDateUtc("2026-08-26T00:00:00Z")).toBeNull();
    expect(parseCalendarDateUtc("not-a-date")).toBeNull();
    expect(parseCalendarDateUtc("")).toBeNull();
  });

  it("rejects a calendar date that doesn't exist (e.g. Feb 30) rather than silently rolling forward", () => {
    expect(parseCalendarDateUtc("2026-02-30")).toBeNull();
    expect(parseCalendarDateUtc("2026-13-01")).toBeNull();
    expect(parseCalendarDateUtc("2026-00-01")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(parseCalendarDateUtc("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("calendarDayStartUtc / calendarDayEndExclusiveUtc (the exact Finding-1 fix)", () => {
  it("calendarDayStartUtc is the inclusive start-of-day instant", () => {
    expect(calendarDayStartUtc("2026-08-26")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("calendarDayEndExclusiveUtc is the EXCLUSIVE next-day boundary, never 23:59:59(.999)", () => {
    expect(calendarDayEndExclusiveUtc("2026-08-26")?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("both return null for a malformed value — callers must omit the filter, never pass the raw string through", () => {
    expect(calendarDayStartUtc("not-a-date")).toBeNull();
    expect(calendarDayEndExclusiveUtc("not-a-date")).toBeNull();
  });

  it("an instant at noon on the selected day falls within [start, endExclusive)", () => {
    const start = calendarDayStartUtc("2026-08-26")!;
    const end = calendarDayEndExclusiveUtc("2026-08-26")!;
    const noon = new Date("2026-08-26T12:00:00.000Z");
    expect(noon.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(noon.getTime()).toBeLessThan(end.getTime());
  });

  it("the last instant of the selected day (23:59:59.999) falls within the range", () => {
    const end = calendarDayEndExclusiveUtc("2026-08-26")!;
    const lastInstant = new Date("2026-08-26T23:59:59.999Z");
    expect(lastInstant.getTime()).toBeLessThan(end.getTime());
  });

  it("the first instant of the FOLLOWING day is excluded", () => {
    const end = calendarDayEndExclusiveUtc("2026-08-26")!;
    const nextDay = new Date("2026-08-27T00:00:00.000Z");
    expect(nextDay.getTime()).toBe(end.getTime()); // excluded by a `<` (lt) comparison, not `<=`
  });
});

// Codex adversarial review (2nd pass), Finding 2 + Finding 7.B — strict
// timestamptz-shaped validation, deliberately NOT Date.parse. The
// canonical examples below are the real, observed shapes PostgREST
// returns for a timestamptz column (see isRealTimestampInstant's own
// header comment for how these were confirmed against the live local
// Data API), plus the "Z" spelling Date.prototype.toISOString() itself
// produces.
describe("isRealTimestampInstant", () => {
  it("accepts the real PostgREST-returned shape with millisecond precision and a +00:00 offset", () => {
    expect(isRealTimestampInstant("2026-08-27T19:54:42.395+00:00")).toBe(true);
  });

  it("accepts the real PostgREST-returned shape with microsecond precision (a now()-defaulted column)", () => {
    expect(isRealTimestampInstant("2026-08-27T19:54:42.406849+00:00")).toBe(true);
  });

  it("accepts a Z-suffixed timestamp (Date.prototype.toISOString()'s own output shape)", () => {
    expect(isRealTimestampInstant("2026-08-27T19:54:42.395Z")).toBe(true);
  });

  it("accepts a timestamp with no fractional seconds at all", () => {
    expect(isRealTimestampInstant("2026-08-27T19:54:42+00:00")).toBe(true);
  });

  it('rejects "0" — Date.parse("0") succeeds in JS but Postgres rejects \'0\'::timestamptz (the exact Codex repro)', () => {
    expect(isRealTimestampInstant("0")).toBe(false);
  });

  it.each(["123", "not-a-date", "04 DecFoo 1995", "2026-08-27", "2026/08/27T19:54:42Z", ""])(
    "rejects %s",
    (value) => {
      expect(isRealTimestampInstant(value)).toBe(false);
    }
  );

  it("rejects an impossible calendar date (2026-02-30) rather than letting Date silently roll it into March", () => {
    expect(isRealTimestampInstant("2026-02-30T00:00:00.000Z")).toBe(false);
  });

  it("rejects an out-of-range month/hour/minute/second", () => {
    expect(isRealTimestampInstant("2026-13-01T00:00:00.000Z")).toBe(false);
    expect(isRealTimestampInstant("2026-08-27T24:00:00.000Z")).toBe(false);
    expect(isRealTimestampInstant("2026-08-27T00:60:00.000Z")).toBe(false);
    expect(isRealTimestampInstant("2026-08-27T00:00:60.000Z")).toBe(false);
  });

  it("rejects a malformed/invalid timezone offset shape", () => {
    expect(isRealTimestampInstant("2026-08-27T19:54:42.395+0000")).toBe(false); // missing colon
    expect(isRealTimestampInstant("2026-08-27T19:54:42.395")).toBe(false); // no offset at all
    expect(isRealTimestampInstant("2026-08-27T19:54:42.395+00")).toBe(false); // truncated offset
  });

  it("accepts a real leap day", () => {
    expect(isRealTimestampInstant("2028-02-29T00:00:00.000Z")).toBe(true);
  });

  // Codex adversarial review (3rd pass), Finding 1 — the timezone offset
  // grammar is deliberately narrowed to exactly `Z` or `+00:00`. An
  // expense cursor's timestamp is never a user-entered business-local
  // value (this application has no per-business timezone setting), so
  // any OTHER offset — even a syntactically valid, real-world one — is
  // never legitimate here, and an out-of-range one is exactly what
  // Postgres's own timestamptz parser rejects too.
  it.each([
    "2026-08-27T19:54:42.395+99:99", // out-of-range offset hours/minutes
    "2026-08-27T19:54:42.395+16:00", // a real timezone, but not UTC — never legitimate for this cursor
    "2026-08-27T19:54:42.395+01:00",
    "2026-08-27T19:54:42.395-01:00",
  ])("rejects the non-UTC/out-of-range offset %s", (value) => {
    expect(isRealTimestampInstant(value)).toBe(false);
  });

  it('rejects year 0000 — Postgres\'s timestamptz input parser rejects it outright (the exact Codex repro)', () => {
    expect(isRealTimestampInstant("0000-01-01T00:00:00.000Z")).toBe(false);
  });

  it("accepts year 0001 — the minimum this application requires (no BC-date support needed)", () => {
    expect(isRealTimestampInstant("0001-01-01T00:00:00.000Z")).toBe(true);
  });

  it("rejects 2026-02-29 — not a leap year — without relying on Date's own rollover behavior", () => {
    expect(isRealTimestampInstant("2026-02-29T00:00:00.000Z")).toBe(false);
  });

  it("rejects 2026-04-31 — April has 30 days", () => {
    expect(isRealTimestampInstant("2026-04-31T00:00:00.000Z")).toBe(false);
  });

  it("rejects month 00", () => {
    expect(isRealTimestampInstant("2026-00-15T00:00:00.000Z")).toBe(false);
  });

  it("rejects day 00", () => {
    expect(isRealTimestampInstant("2026-08-00T00:00:00.000Z")).toBe(false);
  });
});
