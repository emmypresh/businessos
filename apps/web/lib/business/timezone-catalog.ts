/**
 * Phase 1Q-0B timezone catalog.
 *
 * Kept in lockstep with the database allow-lists in
 * supabase/migrations/20260923090000_business_timezone.sql
 * (businesses_timezone_check) and
 * supabase/migrations/20260923090100_create_business_timezone.sql
 * (private.is_supported_timezone) — adding a launch timezone requires
 * updating all three.
 *
 * A business's timezone is stored independently of its country
 * (businesses.timezone, see the migration above) — country only supplies
 * a default at onboarding time. Most launch countries have exactly one
 * supported timezone; the United States has several, and this catalog is
 * the one place that decides which.
 */

import { SUPPORTED_COUNTRY_CODES, type CountryCode } from "./country-currency";

export const SUPPORTED_TIMEZONES = [
  "Africa/Lagos",
  "Africa/Accra",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export interface TimezoneOption {
  value: SupportedTimezone;
  label: string;
}

// Every launch country's selectable timezone(s), in onboarding display
// order. Five of the six countries have exactly one; the US has four,
// per the phase brief's explicit "do not assume every US business is
// New York" instruction.
const COUNTRY_TIMEZONE_OPTIONS: Record<CountryCode, TimezoneOption[]> = {
  NG: [{ value: "Africa/Lagos", label: "Lagos (WAT)" }],
  GH: [{ value: "Africa/Accra", label: "Accra (GMT)" }],
  KE: [{ value: "Africa/Nairobi", label: "Nairobi (EAT)" }],
  ZA: [{ value: "Africa/Johannesburg", label: "Johannesburg (SAST)" }],
  GB: [{ value: "Europe/London", label: "London (GMT/BST)" }],
  US: [
    { value: "America/New_York", label: "Eastern Time (New York)" },
    { value: "America/Chicago", label: "Central Time (Chicago)" },
    { value: "America/Denver", label: "Mountain Time (Denver)" },
    { value: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
  ],
};

export function isSupportedTimezone(value: string): value is SupportedTimezone {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(value);
}

/** Selectable timezone options for a country, ordered for onboarding display. Empty for a country outside the launch catalog. */
export function getTimezoneOptionsForCountry(countryCode: string): TimezoneOption[] {
  return (SUPPORTED_COUNTRY_CODES as readonly string[]).includes(countryCode)
    ? COUNTRY_TIMEZONE_OPTIONS[countryCode as CountryCode]
    : [];
}

/** Whether `timezone` is one of the countryCode's own selectable options — not just supported-timezone-in-general. Used to reject e.g. a GB business submitting America/Chicago. */
export function isTimezoneValidForCountry(countryCode: string, timezone: string): boolean {
  return getTimezoneOptionsForCountry(countryCode).some((option) => option.value === timezone);
}

export function listAllTimezoneOptions(): TimezoneOption[] {
  return SUPPORTED_COUNTRY_CODES.flatMap((code) => COUNTRY_TIMEZONE_OPTIONS[code]);
}
