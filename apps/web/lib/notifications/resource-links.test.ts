import { describe, expect, it } from "vitest";
import { resolveNotificationResourceLink } from "./resource-links";

const businessId = "b1111111-1111-1111-1111-111111111111";
const resourceId = "c2222222-2222-2222-2222-222222222222";

describe("resolveNotificationResourceLink", () => {
  it("returns null when resourceType is null", () => {
    expect(resolveNotificationResourceLink(businessId, null, resourceId)).toBeNull();
  });

  it("returns null when resourceId is null", () => {
    expect(resolveNotificationResourceLink(businessId, "sale_return", null)).toBeNull();
  });

  it("returns null for an unrecognized resourceType (never fabricates a URL)", () => {
    expect(resolveNotificationResourceLink(businessId, "totally_unknown_type", resourceId)).toBeNull();
  });

  // invoice_payment is the ONE payment.recorded resource_type this round
  // produces, and it is deliberately ABSENT from the allowlist — no
  // single-payment detail route exists (resource_id is the payment's own
  // id, not the invoice's) — see lib/notifications/resource-links.ts's
  // own header comment for the full rationale.
  it("returns null for invoice_payment (no safe existing detail route)", () => {
    expect(resolveNotificationResourceLink(businessId, "invoice_payment", resourceId)).toBeNull();
  });

  it("maps sale_return to the returns detail route", () => {
    expect(resolveNotificationResourceLink(businessId, "sale_return", resourceId)).toBe(
      `/${businessId}/returns/${resourceId}`
    );
  });

  it("maps expense to the expense detail route", () => {
    expect(resolveNotificationResourceLink(businessId, "expense", resourceId)).toBe(
      `/${businessId}/expenses/${resourceId}`
    );
  });

  it("maps branch to the branch detail route", () => {
    expect(resolveNotificationResourceLink(businessId, "branch", resourceId)).toBe(
      `/${businessId}/branches/${resourceId}`
    );
  });

  it("maps staff_invitation to the invitations LIST route (no per-invitation detail route exists)", () => {
    expect(resolveNotificationResourceLink(businessId, "staff_invitation", resourceId)).toBe(
      `/${businessId}/staff/invitations`
    );
  });

  it("never constructs a URL containing anything beyond businessId/resourceId — no metadata is ever consulted", () => {
    const href = resolveNotificationResourceLink(businessId, "expense", resourceId);
    expect(href).toMatch(/^\/[0-9a-f-]+\/expenses\/[0-9a-f-]+$/);
  });
});
