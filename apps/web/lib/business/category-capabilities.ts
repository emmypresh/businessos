// Phase 1Q-A capability foundation. A single, typed, deterministic map from
// a business category's stable `code` to a set of DEFAULT/HINT flags that
// future phases (1Q-B product identifiers, 1Q-G POS, industry packs) may
// read to pre-select sensible defaults.
//
// These flags are NEVER authorization, a subscription entitlement, or a
// tenant role — nothing in this codebase may gate a permission check, an
// RLS policy, or a feature flag on them. They exist purely so future code
// does not accumulate scattered `if (category === 'PHARMACY')` branches
// throughout the app (phase instruction §14/§15): every future phase reads
// this one table instead. No DB round trip is needed to resolve them once
// a category CODE is known (e.g. already loaded via getBusinessDetails).

export const CATEGORY_CODES = [
  "RETAIL",
  "WHOLESALE",
  "RESTAURANT",
  "FASHION",
  "PHARMACY",
  "ELECTRONICS",
  "GROCERY",
  "BEAUTY",
  "SERVICES",
  "LOGISTICS",
  "AUTO_PARTS",
  "GENERAL_TRADING",
  "MANUFACTURING",
  "OTHER",
] as const;

export type BusinessCategoryCode = (typeof CATEGORY_CODES)[number];

export type CategoryCapabilities = {
  /** This kind of business typically tracks stock-on-hand inventory. */
  inventoryExpected: boolean;
  /** Barcode scanning is a plausible future capability for this category. */
  barcodeRecommended: boolean;
  /** Products in this category commonly carry an expiry date. */
  expiryTrackingLikely: boolean;
  /** Products in this category commonly carry a unique serial number. */
  serialTrackingLikely: boolean;
  /** This kind of business commonly serves customers at tables. */
  tableServiceLikely: boolean;
  /** This kind of business commonly books appointments. */
  appointmentsLikely: boolean;
  /** This kind of business is typically service-only (no physical stock). */
  serviceOnlyLikely: boolean;
};

const DEFAULT_CAPABILITIES: CategoryCapabilities = {
  inventoryExpected: false,
  barcodeRecommended: false,
  expiryTrackingLikely: false,
  serialTrackingLikely: false,
  tableServiceLikely: false,
  appointmentsLikely: false,
  serviceOnlyLikely: false,
};

const CATEGORY_CAPABILITIES: Record<BusinessCategoryCode, CategoryCapabilities> = {
  RETAIL: { ...DEFAULT_CAPABILITIES, inventoryExpected: true, barcodeRecommended: true },
  WHOLESALE: { ...DEFAULT_CAPABILITIES, inventoryExpected: true, barcodeRecommended: true },
  RESTAURANT: {
    ...DEFAULT_CAPABILITIES,
    inventoryExpected: true,
    expiryTrackingLikely: true,
    tableServiceLikely: true,
  },
  FASHION: { ...DEFAULT_CAPABILITIES, inventoryExpected: true, barcodeRecommended: true },
  PHARMACY: {
    ...DEFAULT_CAPABILITIES,
    inventoryExpected: true,
    barcodeRecommended: true,
    expiryTrackingLikely: true,
  },
  ELECTRONICS: {
    ...DEFAULT_CAPABILITIES,
    inventoryExpected: true,
    barcodeRecommended: true,
    serialTrackingLikely: true,
  },
  GROCERY: {
    ...DEFAULT_CAPABILITIES,
    inventoryExpected: true,
    barcodeRecommended: true,
    expiryTrackingLikely: true,
  },
  BEAUTY: { ...DEFAULT_CAPABILITIES, appointmentsLikely: true, serviceOnlyLikely: true },
  SERVICES: { ...DEFAULT_CAPABILITIES, appointmentsLikely: true, serviceOnlyLikely: true },
  LOGISTICS: { ...DEFAULT_CAPABILITIES, serviceOnlyLikely: true },
  AUTO_PARTS: {
    ...DEFAULT_CAPABILITIES,
    inventoryExpected: true,
    barcodeRecommended: true,
    serialTrackingLikely: true,
  },
  GENERAL_TRADING: { ...DEFAULT_CAPABILITIES, inventoryExpected: true, barcodeRecommended: true },
  MANUFACTURING: { ...DEFAULT_CAPABILITIES, inventoryExpected: true, serialTrackingLikely: true },
  OTHER: DEFAULT_CAPABILITIES,
};

/**
 * Returns capability HINTS for a category code. An unrecognized code
 * (e.g. a future registry row this deployed code doesn't know about yet)
 * falls back to the same conservative all-false defaults as OTHER, never
 * throws — this must stay safe to call from rendering code.
 */
export function getCategoryCapabilities(code: string | null | undefined): CategoryCapabilities {
  if (code && Object.prototype.hasOwnProperty.call(CATEGORY_CAPABILITIES, code)) {
    return CATEGORY_CAPABILITIES[code as BusinessCategoryCode];
  }
  return DEFAULT_CAPABILITIES;
}
