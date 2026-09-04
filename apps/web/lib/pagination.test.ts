import { describe, expect, it } from "vitest";
import { encodeCursor, decodeCursor, isCanonicalUuid, isCanonicalTimestamptz } from "./pagination";

describe("cursor pagination", () => {
  it("round-trips a valid cursor", () => {
    const cursor = { createdAt: "2026-08-26T00:00:00.000Z", id: "abc-123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns null for undefined/empty input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null (never throws) for a malformed/tampered cursor", () => {
    expect(decodeCursor("not-base64url-json")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ createdAt: 1 })).toString("base64url"))).toBeNull();
  });
});

// SEC-1K-APP-01 regression: these two functions are what the
// notifications DAL now applies to a decoded cursor's fields BEFORE
// interpolating either into a PostgREST `.or(...)` filter string — every
// case here proves a specific PostgREST-grammar-shaped or malformed
// value is rejected structurally, never merely "happens not to break
// anything in practice."
describe("isCanonicalUuid", () => {
  it("accepts a real uuid", () => {
    expect(isCanonicalUuid(crypto.randomUUID())).toBe(true);
  });

  it("accepts an uppercase uuid", () => {
    expect(isCanonicalUuid(crypto.randomUUID().toUpperCase())).toBe(true);
  });

  it.each([
    ["a comma-injected value", "11111111-1111-1111-1111-111111111111,x.eq.1"],
    ["a closing-paren-injected value", "11111111-1111-1111-1111-111111111111)"],
    ["a dot/operator-shaped value", "11111111-1111-1111-1111-111111111111.eq.1"],
    ["a quote-injected value", "11111111-1111-1111-1111-111111111111'"],
    ["a backslash-injected value", "11111111-1111-1111-1111-111111111111\\"],
    ["too short", "11111111-1111-1111-1111-11111111111"],
    ["too long (padded)", "11111111-1111-1111-1111-111111111111x"],
    ["not a uuid at all", "not-a-uuid"],
    ["empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(isCanonicalUuid(value)).toBe(false);
  });
});

describe("isCanonicalTimestamptz", () => {
  it("accepts the exact shape this project's own PostgREST layer emits (verified live)", () => {
    expect(isCanonicalTimestamptz("2026-09-03T21:24:39.657079+00:00")).toBe(true);
  });

  it("accepts a timestamp with no fractional part (Postgres omits it when exactly zero)", () => {
    expect(isCanonicalTimestamptz("2026-09-04T10:00:00+00:00")).toBe(true);
  });

  it.each(["1", "12", "123", "1234", "12345", "123456"])(
    "accepts every valid trimmed fractional-digit length: .%s",
    (fraction) => {
      expect(isCanonicalTimestamptz(`2026-09-04T10:00:00.${fraction}+00:00`)).toBe(true);
    }
  );

  it("accepts genuine microsecond precision at the final-instant boundary (.999999) without alteration", () => {
    const value = "2026-09-04T23:59:59.999999+00:00";
    expect(isCanonicalTimestamptz(value)).toBe(true);
    // The function is a pure predicate — it must never mutate or
    // otherwise imply a different canonical value than the one passed
    // in; the caller is expected to keep using this EXACT string.
    expect(value).toBe("2026-09-04T23:59:59.999999+00:00");
  });

  it("accepts .999500 (sub-millisecond, non-round) precision", () => {
    expect(isCanonicalTimestamptz("2026-09-04T23:59:59.999500+00:00")).toBe(true);
  });

  it.each([
    ["a comma-injected value", "2026-09-04T10:00:00+00:00,x.eq.1"],
    ["a closing-paren-injected value", "2026-09-04T10:00:00+00:00)"],
    ["arbitrary text", "'; drop table notifications; --"],
    ["a Z-suffixed value (not this project's actual format)", "2026-09-04T10:00:00.657079Z"],
    ["a malformed calendar date (month 13)", "2026-13-04T10:00:00+00:00"],
    ["a malformed calendar date (Feb 30)", "2026-02-30T10:00:00+00:00"],
    ["a malformed time (hour 24)", "2026-09-04T24:00:00+00:00"],
    ["a non-UTC offset", "2026-09-04T10:00:00+01:00"],
    ["whitespace", "2026-09-04T10:00:00 +00:00"],
    ["an overly long fractional part", "2026-09-04T10:00:00.1234567+00:00"],
    [
      "an overly long overall string",
      "2026-09-04T10:00:00.657079+00:00" + "0".repeat(20),
    ],
    ["empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(isCanonicalTimestamptz(value)).toBe(false);
  });
});
