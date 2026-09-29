import { z } from "zod";

/**
 * Phase 1O-D — controlled platform action inputs. Bounds mirror the
 * corresponding RPC validation exactly
 * (supabase/migrations/20261001080000_platform_controlled_actions.sql) —
 * those RPCs remain the actual authority; this module exists so a
 * malformed form submission never reaches an RPC as raw input, and so the
 * form can render field-level errors before a round trip.
 */

export const PLATFORM_ACTION_REASON_MIN = 10;
export const PLATFORM_ACTION_REASON_MAX = 500;

const ReasonSchema = z
  .string()
  .trim()
  .min(PLATFORM_ACTION_REASON_MIN, `Enter a reason (${PLATFORM_ACTION_REASON_MIN}–${PLATFORM_ACTION_REASON_MAX} characters).`)
  .max(PLATFORM_ACTION_REASON_MAX, `Enter a reason (${PLATFORM_ACTION_REASON_MIN}–${PLATFORM_ACTION_REASON_MAX} characters).`);

// Matches the RPCs' own `^[A-Za-z0-9_-]{8,200}$` check exactly — generated
// server-side via randomUUID() (see lib/platform/actions.ts), never
// accepted as free-text client input in the mutation forms themselves.
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,200}$/);

export const SuspendBusinessSchema = z.object({
  businessId: z.uuid(),
  reason: ReasonSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const ReactivateBusinessSchema = z.object({
  businessId: z.uuid(),
  reason: ReasonSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const TRIAL_EXTENSION_MIN_DAYS = 1;
export const TRIAL_EXTENSION_MAX_DAYS = 30;

export const ExtendTrialSchema = z.object({
  businessId: z.uuid(),
  days: z.coerce
    .number()
    .int()
    .min(TRIAL_EXTENSION_MIN_DAYS, `Enter a number of days between ${TRIAL_EXTENSION_MIN_DAYS} and ${TRIAL_EXTENSION_MAX_DAYS}.`)
    .max(TRIAL_EXTENSION_MAX_DAYS, `Enter a number of days between ${TRIAL_EXTENSION_MIN_DAYS} and ${TRIAL_EXTENSION_MAX_DAYS}.`),
  reason: ReasonSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const PLATFORM_ACTION_TYPE = {
  SUSPEND_BUSINESS: "SUSPEND_BUSINESS",
  REACTIVATE_BUSINESS: "REACTIVATE_BUSINESS",
  EXTEND_TRIAL: "EXTEND_TRIAL",
} as const;

export const PLATFORM_ACTION_LABEL: Record<string, string> = {
  SUSPEND_BUSINESS: "Suspended business",
  REACTIVATE_BUSINESS: "Reactivated business",
  EXTEND_TRIAL: "Extended trial",
};
