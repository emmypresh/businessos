// @vitest-environment jsdom
// Phase 1Q-0D blocker remediation: notification-feed timestamps must render
// using the business's country-derived locale (lib/business/country-currency.ts's
// getLocaleForCountry), never a hardcoded "en-NG" — see notifications/page.tsx's
// own locale plumbing. Mirrors activity-feed.test.tsx's coverage.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationFeed } from "./notification-feed";
import type { NotificationRow } from "@/lib/notifications/dal";

const CREATED_AT = "2026-09-01T13:45:00Z";

function makeNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notification-a",
    business_id: "business-a",
    branch_id: null,
    category: "COMMERCE",
    notification_type: "payment.recorded",
    title: "Payment recorded",
    body: null,
    severity: "INFO",
    resource_type: null,
    resource_id: null,
    metadata: {},
    created_at: CREATED_AT,
    recipientId: "recipient-a",
    readAt: null,
    seenAt: null,
    ...overrides,
  } as NotificationRow;
}

describe("NotificationFeed timestamp locale", () => {
  afterEach(cleanup);

  it.each([
    ["NG", "en-NG"],
    ["GH", "en-GH"],
    ["GB", "en-GB"],
    ["US", "en-US"],
  ])("formats the notification timestamp using the %s business locale, not a hardcoded en-NG", (_country, locale) => {
    const expected = new Date(CREATED_AT).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    render(
      <NotificationFeed businessId="business-a" notifications={[makeNotification()]} locale={locale} />
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("defaults to en-US when no locale is provided", () => {
    const expected = new Date(CREATED_AT).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    render(<NotificationFeed businessId="business-a" notifications={[makeNotification()]} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
