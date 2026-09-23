import { z } from "zod";

// Client-side feedback only — create_business's own validation
// (supabase/migrations/20260909080100_create_business_country_currency.sql)
// remains the actual authority, including its uppercasing and its
// businesses_country_code_check/businesses_currency_code_check backstop.
// Mirrors lib/validation/branches.ts's BranchCountryCodeSchema exactly:
// rejects lowercase, symbols ("₦"), and free-form names ("Nigeria") — only
// a well-formed 2-letter ISO code passes.
export const CountryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, { error: "Enter a valid 2-letter ISO country code." });

// Same shape as CountryCodeSchema, for ISO 4217's 3-letter currency codes
// (e.g. "NGN", not "₦" or "Naira").
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { error: "Enter a valid 3-letter ISO currency code." });

// Not wired into the signup form in Phase 1Q-0A (onboarding UI is
// redesigned in 1Q-0B) — declared now, as optional, so create_business's
// forthcoming country/currency parameters have a validated shape to carry
// the moment a caller starts sending them, without a second schema change.
export const CreateBusinessSchema = z.object({
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
    // Existing Contract) still normalizes server-side regardless — this
    // schema's job is strict client-side feedback on what the user typed,
    // not silent coercion.
    .min(1, { error: "Slug is required." })
    .max(63, { error: "Slug must be 63 characters or fewer." })
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      error:
        "Slug can only contain lowercase letters, numbers, and single hyphens between them.",
    }),
  countryCode: CountryCodeSchema.optional(),
  currencyCode: CurrencyCodeSchema.optional(),
});

export type CreateBusinessInput = z.infer<typeof CreateBusinessSchema>;
