/**
 * Verified against the exact stored values, not assumed — see the check
 * constraint in supabase/migrations/20260825202824_create_business_members.sql
 * and the seed data in supabase/migrations/20260825202821_create_roles_permissions.sql.
 * Every comparison against business_members.status or roles.name in
 * application code goes through these constants, never a bare string
 * literal, so casing drift is a compile error, not a silent RLS-adjacent
 * bug.
 */
export const MEMBERSHIP_STATUS = {
  INVITED: "invited",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  REMOVED: "removed",
} as const;

export type MembershipStatus =
  (typeof MEMBERSHIP_STATUS)[keyof typeof MEMBERSHIP_STATUS];

export const ROLE_NAME = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  SALES: "SALES",
  INVENTORY: "INVENTORY",
  ACCOUNTANT: "ACCOUNTANT",
  VIEWER: "VIEWER",
} as const;

export type RoleName = (typeof ROLE_NAME)[keyof typeof ROLE_NAME];

/**
 * Verified against the exact seeded keys in
 * supabase/migrations/20260826080300_products_inventory_permissions.sql.
 * Every permission check in application code goes through these
 * constants and through `hasPermission`/`requirePermission` (dal.ts) —
 * never a bare string literal, and never a role-name comparison. Role
 * names describe *who* a member is; only these keys describe *what* they
 * may do, and that is the only thing application code is ever allowed to
 * branch on.
 */
export const PERMISSION = {
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_ADJUST: "inventory.adjust",
  INVENTORY_VIEW_COST: "inventory.view_cost",
  // Phase 1D. Verified against the exact seeded keys in
  // supabase/migrations/20260826090600_customers_sales_permissions.sql.
  // There is deliberately no CUSTOMERS_MANAGE ⇒ SALES_CREATE (or any
  // other) implication assumed anywhere in application code — each
  // permission is checked independently, even where the current seeded
  // role matrix happens to grant them together.
  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_MANAGE: "customers.manage",
  SALES_VIEW: "sales.view",
  SALES_CREATE: "sales.create",
  // Phase 1E. Verified against the exact seeded keys in
  // supabase/migrations/20260827080500_expenses_reports_permissions.sql.
  // expenses.manage does NOT imply expenses.view (a manage-only caller
  // may still read expense_categories, since that table's own SELECT
  // policy is granted on expenses.view OR expenses.manage, but NOT
  // public.expenses itself — see that migration's header comment), and
  // reports.view is independent of both expenses.view and sales.view —
  // never inferred from either.
  EXPENSES_VIEW: "expenses.view",
  EXPENSES_MANAGE: "expenses.manage",
  REPORTS_VIEW: "reports.view",
} as const;

export type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];
