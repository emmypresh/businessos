/**
 * Verified against the exact CHECK constraints in the frozen Phase 1L
 * DB foundation
 * (supabase/migrations/20260904080000_create_subscription_catalog.sql,
 * 20260904080100_create_business_subscriptions.sql,
 * 20260904080200_create_billing_history.sql) — not guessed.
 */

export const PLAN_CODE = {
  STARTER: "STARTER",
  GROWTH: "GROWTH",
  BUSINESS: "BUSINESS",
  ENTERPRISE: "ENTERPRISE",
} as const;

export type PlanCode = (typeof PLAN_CODE)[keyof typeof PLAN_CODE];

export const PLAN_LABEL: Record<PlanCode, string> = {
  STARTER: "Starter",
  GROWTH: "Growth",
  BUSINESS: "Business",
  ENTERPRISE: "Enterprise",
};

export const SUBSCRIPTION_STATUS = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
  INCOMPLETE: "INCOMPLETE",
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  CANCELED: "Canceled",
  EXPIRED: "Expired",
  INCOMPLETE: "Incomplete",
};

export const BILLING_PROVIDER = {
  PAYSTACK: "PAYSTACK",
  MANUAL: "MANUAL",
} as const;

export type BillingProvider = (typeof BILLING_PROVIDER)[keyof typeof BILLING_PROVIDER];

export const BILLING_INTERVAL = {
  MONTHLY: "MONTHLY",
  ANNUAL: "ANNUAL",
} as const;

export type BillingInterval = (typeof BILLING_INTERVAL)[keyof typeof BILLING_INTERVAL];

export const BILLING_INTERVAL_LABEL: Record<BillingInterval, string> = {
  MONTHLY: "Monthly",
  ANNUAL: "Annual",
};

// PAYSTACK_ENVIRONMENT itself moved to lib/billing/paystack-environment.ts
// — this round's own APP-1L remediation ("PAYSTACK_ENVIRONMENT fail
// closed") replaced the previous silent "anything but LIVE means TEST"
// default with an explicit parser that returns `null` (never a guessed
// environment) for anything unset/invalid. Import PAYSTACK_ENVIRONMENT
// from that module, not from here.

// Explicit allowlist — per this round's own "do not support every
// Paystack event blindly" instruction. Every other event type Paystack
// might ever send is acknowledged (2xx, signature already verified) but
// never mutates any subscription state and is never passed to any
// handler below.
//
// subscription.not_renew is DELIBERATELY DEFERRED, not implemented —
// per this round's own explicit "evaluate whether this event should be
// allowlisted now... do not overbuild" instruction. It carries no
// financial obligation of its own (Paystack sends it to announce a
// subscription simply won't be auto-charged on its next date), and
// mapping it correctly would require the identical provider-identity
// matching guard subscription.disable already needs — reasonable to add
// once a real product need for it materializes, not speculatively. Left
// off this allowlist, it is safely acknowledged (200, signature already
// verified, zero mutation, zero ingestion) exactly like any other
// unrecognized event — never a crash, never silently mis-mapped.
export const PAYSTACK_EVENT = {
  CHARGE_SUCCESS: "charge.success",
  SUBSCRIPTION_CREATE: "subscription.create",
  SUBSCRIPTION_DISABLE: "subscription.disable",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
} as const;

export type PaystackEventType = (typeof PAYSTACK_EVENT)[keyof typeof PAYSTACK_EVENT];

export const ALLOWED_PAYSTACK_EVENTS: readonly string[] = Object.values(PAYSTACK_EVENT);

export function isAllowedPaystackEvent(eventType: string): eventType is PaystackEventType {
  return (ALLOWED_PAYSTACK_EVENTS as string[]).includes(eventType);
}
