/**
 * Platform (internal BusinessOS staff) authorization constants.
 *
 * Wholly separate from lib/business/constants.ts (tenant authorization):
 * platform roles/permissions have no relationship to tenant
 * ROLE_NAME/PERMISSION, and no tenant role (including OWNER/ADMIN) implies
 * any platform role. Verified against the exact seeded values in
 * supabase/migrations/20260928080000_platform_admin_security_foundation.sql.
 */
export const PLATFORM_ROLE = {
  SUPER_ADMIN: "SUPER_ADMIN",
  SUPPORT: "SUPPORT",
  OPERATIONS: "OPERATIONS",
  BILLING: "BILLING",
  VIEWER: "VIEWER",
} as const;

export type PlatformRole = (typeof PLATFORM_ROLE)[keyof typeof PLATFORM_ROLE];

/**
 * Every platform permission check in application code goes through these
 * constants and through requirePlatformPermission (lib/platform/dal.ts) —
 * never a bare string literal, and never a platform-role-name comparison.
 * 1O-A seeds *.view permissions only; mutation permissions
 * (platform.businesses.manage, platform.subscriptions.manage,
 * platform.support.manage, platform.admins.manage) are intentionally not
 * created yet.
 */
export const PLATFORM_PERMISSION = {
  DASHBOARD_VIEW: "platform.dashboard.view",
  BUSINESSES_VIEW: "platform.businesses.view",
  USERS_VIEW: "platform.users.view",
  SUBSCRIPTIONS_VIEW: "platform.subscriptions.view",
  AUDIT_VIEW: "platform.audit.view",
} as const;

export type PlatformPermissionKey =
  (typeof PLATFORM_PERMISSION)[keyof typeof PLATFORM_PERMISSION];
