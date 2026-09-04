import { describe, expect, it } from "vitest";
import { NotificationFilterSchema, IdSchema, UpdatePreferenceSchema } from "./notifications";

describe("NotificationFilterSchema", () => {
  it("accepts an empty filter (all optional)", () => {
    expect(NotificationFilterSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a well-formed filter", () => {
    const result = NotificationFilterSchema.safeParse({
      search: "invoice",
      category: "FINANCE",
      severity: "WARNING",
      readState: "unread",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognized category", () => {
    expect(NotificationFilterSchema.safeParse({ category: "BOGUS" }).success).toBe(false);
  });

  it("rejects an unrecognized severity", () => {
    expect(NotificationFilterSchema.safeParse({ severity: "URGENT" }).success).toBe(false);
  });

  it("rejects an unrecognized readState", () => {
    expect(NotificationFilterSchema.safeParse({ readState: "archived" }).success).toBe(false);
  });

  it("rejects a search string over 200 characters", () => {
    expect(NotificationFilterSchema.safeParse({ search: "a".repeat(201) }).success).toBe(false);
  });

  it("trims a search string", () => {
    const result = NotificationFilterSchema.safeParse({ search: "  invoice  " });
    expect(result.success && result.data.search).toBe("invoice");
  });
});

describe("IdSchema", () => {
  it("accepts a well-formed uuid", () => {
    expect(IdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });

  it.each(["not-a-uuid", "", "12345", "  "])("rejects %s", (value) => {
    expect(IdSchema.safeParse(value).success).toBe(false);
  });
});

describe("UpdatePreferenceSchema", () => {
  it("accepts a well-formed input", () => {
    const result = UpdatePreferenceSchema.safeParse({ notificationType: "expense.posted", inAppEnabled: false });
    expect(result.success).toBe(true);
  });

  it.each(["ExpensePosted", "expense", "expense_posted", "1expense.posted", ""])(
    "rejects a malformed notificationType: %s",
    (value) => {
      expect(UpdatePreferenceSchema.safeParse({ notificationType: value, inAppEnabled: true }).success).toBe(false);
    }
  );

  it("rejects a notificationType over 100 characters", () => {
    const longType = "a." + "b".repeat(100);
    expect(UpdatePreferenceSchema.safeParse({ notificationType: longType, inAppEnabled: true }).success).toBe(false);
  });

  it("rejects a non-boolean inAppEnabled", () => {
    expect(
      UpdatePreferenceSchema.safeParse({ notificationType: "expense.posted", inAppEnabled: "true" }).success
    ).toBe(false);
  });
});
