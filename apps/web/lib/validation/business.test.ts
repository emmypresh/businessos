import { describe, expect, it } from "vitest";
import { CountryCodeSchema, CreateBusinessSchema, CurrencyCodeSchema } from "./business";

describe("CreateBusinessSchema", () => {
  it("accepts a valid name and slug", () => {
    const result = CreateBusinessSchema.safeParse({
      name: "Acme Hardware",
      slug: "acme-hardware",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({ name: "A", slug: "a" }).success
    ).toBe(false);
  });

  it("rejects a name longer than 150 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "A".repeat(151),
        slug: "a".repeat(10),
      }).success
    ).toBe(false);
  });

  it("rejects a slug with uppercase letters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "Acme",
        slug: "Acme-Hardware",
      }).success
    ).toBe(false);
  });

  it("rejects a slug with consecutive or edge hyphens", () => {
    expect(
      CreateBusinessSchema.safeParse({ name: "Acme", slug: "-acme" }).success
    ).toBe(false);
    expect(
      CreateBusinessSchema.safeParse({ name: "Acme", slug: "acme--hw" })
        .success
    ).toBe(false);
  });

  it("rejects a slug over 63 characters", () => {
    expect(
      CreateBusinessSchema.safeParse({
        name: "Acme",
        slug: "a".repeat(64),
      }).success
    ).toBe(false);
  });

  it("accepts a valid optional countryCode/currencyCode pair", () => {
    const result = CreateBusinessSchema.safeParse({
      name: "Acme Hardware",
      slug: "acme-hardware",
      countryCode: "gh",
      currencyCode: "ghs",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.countryCode).toBe("GH");
      expect(result.data.currencyCode).toBe("GHS");
    }
  });

  it("still accepts a request with no countryCode/currencyCode at all", () => {
    expect(
      CreateBusinessSchema.safeParse({ name: "Acme", slug: "acme" }).success
    ).toBe(true);
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
