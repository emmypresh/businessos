/**
 * ALLOWLISTED resource_type -> route mapping — the ONLY mechanism a
 * notification's resource_type/resource_id may ever turn into a link.
 * Never constructs a URL from metadata or any other caller-influenced
 * free-text field; every entry here names a real, existing BusinessOS
 * route this application already ships, verified against the actual
 * `app/[businessId]/...` route tree, not guessed.
 *
 * `invoice_payment` (payment.recorded's own resource_type) is
 * deliberately ABSENT: resource_id there is the PAYMENT's own id, not
 * the invoice it belongs to, and no single-payment detail route exists
 * in this application — there is no safe existing route to link to, so
 * per this phase's own explicit instruction ("If no safe existing detail
 * route exists, render context without a link"), it renders as
 * unlinked context only (see components/notifications/notification-item.tsx).
 * `staff_invitation` links to the invitations LIST (no per-invitation
 * detail route exists either), which is still a genuinely useful,
 * reachable destination.
 */
export const RESOURCE_LINK_MAP: Record<string, (businessId: string, resourceId: string) => string> = {
  sale_return: (businessId, resourceId) => `/${businessId}/returns/${resourceId}`,
  expense: (businessId, resourceId) => `/${businessId}/expenses/${resourceId}`,
  branch: (businessId, resourceId) => `/${businessId}/branches/${resourceId}`,
  staff_invitation: (businessId) => `/${businessId}/staff/invitations`,
};

/** Returns a safe, allowlisted href for a notification's resource, or
 * `null` when no safe mapping exists (or resourceType/resourceId is
 * absent) — the caller must render unlinked context in that case, never
 * fall back to constructing a URL itself. */
export function resolveNotificationResourceLink(
  businessId: string,
  resourceType: string | null,
  resourceId: string | null
): string | null {
  if (!resourceType || !resourceId) return null;
  const build = RESOURCE_LINK_MAP[resourceType];
  return build ? build(businessId, resourceId) : null;
}
