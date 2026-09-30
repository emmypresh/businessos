import "server-only";
import type { ExternalProductCandidate, ProviderErrorCode } from "./types";

// Phase 1Q-C provider abstraction (phase instruction §4/§30/§32) — the
// app/UI never imports a provider-specific module or knows a provider's
// response schema. lib/products/lookup/providers/*.ts are the ONLY files
// permitted to know that shape; every one of them implements this
// interface and nothing else is exported from them.
//
// A result is always one of: a normalized candidate, `null` (genuinely
// not found), or a thrown ProductLookupProviderError (every other failure
// — timeout, rate limit, malformed response, network error — normalized
// into one of the three codes below, never a raw provider error).
export type ProductLookupProvider = {
  readonly name: string;
  lookupByIdentifier(
    normalizedIdentifier: string,
    signal: AbortSignal
  ): Promise<ExternalProductCandidate | null>;
};

export class ProductLookupProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProductLookupProviderError";
  }
}
