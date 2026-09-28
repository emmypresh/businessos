import { describe, expect, it } from "vitest";
import {
  PlatformBusinessQuerySchema,
  parsePlatformBusinessQuery,
  PLATFORM_BUSINESS_SORT,
} from "./platform-businesses";

describe("PlatformBusinessQuerySchema", () => {
  it("defaults to page 1, created_at desc, no filters", () => {
    const result = PlatformBusinessQuerySchema.parse({});
    expect(result).toEqual({ sort: PLATFORM_BUSINESS_SORT.CREATED_AT, dir: "desc", page: 1 });
  });

  it("uppercases and accepts a valid country code", () => {
    const result = PlatformBusinessQuerySchema.parse({ country: "gh" });
    expect(result.country).toBe("GH");
  });

  it("rejects a malformed country code", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ country: "GHA" });
    expect(result.success).toBe(false);
  });

  it("uppercases and accepts a valid currency code", () => {
    const result = PlatformBusinessQuerySchema.parse({ currency: "ngn" });
    expect(result.currency).toBe("NGN");
  });

  it("rejects a search string over 200 characters", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ q: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("accepts a search string at exactly 200 characters", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ q: "x".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown sort value", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ sort: "created_by" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown plan code", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ plan: "FREE" });
    expect(result.success).toBe(false);
  });

  it("rejects page below 1", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer page", () => {
    const result = PlatformBusinessQuerySchema.safeParse({ page: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("parsePlatformBusinessQuery", () => {
  it("ignores unexpected array-valued params and falls back to defaults", () => {
    const result = parsePlatformBusinessQuery({ q: ["a", "b"] });
    expect(result.q).toBeUndefined();
  });

  it("falls back to full defaults when the whole query is malformed", () => {
    const result = parsePlatformBusinessQuery({ sort: "nonsense", page: "-5" });
    expect(result).toEqual({ sort: PLATFORM_BUSINESS_SORT.CREATED_AT, dir: "desc", page: 1 });
  });

  it("parses a well-formed query string record", () => {
    const result = parsePlatformBusinessQuery({
      q: "acme",
      country: "us",
      plan: "GROWTH",
      sort: "name",
      dir: "asc",
      page: "2",
    });
    expect(result).toEqual({
      q: "acme",
      country: "US",
      plan: "GROWTH",
      sort: "name",
      dir: "asc",
      page: 2,
    });
  });
});
