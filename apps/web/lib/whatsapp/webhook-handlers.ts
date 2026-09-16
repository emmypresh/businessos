import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getWhatsappConfig } from "@/lib/whatsapp/config";
import {
  type WebhookEnvelope,
  parseMessagesFieldValue,
  deriveInboundMessageEventKey,
  deriveStatusEventKey,
  isSupportedStatus,
} from "@/lib/whatsapp/webhook-events";
import { normalizeMetaWaIdToE164 } from "@/lib/whatsapp/phone";

type AdminClient = SupabaseClient<Database>;

const SUPPORTED_INBOUND_TYPES = new Set([
  "text", "image", "document", "audio", "video", "location", "contacts", "interactive",
]);

function mapInboundMessageType(metaType: string): string {
  const upper = metaType.toUpperCase();
  if (upper === "CONTACTS") return "CONTACT";
  if (SUPPORTED_INBOUND_TYPES.has(metaType)) return upper;
  return "UNKNOWN";
}

function metaTimestampToIso(timestamp: string): string {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

function statusToLocal(metaStatus: string): "SENT" | "DELIVERED" | "READ" | "FAILED" | null {
  switch (metaStatus) {
    case "sent": return "SENT";
    case "delivered": return "DELIVERED";
    case "read": return "READ";
    case "failed": return "FAILED";
    default: return null;
  }
}

/**
 * Processes ONE already-signature-verified, already-schema-valid Meta
 * webhook envelope. Every event-level mutation goes through the two
 * ATOMIC orchestrator RPCs from
 * 20260908080100_whatsapp_provider_reliability.sql
 * (ingest_and_process_whatsapp_inbound_message /
 * ingest_and_process_whatsapp_status_event) — WA-APP-01's fix: ledger
 * receipt and the authoritative downstream mutation happen in ONE
 * database transaction, so a transient downstream failure can never
 * leave a durably-RECEIVED ledger row with its real work permanently
 * lost. This function itself never issues a raw table write, and never
 * throws for a single bad item in a batched payload — but it DOES
 * report back (via the returned boolean) whether ANY event in this
 * envelope ended FAILED_RETRYABLE, so the route can return a
 * retry-triggering 5xx instead of masking the failure with a 200 (see
 * app/api/webhooks/meta-whatsapp/route.ts).
 */
export async function processMetaWebhookEnvelope(
  admin: AdminClient,
  envelope: WebhookEnvelope,
  payloadSha256: string
): Promise<{ hadRetryableFailure: boolean }> {
  const config = getWhatsappConfig();
  if (!config) {
    console.error("[whatsapp webhook] received a valid, signed event but WhatsApp is not configured — acknowledging without processing");
    return { hadRetryableFailure: false };
  }

  let hadRetryableFailure = false;

  for (const entry of envelope.entry) {
    // Defense in depth: this webhook only ever configures ONE WABA in
    // this interim round — an entry for any other WABA id is evidence
    // of a misconfiguration or a shared-secret reuse, never processed.
    if (entry.id !== config.businessAccountId) {
      console.warn("[whatsapp webhook] entry for an unconfigured WABA id, skipping", { entryId: entry.id });
      continue;
    }

    for (const change of entry.changes) {
      if (change.field !== "messages") {
        // Unknown/unsupported valid field (e.g. message_template_status_update,
        // account_update) — acknowledged safely, zero mutation.
        continue;
      }

      const value = parseMessagesFieldValue(change.value);
      if (!value || !value.metadata?.phone_number_id) {
        console.warn("[whatsapp webhook] messages change failed shape validation, skipping");
        continue;
      }

      const { data: numberRow, error: numberError } = await admin
        .from("whatsapp_phone_numbers")
        .select("id, business_id, whatsapp_account_id, branch_id, status")
        .eq("provider_phone_number_id", value.metadata.phone_number_id)
        .maybeSingle();

      if (numberError || !numberRow || numberRow.status !== "ACTIVE") {
        // Unresolvable tenant: never mutate anything for this change.
        // The other changes in this same payload are still processed.
        console.warn("[whatsapp webhook] could not resolve an ACTIVE tenant for this provider phone number, skipping");
        continue;
      }

      for (const message of value.messages ?? []) {
        const failed = await ingestInboundMessage(admin, numberRow, message, payloadSha256);
        hadRetryableFailure = hadRetryableFailure || failed;
      }

      for (const status of value.statuses ?? []) {
        const failed = await ingestStatusEvent(admin, numberRow, status, payloadSha256);
        hadRetryableFailure = hadRetryableFailure || failed;
      }
    }
  }

  return { hadRetryableFailure };
}

type NumberRow = {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  branch_id: string | null;
  status: string;
};

/** Returns true iff this event ended FAILED_RETRYABLE. */
async function ingestInboundMessage(
  admin: AdminClient,
  numberRow: NumberRow,
  message: { from: string; id: string; timestamp: string; type: string; text?: { body?: string } },
  payloadSha256: string
): Promise<boolean> {
  const eventKey = deriveInboundMessageEventKey(message.id);

  const e164 = normalizeMetaWaIdToE164(message.from);
  if (!e164) {
    // Malformed sender id — not a transient condition (a replay would
    // fail identically forever); acknowledged without ever creating a
    // ledger row for it at all.
    console.warn("[whatsapp webhook] inbound message had an unnormalizable sender id, skipping");
    return false;
  }

  // Exact-match customer lookup ONLY — no fuzzy matching, no rewriting
  // of existing customer phone data. Ambiguous (more than one exact
  // match) is treated as unmatched, never a guess.
  const { data: customerRows } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", numberRow.business_id)
    .eq("phone", e164);
  const customerId = customerRows && customerRows.length === 1 ? customerRows[0].id : null;

  const { data: rows, error } = await admin.rpc("ingest_and_process_whatsapp_inbound_message", {
    p_provider_event_key: eventKey,
    p_payload_sha256: payloadSha256,
    p_business_id: numberRow.business_id,
    p_whatsapp_phone_number_id: numberRow.id,
    p_customer_phone_e164: e164,
    p_provider_message_id: message.id,
    p_message_type: mapInboundMessageType(message.type),
    p_branch_id: numberRow.branch_id ?? undefined,
    p_customer_id: customerId ?? undefined,
    p_body_text: message.type === "text" ? (message.text?.body ?? undefined) : undefined,
    p_provider_timestamp: metaTimestampToIso(message.timestamp),
  });

  if (error) {
    // WHATSAPP_WEBHOOK_EVENT_CONFLICT (a changed replay) — a genuine
    // anomaly, never treated as retryable (retrying an identical
    // payload against a conflicting stored association can never
    // resolve itself).
    console.error("[whatsapp webhook] inbound event conflict", { message: error.message });
    return false;
  }

  const row = rows?.[0];
  if (row?.ledger_status === "FAILED_RETRYABLE") {
    console.error("[whatsapp webhook] inbound message processing failed transiently, marked for retry", {
      providerMessageId: message.id,
    });
    return true;
  }
  return false;
}

/** Returns true iff this event ended FAILED_RETRYABLE. */
async function ingestStatusEvent(
  admin: AdminClient,
  numberRow: NumberRow,
  status: { id: string; status: string; timestamp: string; errors?: { title?: string }[]; biz_opaque_callback_data?: string },
  payloadSha256: string
): Promise<boolean> {
  if (!isSupportedStatus(status.status)) {
    // sent/delivered/read/failed are the only statuses this MVP acts on
    // — any other value is acknowledged with zero mutation, and never
    // even reaches the ledger.
    return false;
  }
  const localStatus = statusToLocal(status.status);
  if (!localStatus) return false;

  const providerTimestampIso = metaTimestampToIso(status.timestamp);
  const eventKey = deriveStatusEventKey(status.id, status.status, status.timestamp);
  const failureReason = localStatus === "FAILED" ? (status.errors?.[0]?.title?.slice(0, 300) ?? null) : null;

  // WA-APP-02-R1: pass Meta's own callback-data echo through as-is — the
  // RPC itself independently validates the expected opaque-token shape
  // (a bounded, fixed-format string) and silently ignores anything else
  // rather than trusting it; this layer applies no additional parsing.
  const { data: rows, error } = await admin.rpc("ingest_and_process_whatsapp_status_event", {
    p_provider_event_key: eventKey,
    p_payload_sha256: payloadSha256,
    p_business_id: numberRow.business_id,
    p_whatsapp_phone_number_id: numberRow.id,
    p_provider_message_id: status.id,
    p_status: localStatus,
    p_provider_timestamp: providerTimestampIso,
    p_failure_reason: failureReason ?? undefined,
    p_opaque_callback_token: status.biz_opaque_callback_data ?? undefined,
  });

  if (error) {
    console.error("[whatsapp webhook] status event conflict", { message: error.message });
    return false;
  }

  const row = rows?.[0];
  if (row?.ledger_status === "FAILED_RETRYABLE") {
    console.error("[whatsapp webhook] status event processing failed transiently, marked for retry", {
      providerMessageId: status.id,
    });
    return true;
  }
  return false;
}
