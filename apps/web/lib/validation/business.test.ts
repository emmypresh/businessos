import { describe, expect, it } from "vitest";
import { CountryCodeSchema, CreateBusinessSchema, CurrencyCodeSchema, UpdateBusinessTimezoneSchema } from "./business";

const VALID = {
  name: "Acme Hardware",
  slug: "acme-hardware",
  countryCode: "NG",
  timezone: "Africa/Lagos",
};

describe("CreateBusinessSchema", () => {
  it("accepts a valid submission", () => {
    const result = CreateBusinessSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, name: "A" }).success).toBe(false);
  });

  it("rejects a name longer than 150 characters", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, name: "A".repeat(151) }).success).toBe(false);
  });

  it("rejects a slug with uppercase letters", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, slug: "Acme-Hardware" }).success).toBe(false);
  });

  it("rejects a slug with consecutive or edge hyphens", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, slug: "-acme" }).success).toBe(false);
    expect(CreateBusinessSchema.safeParse({ ...VALID, slug: "acme--hw" }).success).toBe(false);
  });

  it("rejects a slug over 63 characters", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, slug: "a".repeat(64) }).success).toBe(false);
  });

  it("uppercases a lowercase countryCode and accepts it (normalized, not rejected)", () => {
    const result = CreateBusinessSchema.safeParse({ ...VALID, countryCode: "gh", timezone: "Africa/Accra" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.countryCode).toBe("GH");
    }
  });

  it("rejects a country outside the launch catalog even though it is shape-valid (the 1Q-0A low finding: FR/CHF-style pairs)", () => {
    const result = CreateBusinessSchema.safeParse({ ...VALID, countryCode: "FR", timezone: "Europe/Paris" });
    expect(result.success).toBe(false);
  });

  it("has no currencyCode field at all — currency can never be client-submitted", () => {
    const result = CreateBusinessSchema.safeParse({ ...VALID, currencyCode: "CHF" });
    // The extra field is simply ignored by zod's default (non-strict)
    // parsing — it is never read into result.data, and there is no way
    // for a submitted currencyCode to influence server-derived currency.
    expect(result.success).toBe(true);
    if (result.success) {
      expect("currencyCode" in result.data).toBe(false);
    }
  });

  it("requires countryCode", () => {
    const withoutCountry: Record<string, string> = { ...VALID };
    delete withoutCountry.countryCode;
    expect(CreateBusinessSchema.safeParse(withoutCountry).success).toBe(false);
  });

  it("requires timezone", () => {
    const withoutTimezone: Record<string, string> = { ...VALID };
    delete withoutTimezone.timezone;
    expect(CreateBusinessSchema.safeParse(withoutTimezone).success).toBe(false);
  });

  it("rejects a timezone that isn't one of the country's own options (e.g. GB + America/Chicago)", () => {
    const result = CreateBusinessSchema.safeParse({ ...VALID, countryCode: "GB", timezone: "America/Chicago" });
    expect(result.success).toBe(false);
  });

  it("accepts each US timezone option", () => {
    for (const tz of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]) {
      expect(CreateBusinessSchema.safeParse({ ...VALID, countryCode: "US", timezone: tz }).success).toBe(true);
    }
  });

  it("rejects a malformed timezone string", () => {
    expect(CreateBusinessSchema.safeParse({ ...VALID, timezone: "Not/A/Zone" }).success).toBe(false);
  });
});

describe("CountryCodeSchema", () => {
  it("uppercases a valid 2-letter code", () => {
    expect(CountryCodeSchema.parse("ng")).toBe("NG");
  });

  it("rejects a currency symbol", () => {
    expect(CountryCodeSchema.safeParse("₦").success).toBe(false);
  });

  it("rejects a free-form country name", () => {
    expect(CountryCodeSchema.safeParse("Nigeria").success).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(CountryCodeSchema.safeParse("N").success).toBe(false);
    expect(CountryCodeSchema.safeParse("NGA").success).toBe(false);
  });
});

describe("CurrencyCodeSchema", () => {
  it("uppercases a valid 3-letter code", () => {
    expect(CurrencyCodeSchema.parse("ngn")).toBe("NGN");
  });

  it("rejects a currency symbol", () => {
    expect(CurrencyCodeSchema.safeParse("₦").success).toBe(false);
  });

  it("rejects a free-form currency name", () => {
    expect(CurrencyCodeSchema.safeParse("Naira").success).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(CurrencyCodeSchema.safeParse("NG").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("NGNX").success).toBe(false);
  });
});

describe("UpdateBusinessTimezoneSchema", () => {
  it("accepts a well-formed timezone string", () => {
    expect(UpdateBusinessTimezoneSchema.safeParse({ timezone: "Africa/Lagos" }).success).toBe(true);
  });

  it("rejects an empty timezone", () => {
    expect(UpdateBusinessTimezoneSchema.safeParse({ timezone: "" }).success).toBe(false);
  });
});
