import { describe, expect, it } from "vitest";
import {
  getCountryMetadata,
  getCurrencyDisplayName,
  getDefaultCurrencyForCountry,
  getDefaultTimezoneForCountry,
  getLocaleForCountry,
  isFullyOperationalCountry,
  isSupportedCountryCode,
  isSupportedCurrencyCode,
  listSupportedCountries,
  SUPPORTED_COUNTRY_CODES,
} from "./country-currency";

describe("country-currency catalog", () => {
  it.each([
    ["NG", "NGN", "en-NG", "Africa/Lagos"],
    ["GH", "GHS", "en-GH", "Africa/Accra"],
    ["KE", "KES", "en-KE", "Africa/Nairobi"],
    ["ZA", "ZAR", "en-ZA", "Africa/Johannesburg"],
    ["GB", "GBP", "en-GB", "Europe/London"],
    ["US", "USD", "en-US", "America/New_York"],
  ])("maps %s -> %s with locale %s and default timezone %s", (country, currency, locale, timezone) => {
    expect(getDefaultCurrencyForCountry(country)).toBe(currency);
    expect(getLocaleForCountry(country)).toBe(locale);
    expect(getCountryMetadata(country)?.defaultCurrency).toBe(currency);
    expect(getDefaultTimezoneForCountry(country)).toBe(timezone);
  });

  it("only NG is a fully operational country pre-1Q-0C", () => {
    expect(isFullyOperationalCountry("NG")).toBe(true);
    for (const code of ["GH", "KE", "ZA", "GB", "US"]) {
      expect(isFullyOperationalCountry(code)).toBe(false);
    }
  });

  it("returns undefined default timezone for a country outside the launch catalog", () => {
    expect(getDefaultTimezoneForCountry("FR")).toBeUndefined();
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

  it.each([
    ["NGN", "Nigerian Naira (₦)"],
    ["GHS", "Ghanaian Cedi (GH₵)"],
    ["KES", "Kenyan Shilling (KSh)"],
    ["ZAR", "South African Rand (R)"],
    ["GBP", "British Pound (£)"],
    ["USD", "US Dollar ($)"],
  ])("getCurrencyDisplayName renders %s as %s", (code, expected) => {
    expect(getCurrencyDisplayName(code)).toBe(expected);
  });

  it("getCurrencyDisplayName falls back to the bare code outside the launch catalog", () => {
    expect(getCurrencyDisplayName("CHF")).toBe("CHF");
  });
});
