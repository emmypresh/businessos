export const PRODUCT_STATUS = {
  ACTIVE: "active",
  ARCHIVED: "archived",
} as const;

export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];
