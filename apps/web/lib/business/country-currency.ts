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
  /**
   * Phase 1Q-0B. An onboarding-UX starting point, never an authoritative
   * derivation — country != timezone. Most launch countries have exactly
   * one supported timezone, so this doubles as "the" value for them, but
   * for US it is only ONE of several the onboarding UI must let the user
   * choose among (see lib/business/timezone-catalog.ts); it must never be
   * silently treated as universally correct the way it safely can be for
   * the other five.
   */
  defaultTimezone: string;
}

// Order matches the phase spec's launch-country list.
const COUNTRY_CATALOG: Record<CountryCode, CountryMetadata> = {
  NG: { countryCode: "NG", countryName: "Nigeria", defaultCurrency: "NGN", locale: "en-NG", defaultTimezone: "Africa/Lagos" },
  GH: { countryCode: "GH", countryName: "Ghana", defaultCurrency: "GHS", locale: "en-GH", defaultTimezone: "Africa/Accra" },
  KE: { countryCode: "KE", countryName: "Kenya", defaultCurrency: "KES", locale: "en-KE", defaultTimezone: "Africa/Nairobi" },
  ZA: { countryCode: "ZA", countryName: "South Africa", defaultCurrency: "ZAR", locale: "en-ZA", defaultTimezone: "Africa/Johannesburg" },
  GB: { countryCode: "GB", countryName: "United Kingdom", defaultCurrency: "GBP", locale: "en-GB", defaultTimezone: "Europe/London" },
  US: { countryCode: "US", countryName: "United States", defaultCurrency: "USD", locale: "en-US", defaultTimezone: "America/New_York" },
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

/**
 * Phase 1Q-0B-0B (Codex remediation, LOW finding: onboarding/settings
 * showed only the bare ISO code, e.g. "NGN"). Presentation-only — the
 * stored/transmitted identity remains the ISO currency_code everywhere
 * else in the app; this table exists purely to render a human-readable
 * name and symbol next to it. Limited to the six launch currencies (not
 * the wider SUPPORTED_CURRENCY_CODES list, which also includes EUR for
 * formatting purposes only) since those are the only currencies a
 * business can actually be created with today.
 */
const CURRENCY_DISPLAY: Record<CurrencyCode, { name: string; symbol: string }> = {
  NGN: { name: "Nigerian Naira", symbol: "₦" },
  GHS: { name: "Ghanaian Cedi", symbol: "GH₵" },
  KES: { name: "Kenyan Shilling", symbol: "KSh" },
  ZAR: { name: "South African Rand", symbol: "R" },
  GBP: { name: "British Pound", symbol: "£" },
  USD: { name: "US Dollar", symbol: "$" },
  EUR: { name: "Euro", symbol: "€" },
};

/**
 * "Nigerian Naira (₦)" for a launch currency; falls back to the bare code
 * for anything outside CURRENCY_DISPLAY rather than throwing, since this
 * is a display concern and should degrade gracefully — mirrors
 * getLocaleForCountry's own fallback posture.
 */
export function getCurrencyDisplayName(currencyCode: string): string {
  const display = isSupportedCurrencyCode(currencyCode) ? CURRENCY_DISPLAY[currencyCode] : undefined;
  return display ? `${display.name} (${display.symbol})` : currencyCode;
}

/** The country's onboarding-default timezone, or undefined outside the launch catalog. See CountryMetadata.defaultTimezone. */
export function getDefaultTimezoneForCountry(countryCode: string): string | undefined {
  return getCountryMetadata(countryCode)?.defaultTimezone;
}

/**
 * Phase 1Q-0B activation gate. Only NG/NGN businesses may proceed into
 * full operational use today — expenses, invoices, and reporting remain
 * NGN-oriented until Phase 1Q-0C. This is deliberately a single, narrow,
 * named predicate (never inlined as `countryCode === "NG"` at each call
 * site) so the one product rule it expresses can be found, reasoned
 * about, and later relaxed in exactly one place.
 */
export function isFullyOperationalCountry(countryCode: string): boolean {
  return countryCode === "NG";
}
