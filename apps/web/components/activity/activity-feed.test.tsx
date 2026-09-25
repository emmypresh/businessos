// @vitest-environment jsdom
// Phase 1Q-0D blocker remediation: activity-feed timestamps must render
// using the business's country-derived locale (lib/business/country-currency.ts's
// getLocaleForCountry), never a hardcoded "en-NG" — see activity/page.tsx's
// own locale plumbing.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityFeed } from "./activity-feed";
import type { ActivityEventRow } from "@/lib/audit/dal";

const CREATED_AT = "2026-09-01T13:45:00Z";

function makeEvent(overrides: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    id: "event-a",
    business_id: "business-a",
    branch_id: null,
    actor_type: "USER",
    actor_user_id: "user-a",
    actor_email_snapshot: "owner@example.com",
    actor_name_snapshot: "Ada Owner",
    action: "sale.created",
    category: "COMMERCE",
    resource_type: null,
    resource_id: null,
    resource_label_snapshot: null,
    outcome: "SUCCESS",
    metadata: {},
    created_at: CREATED_AT,
    ...overrides,
  } as ActivityEventRow;
}

describe("ActivityFeed timestamp locale", () => {
  afterEach(cleanup);

  it.each([
    ["NG", "en-NG"],
    ["GH", "en-GH"],
    ["GB", "en-GB"],
    ["US", "en-US"],
  ])("formats the event timestamp using the %s business locale, not a hardcoded en-NG", (_country, locale) => {
    const expected = new Date(CREATED_AT).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    render(<ActivityFeed events={[makeEvent()]} branchNames={{}} locale={locale} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("defaults to en-US when no locale is provided", () => {
    const expected = new Date(CREATED_AT).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    render(<ActivityFeed events={[makeEvent()]} branchNames={{}} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
