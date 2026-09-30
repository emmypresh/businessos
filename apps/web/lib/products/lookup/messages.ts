import type { LookupResult } from "./types";

// Phase 1Q-C §16: normalized, safe, static copy — never a raw provider
// error, stack trace, or response body (no lookup path in this app ever
// interpolates provider text into user-facing copy). Client-importable
// (no "server-only"): the result card renders this directly.
export function describeLookupResult(result: LookupResult): string {
  switch (result.state) {
    case "NOT_FOUND":
      return "No product information found. You can continue entering the product manually.";
    case "INVALID":
      return "Enter a valid barcode or code.";
    case "PROVIDER_ERROR":
      switch (result.errorCode) {
        case "PRODUCT_LOOKUP_TIMEOUT":
          return "The product lookup timed out. You can continue entering the product manually.";
        case "PRODUCT_LOOKUP_RATE_LIMITED":
          return "Product lookup is temporarily rate-limited. You can continue entering the product manually.";
        case "PRODUCT_LOOKUP_NOT_CONFIGURED":
          return "Product lookup isn't available right now. You can continue entering the product manually.";
        case "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE":
        default:
          return "Product lookup is temporarily unavailable. You can continue entering the product manually.";
      }
    default:
      return "";
  }
}
