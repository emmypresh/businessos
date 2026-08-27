export const CUSTOMER_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  ARCHIVED: "archived",
} as const;

export type CustomerStatus = (typeof CUSTOMER_STATUS)[keyof typeof CUSTOMER_STATUS];

export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  [CUSTOMER_STATUS.ACTIVE]: "Active",
  [CUSTOMER_STATUS.INACTIVE]: "Inactive",
  [CUSTOMER_STATUS.ARCHIVED]: "Archived",
};
