import "server-only";
import { z } from "zod";
import type { ExternalProductCandidate } from "../types";
import { PROVIDER_ERROR_CODE } from "../types";
import { ProductLookupProviderError, type ProductLookupProvider } from "../provider";
import { ProductLookupConfigError, resolveOffBaseUrl } from "./off-base-url";

// Phase 1Q-C provider choice — Open Food Facts (world.openfoodfacts.org).
// Rationale, checked directly against the provider's own published terms
// (see apps/web/docs/phase-1q-c-free-product-lookup-build-brief.md
// "Provider research" section for the full writeup — not reproduced here
// to avoid two sources of truth drifting):
//   - free, no API key, no published rate limit for genuine per-scan use
//   - Open Database License (ODbL) 1.0: commercial use permitted,
//     attribution + share-alike on any REDISTRIBUTED derivative of the
//     data — flagged explicitly in the build brief as a caveat for any
//     future phase that might republish/export this data outside a
//     business's own private catalog, since that is a real, non-trivial
//     term this phase's own author is not certain is fully satisfied by
//     "one merchant applies a name/brand/image to their own product record"
//     (phase instruction §62: flagged rather than asserted with false
//     certainty)
//   - broad, growing product coverage (food, beverages, and, via the
//     merged Open Products/Open Beauty Facts data, general packaged
//     goods) — not exhaustive, but the best available free/open option
//     without a commercial subscription
//
// SSRF posture (phase instruction §35): the outbound host is resolved by
// resolveOffBaseUrl (./off-base-url.ts) on every call and is validated
// against an exact-host allowlist — https://world.openfoodfacts.org in
// production, loopback only when explicitly opted in for e2e. Anything else
// fails closed with PRODUCT_LOOKUP_NOT_CONFIGURED; it is never derived from
// p_raw_value or any request input, and never silently falls back.
const TIMEOUT_MS = 6_000;
const REQUEST_FIELDS = "product_name,brands,categories,quantity,image_url,code";

const OffResponseSchema = z.object({
  status: z.union([z.literal(0), z.literal(1)]),
  product: z
    .object({
      product_name: z.string().trim().max(300).optional(),
      brands: z.string().trim().max(300).optional(),
      categories: z.string().trim().max(500).optional(),
      quantity: z.string().trim().max(100).optional(),
      image_url: z.string().trim().max(2000).optional(),
      code: z.string().trim().max(64).optional(),
    })
    .optional(),
});

// Provider-supplied strings are untrusted input (phase instruction §20):
// truncated defensively even though the Zod schema above already caps
// length, and never rendered as HTML anywhere downstream (the UI layer
// treats every field as plain text).
function safeText(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

// Only an https:// (or, defensively, http://) URL is ever passed through
// — never a javascript:/data: URL a malicious or malformed response body
// could otherwise smuggle into an <img src> (phase instruction §21/§36).
function safeImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

// firstOf("a, b, c") -> "a" — Open Food Facts' own brands/categories
// fields are free-text, comma-joined lists; only the first, most specific
// entry is surfaced (phase instruction §4's "keep this minimal").
function firstOf(value: string | null): string | null {
  if (!value) return null;
  const [first] = value.split(",");
  return first?.trim() || null;
}

export const openFoodFactsProvider: ProductLookupProvider = {
  name: "open_food_facts",

  async lookupByIdentifier(normalizedIdentifier, signal) {
    // Only a digit-only, plausible barcode is ever sent — enforced by the
    // caller (lib/products/lookup/dal.ts only invokes a provider for a
    // check-digit-valid GS1 code), re-asserted here as a second gate so
    // this adapter can never be reached with arbitrary caller-controlled
    // path segments even if that caller-side gate ever regresses.
    if (!/^[0-9]{8,14}$/.test(normalizedIdentifier)) {
      throw new ProductLookupProviderError(
        PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE,
        "Refusing to query the provider with a non-barcode identifier."
      );
    }

    let baseUrl: string;
    try {
      baseUrl = resolveOffBaseUrl();
    } catch (err) {
      if (err instanceof ProductLookupConfigError) {
        // Reason never contains the configured value (may hold credentials).
        console.error(`[product-lookup] ${err.message}`);
        throw new ProductLookupProviderError(
          PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_NOT_CONFIGURED,
          "Product lookup provider is not configured."
        );
      }
      throw err;
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
    const onCallerAbort = () => timeoutController.abort();
    signal.addEventListener("abort", onCallerAbort);

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/api/v2/product/${encodeURIComponent(normalizedIdentifier)}.json?fields=${REQUEST_FIELDS}`,
        {
          signal: timeoutController.signal,
          // An allowlisted host must not be able to bounce the request to
          // another one; any redirect is treated as a provider failure.
          redirect: "error",
          headers: { "User-Agent": "BusinessOS-ProductLookup/1.0 (contact: support@businessos.app)" },
        }
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProductLookupProviderError(
          PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_TIMEOUT,
          "Open Food Facts request timed out."
        );
      }
      throw new ProductLookupProviderError(
        PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE,
        "Open Food Facts request failed."
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onCallerAbort);
    }

    if (response.status === 429) {
      throw new ProductLookupProviderError(
        PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_RATE_LIMITED,
        "Open Food Facts rate-limited this request."
      );
    }
    if (response.status >= 500) {
      throw new ProductLookupProviderError(
        PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE,
        `Open Food Facts returned ${response.status}.`
      );
    }
    if (!response.ok) {
      // A non-2xx, non-429/5xx status (e.g. 404) from this endpoint is
      // never actually emitted by Open Food Facts for an unknown barcode
      // — it returns 200 with status: 0 instead — but this is handled
      // defensively rather than assumed.
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProductLookupProviderError(
        PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE,
        "Open Food Facts returned malformed JSON."
      );
    }

    const parsed = OffResponseSchema.safeParse(json);
    if (!parsed.success || parsed.data.status === 0 || !parsed.data.product) {
      return null;
    }

    const p = parsed.data.product;
    const name = safeText(p.product_name, 300);
    if (!name) {
      // No usable name is treated the same as "not found" — never a
      // candidate card with a blank/placeholder title (phase instruction
      // §20's "validate lengths" extends to "validate presence" for the
      // one field the UI cannot render without).
      return null;
    }

    const candidate: ExternalProductCandidate = {
      identifier: normalizedIdentifier,
      identifierType: "GTIN",
      name,
      brand: firstOf(safeText(p.brands, 300)),
      description: null,
      imageUrl: safeImageUrl(p.image_url),
      categoryLabel: firstOf(safeText(p.categories, 500)),
      quantity: safeText(p.quantity, 100),
      manufacturer: null,
      sourceProvider: "open_food_facts",
      sourceReference: safeText(p.code, 64) ?? normalizedIdentifier,
    };
    return candidate;
  },
};
