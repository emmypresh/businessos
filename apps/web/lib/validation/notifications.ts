import { z } from "zod";
import { NOTIFICATION_CATEGORY, NOTIFICATION_SEVERITY } from "@/lib/notifications/constants";

/**
 * Client/DAL-side filter validation for the notification feed. The RLS
 * policies on public.notifications/notification_recipients (recipient-
 * targeting + active-membership gated — see the Phase 1K DB foundation)
 * remain the actual read-authority boundary; this schema only shapes/
 * bounds the filter inputs before they reach a query, mirroring
 * lib/validation/audit.ts's own identical pattern exactly.
 */

const CATEGORY_VALUES = [
  NOTIFICATION_CATEGORY.COMMERCE,
  NOTIFICATION_CATEGORY.INVENTORY,
  NOTIFICATION_CATEGORY.FINANCE,
  NOTIFICATION_CATEGORY.CUSTOMER,
  NOTIFICATION_CATEGORY.ORGANIZATION,
  NOTIFICATION_CATEGORY.SECURITY,
  NOTIFICATION_CATEGORY.SYSTEM,
] as const;

const SEVERITY_VALUES = [
  NOTIFICATION_SEVERITY.INFO,
  NOTIFICATION_SEVERITY.SUCCESS,
  NOTIFICATION_SEVERITY.WARNING,
  NOTIFICATION_SEVERITY.CRITICAL,
] as const;

export const NotificationFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
  severity: z.enum(SEVERITY_VALUES).optional(),
  // "unread" | "read" | undefined (both) — never a bare boolean string,
  // so an invalid value fails validation instead of silently coercing.
  readState: z.enum(["unread", "read"]).optional(),
});

export type NotificationFilterInput = z.infer<typeof NotificationFilterSchema>;

// Shared UUID identifier check for the notification feed's own
// businessId/notificationId route params — mirrors every other
// Phase 1C-1K domain's own IdSchema exactly.
export const IdSchema = z.uuid();

// updateNotificationPreferenceAction's own input shape — notification_type
// is regex-validated (matching the DB's own CHECK), never restricted to a
// fixed enum here either, for the identical extensibility reason as the
// DB foundation's own design.
export const UpdatePreferenceSchema = z.object({
  notificationType: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
    .max(100),
  inAppEnabled: z.boolean(),
});
