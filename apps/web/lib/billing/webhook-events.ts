import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PAYSTACK_EVENT, isAllowedPaystackEvent } from "@/lib/billing/constants";

/**
 * Deterministic event-key derivation — per this round's own explicit
 * "do not invent random UUIDs for webhook idempotency" instruction, and
 * matching private.billing_provider_events' own header comment ("the
 * future app-layer webhook verifier is responsible for DERIVING a
 * deterministic key from whatever authoritative provider data/event
 * semantics actually guarantee uniqueness for a given event_type").
 * Every derivation below uses ONLY fields Paystack itself assigns
 * (transaction/invoice ids, subscription codes) — never anything a
 * client could influence, and never this application's own request
 * metadata (which a retried delivery would reproduce identically, but a
 * genuinely different lifecycle event for the same subscription would
 * not).
 *
 * The envelope schemas below are intentionally MINIMAL — they validate
 * only the fields this application actually reads, not Paystack's full
 * documented payload shape. `data` uses `.passthrough()` so unrecognized
 * fields never fail validation (Paystack is free to add fields; this
 * application only ever reads the ones it names).
 */

const ChargeSuccessDataSchema = z.object({
  id: z.union([z.number(), z.string()]),
  reference: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  paid_at: z.string().optional(),
  channel: z.string().optional(),
  customer: z.object({
    customer_code: z.string().optional(),
    email: z.string().optional(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SubscriptionCreateDataSchema = z.object({
  subscription_code: z.string().min(1),
  // Paystack's own per-subscription management token — required by its
  // Disable Subscription endpoint alongside the subscription code.
  // Bounded and optional: persisted only if actually present (APP-1L-02
  // — "Only if both are actually present in verified Paystack
  // subscription data"), never invented.
  email_token: z.string().max(500).optional(),
  customer: z
    .object({ customer_code: z.string().optional() })
    .optional(),
}).passthrough();

const InvoicePaymentFailedDataSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  invoice_code: z.string().optional(),
  created_at: z.string().optional(),
  customer: z
    .object({ customer_code: z.string().optional() })
    .optional(),
  subscription: z
    .object({ subscription_code: z.string().optional() })
    .optional(),
}).passthrough();

const SubscriptionDisableDataSchema = z.object({
  subscription_code: z.string().min(1),
  customer: z
    .object({ customer_code: z.string().optional() })
    .optional(),
}).passthrough();

// Every allowlisted event's OWN data schema, keyed by event type — an
// event NOT in this map is still accepted at the envelope level (the
// outer WebhookEnvelopeSchema below only requires `event`/`data` to
// exist at all) but is never passed to a per-event schema or handler.
export const PAYSTACK_EVENT_DATA_SCHEMA = {
  [PAYSTACK_EVENT.CHARGE_SUCCESS]: ChargeSuccessDataSchema,
  [PAYSTACK_EVENT.SUBSCRIPTION_CREATE]: SubscriptionCreateDataSchema,
  [PAYSTACK_EVENT.INVOICE_PAYMENT_FAILED]: InvoicePaymentFailedDataSchema,
  [PAYSTACK_EVENT.SUBSCRIPTION_DISABLE]: SubscriptionDisableDataSchema,
} as const;

// The OUTER envelope every Paystack webhook shares — validated BEFORE
// any per-event schema, so a malformed envelope (missing `event`, or a
// `data` that isn't even an object) is rejected uniformly, regardless of
// event type.
export const WebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

export function sha256Hex(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Returns null for any event type this application does not derive a
 * key for (including one that fails its own per-event schema) — the
 * caller (the webhook route) treats a null key as "acknowledge, do not
 * ingest, do not mutate", matching this round's own "unknown/malformed
 * event: acknowledge safely, no mutation, no crash loop" instruction.
 */
export function derivePaystackEventKey(eventType: string, data: Record<string, unknown>): string | null {
  if (!isAllowedPaystackEvent(eventType)) {
    return null;
  }

  switch (eventType) {
    case PAYSTACK_EVENT.CHARGE_SUCCESS: {
      const parsed = ChargeSuccessDataSchema.safeParse(data);
      if (!parsed.success) return null;
      // event_type + transaction reference + provider transaction id —
      // both Paystack-assigned, both stable across retries of the exact
      // same charge, and this combination is unique per real charge
      // (Paystack's own transaction id is globally unique).
      return `charge.success:${parsed.data.reference}:${parsed.data.id}`;
    }
    case PAYSTACK_EVENT.SUBSCRIPTION_CREATE: {
      const parsed = SubscriptionCreateDataSchema.safeParse(data);
      if (!parsed.success) return null;
      // subscription_code is assigned once, at creation, by Paystack —
      // a genuinely new subscription always gets a new code.
      return `subscription.create:${parsed.data.subscription_code}`;
    }
    case PAYSTACK_EVENT.INVOICE_PAYMENT_FAILED: {
      const parsed = InvoicePaymentFailedDataSchema.safeParse(data);
      if (!parsed.success) return null;
      const invoiceKey = parsed.data.invoice_code ?? parsed.data.id;
      if (!invoiceKey) return null;
      // Each failed invoice attempt is its own distinct Paystack invoice
      // object (a subsequent retry against the SAME invoice reuses the
      // SAME invoice_code/id — this is deliberately per-INVOICE, not
      // per-subscription, so two genuinely separate failed billing
      // cycles for the same subscription are two distinct events).
      return `invoice.payment_failed:${invoiceKey}`;
    }
    case PAYSTACK_EVENT.SUBSCRIPTION_DISABLE: {
      const parsed = SubscriptionDisableDataSchema.safeParse(data);
      if (!parsed.success) return null;
      // A given subscription can only be disabled once in a stable way
      // Paystack reports identically on redelivery — per-subscription is
      // the correct granularity here (unlike invoice.payment_failed).
      return `subscription.disable:${parsed.data.subscription_code}`;
    }
    default:
      return null;
  }
}
