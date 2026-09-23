/**
 * Phase 1Q-0A country/currency catalog.
 *
 * BusinessOS's launch-country set. This is application configuration, not
 * authorization — country/currency must never be used as a role or
 * permission signal (see the phase brief). country_code drives the
 * DEFAULT currency for a new business (see
 * supabase/migrations/20260909080100_create_business_country_currency.sql's
 * private.default_currency_for_country, which mirrors this table); a
 * business's actual currency_code is stored independently and can, in a
 * later phase, diverge from its country's default.
 *
 * Adding a country here never requires a schema migration — the database
 * only enforces the *shape* of country_code/currency_code
 * (^[A-Z]{2}$ / ^[A-Z]{3}$), not a fixed enum.
 */

export const SUPPORTED_COUNTRY_CODES = ["NG", "GH", "KE", "ZA", "GB", "US"] as const;

export type CountryCode = (typeof SUPPORTED_COUNTRY_CODES)[number];

// EUR is supported at the formatter level (money can be formatted in EUR)
// but has no launch country of its own in this phase's catalog.
export const SUPPORTED_CURRENCY_CODES = [
  "NGN",
  "GHS",
  "KES",
  "ZAR",
  "GBP",
  "USD",
  "EUR",
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCY_CODES)[number];

export interface CountryMetadata {
  countryCode: CountryCode;
  countryName: string;
  defaultCurrency: CurrencyCode;
  locale: string;
}

// Order matches the phase spec's launch-country list.
const COUNTRY_CATALOG: Record<CountryCode, CountryMetadata> = {
  NG: { countryCode: "NG", countryName: "Nigeria", defaultCurrency: "NGN", locale: "en-NG" },
  GH: { countryCode: "GH", countryName: "Ghana", defaultCurrency: "GHS", locale: "en-GH" },
  KE: { countryCode: "KE", countryName: "Kenya", defaultCurrency: "KES", locale: "en-KE" },
  ZA: { countryCode: "ZA", countryName: "South Africa", defaultCurrency: "ZAR", locale: "en-ZA" },
  GB: { countryCode: "GB", countryName: "United Kingdom", defaultCurrency: "GBP", locale: "en-GB" },
  US: { countryCode: "US", countryName: "United States", defaultCurrency: "USD", locale: "en-US" },
};

export function isSupportedCountryCode(value: string): value is CountryCode {
  return (SUPPORTED_COUNTRY_CODES as readonly string[]).includes(value);
}

export function isSupportedCurrencyCode(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCY_CODES as readonly string[]).includes(value);
}

/** Returns undefined for a country not in the launch catalog — callers decide the fallback. */
export function getCountryMetadata(countryCode: string): CountryMetadata | undefined {
  return isSupportedCountryCode(countryCode) ? COUNTRY_CATALOG[countryCode] : undefined;
}

/** The country's default currency, or undefined if the country isn't in the launch catalog. */
export function getDefaultCurrencyForCountry(countryCode: string): CurrencyCode | undefined {
  return getCountryMetadata(countryCode)?.defaultCurrency;
}

/**
 * Display locale for a business's currency formatting. Deliberately driven
 * by business configuration (country), never the visiting browser's
 * locale — accounting/reporting output must be deterministic regardless of
 * who is viewing it. Falls back to "en-US" for a currency/country outside
 * the launch catalog rather than throwing, since formatting is a display
 * concern and should degrade gracefully.
 */
export function getLocaleForCountry(countryCode: string): string {
  return getCountryMetadata(countryCode)?.locale ?? "en-US";
}

export function listSupportedCountries(): CountryMetadata[] {
  return SUPPORTED_COUNTRY_CODES.map((code) => COUNTRY_CATALOG[code]);
}
