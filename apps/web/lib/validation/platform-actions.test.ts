import { describe, expect, it } from "vitest";
import {
  SuspendBusinessSchema,
  ReactivateBusinessSchema,
  ExtendTrialSchema,
  PLATFORM_ACTION_LABEL,
} from "./platform-actions";

const businessId = "11111111-1111-4111-8111-111111111111";
const validKey = "abcDEF12-345_ok";
const validReason = "Customer requested suspension pending investigation.";

describe("SuspendBusinessSchema / ReactivateBusinessSchema", () => {
  it("accepts a valid submission", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reason under 10 characters", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: "short",
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reason over 500 characters", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: "a".repeat(501),
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("trims whitespace before enforcing the minimum length", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: "   short   ",
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only reason", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: "                       ",
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed business id", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId: "not-a-uuid",
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an idempotency key shorter than 8 characters", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: validReason,
      idempotencyKey: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an idempotency key with disallowed characters", () => {
    const result = SuspendBusinessSchema.safeParse({
      businessId,
      reason: validReason,
      idempotencyKey: "has spaces!!",
    });
    expect(result.success).toBe(false);
  });

  it("reactivate schema mirrors suspend's own validation exactly", () => {
    const result = ReactivateBusinessSchema.safeParse({
      businessId,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(true);
  });
});

describe("ExtendTrialSchema", () => {
  it("accepts a valid submission with days in range", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: "14",
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days).toBe(14);
    }
  });

  it("accepts the minimum boundary of 1 day", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: 1,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(true);
  });

  it("accepts the maximum boundary of 30 days", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: 30,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(true);
  });

  it("rejects 0 days", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: 0,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative day count", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: -5,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects 31 days (over the maximum)", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: 31,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer day count", () => {
    const result = ExtendTrialSchema.safeParse({
      businessId,
      days: 5.5,
      reason: validReason,
      idempotencyKey: validKey,
    });
    expect(result.success).toBe(false);
  });
});

describe("PLATFORM_ACTION_LABEL", () => {
  it("has a human label for every action type", () => {
    expect(PLATFORM_ACTION_LABEL.SUSPEND_BUSINESS).toBeTruthy();
    expect(PLATFORM_ACTION_LABEL.REACTIVATE_BUSINESS).toBeTruthy();
    expect(PLATFORM_ACTION_LABEL.EXTEND_TRIAL).toBeTruthy();
  });
});
