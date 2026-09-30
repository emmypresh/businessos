// Phase 1Q-C — shared, framework-agnostic lookup types. No "server-only"
// import here (mirrors lib/products/identifiers.ts's own split): the
// result shape is rendered by client components, so it must be importable
// from both sides.

export const LOOKUP_STATE = {
  LOCAL_MATCH: "LOCAL_MATCH",
  EXTERNAL_MATCH: "EXTERNAL_MATCH",
  NOT_FOUND: "NOT_FOUND",
  INVALID: "INVALID",
  PROVIDER_ERROR: "PROVIDER_ERROR",
} as const;

export type LookupState = (typeof LOOKUP_STATE)[keyof typeof LOOKUP_STATE];

// Kept deliberately narrow (phase instruction §2): only what the create/
// edit form UI needs to render a local-match card and link to the
// existing product. Stock and cost are never included — a caller's own
// inventory.view_cost/inventory.view permissions are a separate concern
// this phase does not need to thread through the lookup surface.
export type LocalProductMatch = {
  productId: string;
  name: string;
  sku: string | null;
  status: string;
  sellingPrice: number | null;
};

// Provider-neutral candidate — every adapter (lib/products/lookup/
// providers/*) normalizes into exactly this shape, so the rest of the app
// never sees a provider-specific response schema (phase instruction §30).
export type ExternalProductCandidate = {
  identifier: string;
  identifierType: string;
  name: string;
  brand: string | null;
  description: string | null;
  imageUrl: string | null;
  categoryLabel: string | null;
  quantity: string | null;
  manufacturer: string | null;
  sourceProvider: string;
  sourceReference: string | null;
};

export type LookupResult =
  | { state: "LOCAL_MATCH"; identifierType: string; normalizedValue: string; product: LocalProductMatch }
  | { state: "EXTERNAL_MATCH"; identifierType: string; normalizedValue: string; candidate: ExternalProductCandidate }
  | { state: "NOT_FOUND"; identifierType: string; normalizedValue: string }
  | { state: "INVALID"; identifierType: string; normalizedValue: string }
  | { state: "PROVIDER_ERROR"; identifierType: string; normalizedValue: string; errorCode: ProviderErrorCode };

export const PROVIDER_ERROR_CODE = {
  PRODUCT_LOOKUP_TIMEOUT: "PRODUCT_LOOKUP_TIMEOUT",
  PRODUCT_LOOKUP_RATE_LIMITED: "PRODUCT_LOOKUP_RATE_LIMITED",
  PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE: "PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE",
  PRODUCT_LOOKUP_NOT_CONFIGURED: "PRODUCT_LOOKUP_NOT_CONFIGURED",
} as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODE)[keyof typeof PROVIDER_ERROR_CODE];
