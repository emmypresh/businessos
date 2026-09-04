import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TYPE_LABEL,
  normalizeNotificationTypeLabel,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_SEVERITY_LABEL,
  SUPPORTED_NOTIFICATION_TYPES,
} from "./constants";

describe("normalizeNotificationTypeLabel", () => {
  it.each(Object.entries(NOTIFICATION_TYPE_LABEL))("returns the known label for %s", (type, label) => {
    expect(normalizeNotificationTypeLabel(type)).toBe(label);
  });

  it("falls back to a title-cased rendering for an unrecognized type", () => {
    expect(normalizeNotificationTypeLabel("inventory.low_stock")).toBe("Inventory low stock");
  });

  it("never returns raw dot/underscore machine syntax", () => {
    const result = normalizeNotificationTypeLabel("some.unknown_type");
    expect(result).not.toContain(".");
    expect(result).not.toContain("_");
  });

  it("falls back to a safe default for a degenerate input", () => {
    expect(normalizeNotificationTypeLabel("...")).toBe("Notification");
  });
});

describe("SUPPORTED_NOTIFICATION_TYPES", () => {
  it("every supported type has a known label", () => {
    for (const type of SUPPORTED_NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPE_LABEL[type]).toBeDefined();
    }
  });
});

describe("category/severity labels", () => {
  it("every category has exactly one label", () => {
    expect(Object.keys(NOTIFICATION_CATEGORY_LABEL)).toHaveLength(7);
  });

  it("every severity has exactly one label", () => {
    expect(Object.keys(NOTIFICATION_SEVERITY_LABEL)).toHaveLength(4);
  });
});
