import { describe, expect, it } from "vitest";
import {
  getCountryMetadata,
  getDefaultCurrencyForCountry,
  getLocaleForCountry,
  isSupportedCountryCode,
  isSupportedCurrencyCode,
  listSupportedCountries,
  SUPPORTED_COUNTRY_CODES,
} from "./country-currency";

describe("country-currency catalog", () => {
  it.each([
    ["NG", "NGN", "en-NG"],
    ["GH", "GHS", "en-GH"],
    ["KE", "KES", "en-KE"],
    ["ZA", "ZAR", "en-ZA"],
    ["GB", "GBP", "en-GB"],
    ["US", "USD", "en-US"],
  ])("maps %s -> %s with locale %s", (country, currency, locale) => {
    expect(getDefaultCurrencyForCountry(country)).toBe(currency);
    expect(getLocaleForCountry(country)).toBe(locale);
    expect(getCountryMetadata(country)?.defaultCurrency).toBe(currency);
  });

  it("lists every supported country exactly once", () => {
    const countries = listSupportedCountries();
    expect(countries).toHaveLength(SUPPORTED_COUNTRY_CODES.length);
    expect(new Set(countries.map((c) => c.countryCode)).size).toBe(countries.length);
  });

  it("returns undefined for a country outside the launch catalog", () => {
    expect(getCountryMetadata("FR")).toBeUndefined();
    expect(getDefaultCurrencyForCountry("FR")).toBeUndefined();
  });

  it("falls back to en-US locale for an unsupported country", () => {
    expect(getLocaleForCountry("FR")).toBe("en-US");
  });

  it("isSupportedCountryCode / isSupportedCurrencyCode are precise", () => {
    expect(isSupportedCountryCode("NG")).toBe(true);
    expect(isSupportedCountryCode("ng")).toBe(false);
    expect(isSupportedCountryCode("Nigeria")).toBe(false);
    expect(isSupportedCurrencyCode("NGN")).toBe(true);
    expect(isSupportedCurrencyCode("Naira")).toBe(false);
    // EUR is a supported *currency* for formatting even though it has no
    // launch country of its own in this phase's catalog.
    expect(isSupportedCurrencyCode("EUR")).toBe(true);
  });
});
