import { z } from "zod";
import { isSupportedCountryCode, getDefaultCurrencyForCountry } from "@/lib/business/country-currency";
import { isTimezoneValidForCountry } from "@/lib/business/timezone-catalog";

// Client-side feedback only -- create_business's own validation
// (supabase/migrations/20260923090100_create_business_timezone.sql)
// remains the actual authority, including its uppercasing and its
// businesses_country_code_check/currency_code_check/timezone_check
// backstop.
// Mirrors lib/validation/branches.ts's BranchCountryCodeSchema exactly:
// rejects lowercase, symbols, and free-form names ("Nigeria") -- only a
// well-formed 2-letter ISO code passes. NOTE on lowercase: this schema
// (and create_business itself) NORMALIZE lowercase input to uppercase via
// .toUpperCase() -- they do not reject it. Only genuinely malformed input
// (wrong length, non-letters, free-form names/symbols) is rejected. The
// browser onboarding form always submits the canonical uppercase form
// regardless (see components/onboarding/create-business-form.tsx); this
// normalization exists for any other caller of this schema.
export const CountryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, { error: "Enter a valid 2-letter ISO country code." });

// Same shape as CountryCodeSchema, for ISO 4217's 3-letter currency codes.
// Same lowercase-is-normalized-not-rejected note applies.
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { error: "Enter a valid 3-letter ISO currency code." });

// IANA timezone identifiers are case-sensitive by convention
// ("Africa/Lagos", never "africa/lagos" or "AFRICA/LAGOS") -- unlike the
// two codes above, this is NOT uppercased/normalized; a mismatched case
// is rejected outright, matching create_business's own timezone handling.
export const TimezoneSchema = z
  .string()
  .trim()
  .min(1, { error: "Select a timezone." })
  .max(100, { error: "Timezone is invalid." });

// Phase 1Q-0B: onboarding now collects country and timezone. Currency is
// deliberately NOT a client-submittable field at all -- it is always
// SERVER-DERIVED from countryCode (see lib/business/actions.ts), which is
// what closes the 1Q-0A low finding Codex found: a shape-valid but
// unsupported pair like country "FR" + currency "CHF" can no longer even
// be expressed by this schema, because there is no currencyCode field for
// a client to spoof. countryCode must additionally be a CATALOG member
// (isSupportedCountryCode), not merely shape-valid -- this is the
// application-boundary check the 1Q-0A brief flagged as missing (the
// database only ever enforced shape). timezone must be one of the
// country's own selectable options (isTimezoneValidForCountry) -- e.g. a
// GB submission of "America/Chicago" is rejected here, before
// create_business is ever called.
export const CreateBusinessSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, { error: "Business name must be at least 2 characters." })
      .max(150, { error: "Business name must be 150 characters or fewer." }),
    slug: z
      .string()
      .trim()
      // No .toLowerCase() here: it would silently normalize an uppercase slug
      // into a valid one before the regex below ever runs, defeating the
      // "reject uppercase" rule. The RPC's own private.normalize_slug (see
      // Existing Contract) still normalizes server-side regardless -- this
      // schema's job is strict client-side feedback on what the user typed,
      // not silent coercion.
      .min(1, { error: "Slug is required." })
      .max(63, { error: "Slug must be 63 characters or fewer." })
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
        error:
          "Slug can only contain lowercase letters, numbers, and single hyphens between them.",
      }),
    countryCode: CountryCodeSchema.refine(isSupportedCountryCode, {
      error: "Select a supported country.",
    }),
    timezone: TimezoneSchema,
  })
  .refine((value) => isTimezoneValidForCountry(value.countryCode, value.timezone), {
    error: "Select a timezone supported for this country.",
    path: ["timezone"],
  });

export type CreateBusinessInput = z.infer<typeof CreateBusinessSchema>;

// Business Settings (Phase 1Q-0B): the ONLY business field this phase
// makes editable post-creation. Reuses TimezoneSchema's shape check --
// the Server Action (lib/business/actions.ts updateBusinessTimezone) is
// the one that additionally re-validates against the CALLER'S OWN
// business's country (never a client-submitted country), matching
// businesses_timezone_check's table-level backstop.
export const UpdateBusinessTimezoneSchema = z.object({
  timezone: TimezoneSchema,
});

// Re-exported for callers (e.g. the onboarding form) that need to derive
// the currency a submission will result in, purely for DISPLAY -- never
// submitted back to the server as a field the client controls.
export { getDefaultCurrencyForCountry };
