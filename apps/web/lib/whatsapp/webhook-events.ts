import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Meta WhatsApp Cloud API webhook envelope/event schemas — verified
 * against Meta's own documented Webhooks payload shape (object =
 * "whatsapp_business_account", entry[].changes[].field/value). Every
 * schema below uses `.passthrough()` so an unrecognized field never
 * fails validation (Meta is free to add fields; this application only
 * ever reads the ones it names) — mirrors
 * lib/billing/webhook-events.ts's own identical minimal-schema
 * convention exactly.
 *
 * ONLY `field === "messages"` changes are processed in this MVP round
 * (inbound messages + outbound status updates travel together under
 * this one field in Meta's own schema) — every other valid field
 * (e.g. "message_template_status_update", "account_update") is
 * acknowledged safely with zero authoritative mutation, per this
 * phase's own explicit "unknown valid signed events: acknowledge
 * safely, zero mutation" instruction.
 */

export const WebhookEnvelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string().min(1),
      changes: z.array(
        z.object({
          field: z.string().min(1),
          value: z.record(z.string(), z.unknown()),
        }).passthrough()
      ),
    }).passthrough()
  ),
}).passthrough();

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

const MessagesFieldValueSchema = z.object({
  messaging_product: z.literal("whatsapp").optional(),
  metadata: z.object({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string().min(1),
  }).passthrough().optional(),
  messages: z.array(
    z.object({
      from: z.string().min(1),
      id: z.string().min(1),
      timestamp: z.string().min(1),
      type: z.string().min(1),
      text: z.object({ body: z.string().optional() }).passthrough().optional(),
    }).passthrough()
  ).optional(),
  statuses: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      timestamp: z.string().min(1),
      recipient_id: z.string().optional(),
      errors: z.array(z.object({ code: z.union([z.number(), z.string()]).optional(), title: z.string().optional() }).passthrough()).optional(),
      // WA-APP-02-R1: Meta's own opaque-tracking echo — see
      // lib/whatsapp/meta-client.ts's own header comment. Bounded (Meta's
      // own documented 512-character max) and never trusted as anything
      // beyond a correlation lookup key — see
      // ingest_and_process_whatsapp_status_event's own tenant/conflict
      // checks (20260908080200_whatsapp_outbound_provider_correlation.sql).
      biz_opaque_callback_data: z.string().max(512).optional(),
    }).passthrough()
  ).optional(),
}).passthrough();

export type MessagesFieldValue = z.infer<typeof MessagesFieldValueSchema>;

export function parseMessagesFieldValue(value: unknown): MessagesFieldValue | null {
  const parsed = MessagesFieldValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function sha256Hex(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

const SUPPORTED_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

export function isSupportedStatus(status: string): boolean {
  return SUPPORTED_STATUSES.has(status);
}

/**
 * Deterministic, type-prefixed event-key derivation — per this round's
 * own explicit "same provider retry -> same key; different lifecycle
 * event -> never collide; never a raw-payload-hash-alone key"
 * instructions. Every derivation uses ONLY fields Meta itself assigns
 * (its own wamid, its own status string, its own timestamp) — never
 * anything a client could influence.
 */
export function deriveInboundMessageEventKey(providerMessageId: string): string {
  return `message.inbound:${providerMessageId}`;
}

export function deriveStatusEventKey(providerMessageId: string, status: string, providerTimestamp: string): string {
  return `message.status:${providerMessageId}:${status}:${providerTimestamp}`;
}

export const WHATSAPP_EVENT_TYPE = {
  MESSAGE_INBOUND: "message.inbound",
  MESSAGE_STATUS: "message.status",
} as const;
