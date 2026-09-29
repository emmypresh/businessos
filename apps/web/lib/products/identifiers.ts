// Shared, framework-agnostic identifier constants — importable from both
// server code (DAL/actions) and client components ("use client" files
// cannot import from a "server-only" module), mirroring
// lib/products/constants.ts's own identical split for PRODUCT_STATUS.

export const IDENTIFIER_TYPE = {
  GTIN: "GTIN",
  UPC_A: "UPC_A",
  EAN_13: "EAN_13",
  EAN_8: "EAN_8",
  OTHER: "OTHER",
} as const;

export type IdentifierType = (typeof IDENTIFIER_TYPE)[keyof typeof IDENTIFIER_TYPE];

export const IDENTIFIER_TYPE_LABEL: Record<IdentifierType, string> = {
  GTIN: "GTIN",
  UPC_A: "UPC-A",
  EAN_13: "EAN-13",
  EAN_8: "EAN-8",
  OTHER: "Other",
};

export const SKU_MODE = {
  SMART_AUTO: "SMART_AUTO",
  SIMPLE_SEQUENTIAL: "SIMPLE_SEQUENTIAL",
  MANUAL: "MANUAL",
} as const;

export type SkuMode = (typeof SKU_MODE)[keyof typeof SKU_MODE];
