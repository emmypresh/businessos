"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createWhatsappAdminClient } from "@/lib/whatsapp/admin-client";
import { requireUser } from "@/lib/auth/dal";
import { hasPermission } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { getWhatsappConfig } from "@/lib/whatsapp/config";
import { getWhatsappAccount } from "@/lib/whatsapp/dal";
import {
  SendWhatsAppMessageSchema,
  ConnectWhatsappAccountSchema,
  SyncWhatsappTemplatesSchema,
} from "@/lib/validation/whatsapp";
import { sendTextMessage, sendTemplateMessage, getTemplates, MetaClientError } from "@/lib/whatsapp/meta-client";
import type { ActionState } from "@/lib/auth/actions";

// WA-APP-02: this action's own return type adds one field beyond the
// shared ActionState — pendingReconciliation. No existing caller reads
// this action's return today (no send UI is wired up yet in this
// round), so widening it here cannot break anything; a future send UI
// MUST treat pendingReconciliation:true as distinct from an ordinary
// error (never encourage an immediate resend — see this file's own
// sendWhatsAppMessageAction header comment).
export type WhatsAppSendActionState =
  | (Exclude<ActionState, undefined> & { pendingReconciliation?: boolean })
  | undefined;

const PERMISSION_DENIED: ActionState = { error: "You don't have permission to do this." };
const GENERIC_ERROR: ActionState = { error: "Something went wrong. Please try again." };
const CONFIG_ERROR: ActionState = { error: "WhatsApp provider configuration required." };
const PENDING_RECONCILIATION: WhatsAppSendActionState = {
  success: false,
  pendingReconciliation: true,
  error: "Message was accepted by WhatsApp but is still being reconciled. Do not resend — check its status shortly.",
};

// Every action here independently re-authenticates and re-checks its own
// permission on every call, regardless of what the page already
// rendered or hid — mirrors lib/billing/actions.ts's own established
// convention exactly.

/**
 * Connects the ONE interim-configured Meta WABA/phone number to a
 * business. Only ever succeeds for the single business named by
 * WHATSAPP_CONTROLLED_BUSINESS_ID in this interim, single-tenant round
 * — see lib/whatsapp/config.ts's own header comment. No Embedded Signup
 * flow exists; this is an explicit administrative action gated by
 * whatsapp.manage, never an automatic connection.
 */
export async function connectWhatsappAccountAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  const parsed = ConnectWhatsappAccountSchema.safeParse({ businessId: formData.get("businessId") });
  if (!parsed.success) return GENERIC_ERROR;
  const { businessId } = parsed.data;

  const canManage = await hasPermission(businessId, PERMISSION.WHATSAPP_MANAGE);
  if (!canManage) return PERMISSION_DENIED;

  const config = getWhatsappConfig();
  if (!config) return CONFIG_ERROR;

  if (businessId !== config.controlledBusinessId) {
    // Interim single-tenant posture: this environment's configured
    // WABA/phone is bound to exactly one business — never silently
    // assigned to a second one. See this action's own header comment.
    return { error: "WhatsApp is not configured for this business in this environment." };
  }

  const admin = createWhatsappAdminClient();

  const { data: accountId, error: accountError } = await admin.rpc("upsert_meta_whatsapp_account", {
    p_business_id: businessId,
    p_provider_business_account_id: config.businessAccountId,
    p_display_name: undefined,
    p_status: "CONNECTED",
    p_actor_user_id: user.id,
    p_created_by: user.id,
  });
  if (accountError || !accountId) {
    console.error("[whatsapp] connect: upsert_meta_whatsapp_account failed", { message: accountError?.message });
    return GENERIC_ERROR;
  }

  const { error: numberError } = await admin.rpc("upsert_meta_whatsapp_phone_number", {
    p_business_id: businessId,
    p_whatsapp_account_id: accountId,
    p_provider_phone_number_id: config.phoneNumberId,
    p_display_phone_number: config.displayPhoneNumber,
    p_is_primary: true,
  });
  if (numberError) {
    console.error("[whatsapp] connect: upsert_meta_whatsapp_phone_number failed", { message: numberError.message });
    return GENERIC_ERROR;
  }

  revalidatePath(`/${businessId}/settings/whatsapp`);
  return { success: true };
}

export async function disconnectWhatsappAccountAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  const parsed = ConnectWhatsappAccountSchema.safeParse({ businessId: formData.get("businessId") });
  if (!parsed.success) return GENERIC_ERROR;
  const { businessId } = parsed.data;

  const canManage = await hasPermission(businessId, PERMISSION.WHATSAPP_MANAGE);
  if (!canManage) return PERMISSION_DENIED;

  const account = await getWhatsappAccount(businessId);
  if (!account || account.status !== "CONNECTED") {
    return { error: "WhatsApp is not currently connected." };
  }

  const admin = createWhatsappAdminClient();
  const { error } = await admin.rpc("upsert_meta_whatsapp_account", {
    p_business_id: businessId,
    p_provider_business_account_id: account.providerBusinessAccountId ?? "",
    p_display_name: account.displayName ?? undefined,
    p_status: "DISCONNECTED",
    p_actor_user_id: user.id,
    p_created_by: user.id,
  });
  if (error) {
    console.error("[whatsapp] disconnect failed", { message: error.message });
    return GENERIC_ERROR;
  }

  revalidatePath(`/${businessId}/settings/whatsapp`);
  return { success: true };
}

/**
 * Server-only provider-template sync — no template-creation UI/API,
 * provider is the sole source of truth for status/category/language.
 */
export async function syncWhatsappTemplatesAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  const parsed = SyncWhatsappTemplatesSchema.safeParse({ businessId: formData.get("businessId") });
  if (!parsed.success) return GENERIC_ERROR;
  const { businessId } = parsed.data;

  const canManage = await hasPermission(businessId, PERMISSION.WHATSAPP_MANAGE);
  if (!canManage) return PERMISSION_DENIED;

  const config = getWhatsappConfig();
  if (!config) return CONFIG_ERROR;

  const account = await getWhatsappAccount(businessId);
  if (!account || account.status !== "CONNECTED") {
    return { error: "Connect WhatsApp before syncing templates." };
  }

  let templates;
  try {
    templates = await getTemplates();
  } catch (cause) {
    console.error("[whatsapp] template sync failed", { message: cause instanceof Error ? cause.message : String(cause) });
    return { error: "Could not fetch templates from WhatsApp. Please try again." };
  }

  const admin = createWhatsappAdminClient();
  for (const template of templates) {
    const { error } = await admin.rpc("sync_whatsapp_template", {
      p_business_id: businessId,
      p_whatsapp_account_id: account.id,
      p_provider_template_id: template.providerTemplateId,
      p_name: template.name,
      p_language: template.language,
      p_category: template.category,
      p_status: template.status,
      p_body_snapshot: undefined,
      p_actor_user_id: user.id,
    });
    if (error) {
      console.error("[whatsapp] sync_whatsapp_template failed", { message: error.message, template: template.providerTemplateId });
    }
  }

  revalidatePath(`/${businessId}/settings/whatsapp`);
  return { success: true };
}

/**
 * The one outbound-send Server Action. Client input is deliberately
 * minimal (see lib/validation/whatsapp.ts's own header comment) —
 * everything about destination/provider identity/consent/service-window/
 * template-approval is re-derived SERVER-SIDE by
 * begin_whatsapp_outbound_message, never trusted from formData here.
 *
 * OUTBOUND MESSAGE CREATION ORDER (this phase's own explicit sequence):
 * 1-2) authenticate/authorize — requireUser() + the RPC's own internal
 *      whatsapp.send check. 3-6) load conversation/consent/window/
 *      template + enforce every rule — all inside the RPC. 7) create
 *      PENDING message with the client's creation key — the RPC. 8) call
 *      Meta — this function, ONLY when is_new = true. 9-10) bind (via
 *      the durable, idempotent repair_whatsapp_provider_bind — WA-APP-02)
 *      or fail — this function. 11) audit — inside those RPCs.
 *
 * WA-APP-02: once Meta returns a provider_message_id, that id is
 * critical provider truth — this function NEVER returns an ordinary
 * {success:true} until it is DURABLY bound. If the bind itself fails
 * transiently, repair_whatsapp_provider_bind has already recorded a
 * durable repair obligation (before the failure) and this function
 * returns PENDING_RECONCILIATION instead of a false success. A retry
 * with the SAME client_creation_key (the `!row.is_new` branch below)
 * NEVER calls Meta again — it re-reads the current state and, if a
 * repair is still pending, retries the (already-known) bind, using the
 * provider_message_id durably recorded by the earlier attempt, never a
 * fresh one from the client.
 */
export async function sendWhatsAppMessageAction(
  _prevState: WhatsAppSendActionState,
  formData: FormData
): Promise<WhatsAppSendActionState> {
  const user = await requireUser();

  const parsed = SendWhatsAppMessageSchema.safeParse({
    businessId: formData.get("businessId"),
    conversationId: formData.get("conversationId"),
    messageType: formData.get("messageType"),
    bodyText: formData.get("bodyText") || undefined,
    templateId: formData.get("templateId") || undefined,
    clientCreationKey: formData.get("clientCreationKey"),
  });
  if (!parsed.success) return GENERIC_ERROR;
  const input = parsed.data;

  const config = getWhatsappConfig();
  if (!config) return CONFIG_ERROR;

  // Runs as the caller's OWN authenticated session — begin_whatsapp_outbound_message
  // is granted EXECUTE to `authenticated` only, gated by its own internal
  // whatsapp.send check (never a role-name check here or in the RPC).
  const supabase = await createClient();
  const { data: rows, error: beginError } = await supabase.rpc("begin_whatsapp_outbound_message", {
    p_business_id: input.businessId,
    p_conversation_id: input.conversationId,
    p_message_type: input.messageType,
    p_body_text: input.bodyText ?? undefined,
    p_template_id: input.templateId ?? undefined,
    p_client_creation_key: input.clientCreationKey,
  });

  if (beginError) {
    const message = beginError.message;
    if (message.includes("WHATSAPP_SERVICE_CONSENT_REQUIRED")) {
      return { error: "This customer has not consented to WhatsApp service messages." };
    }
    if (message.includes("WHATSAPP_SERVICE_WINDOW_CLOSED")) {
      return { error: "The 24-hour customer service window is closed. An approved template is required." };
    }
    if (message.includes("TEMPLATE_NOT_APPROVED") || message.includes("TEMPLATE_MARKETING_NOT_ALLOWED") || message.includes("TEMPLATE_WRONG_ACCOUNT")) {
      return { error: "This template cannot be used to send this message." };
    }
    if (message.includes("insufficient_privilege")) {
      return PERMISSION_DENIED;
    }
    console.error("[whatsapp] begin_whatsapp_outbound_message failed", { message });
    return GENERIC_ERROR;
  }

  const row = rows?.[0];
  if (!row) return GENERIC_ERROR;

  const admin = createWhatsappAdminClient();

  if (!row.is_new) {
    // Idempotent replay of an already-accepted request — NEVER calls
    // Meta again (WA-APP-02 / preserved ambiguous-timeout behavior).
    // Re-reads current state instead of blindly returning success: a
    // prior attempt may have gotten a provider_message_id from Meta but
    // failed to bind it locally, leaving a durable repair obligation
    // that this replay should retry — never a fresh Meta call, and
    // never a client-supplied provider id.
    return await reconcileExistingOutboundMessage(admin, row.message_id, input.businessId, user.id);
  }

  // WA-APP-02-R1 GENERIC CATCH FIX: a Meta-send rejection and a
  // post-acceptance database transport failure are tracked as two
  // EXPLICITLY DISTINCT states, never funneled through one shared
  // try/catch — that conflation was WA-APP-02-R1's own root cause (a
  // thrown network/transport exception from the repair_whatsapp_provider_bind
  // RPC call itself, BEFORE it ever reached PostgreSQL, was previously
  // caught by the same catch block that handles a definitive Meta
  // rejection, and so incorrectly marked the message FAILED even though
  // Meta had already durably accepted it). providerAccepted is set to
  // true ONLY once Meta's own send response has been parsed
  // successfully; every failure after that point is a post-acceptance
  // failure and must never call fail_whatsapp_outbound_message.
  let providerAccepted = false;
  let providerMessageId: string | null = null;

  try {
    const result =
      input.messageType === "TEMPLATE"
        ? await sendTemplateMessage({
            toE164: row.destination_phone_e164,
            templateName: row.template_name!,
            templateLanguage: row.template_language!,
            bizOpaqueCallbackData: row.opaque_callback_token,
          })
        : await sendTextMessage({
            toE164: row.destination_phone_e164,
            body: input.bodyText!,
            bizOpaqueCallbackData: row.opaque_callback_token,
          });
    providerAccepted = true;
    providerMessageId = result.providerMessageId;
  } catch (cause) {
    if (cause instanceof MetaClientError && cause.retryable) {
      // AMBIGUOUS failure (timeout/network) — Meta may or may not have
      // accepted this message; no provider_message_id was ever
      // returned, so there is nothing to durably bind yet. Never a
      // blind automatic second send; the local message stays PENDING
      // and a future replay of this same client_creation_key re-enters
      // this same ambiguous state rather than calling Meta again. The
      // durable pre-send correlation token (row.opaque_callback_token)
      // remains available — if Meta actually accepted the message
      // despite the lost response, a later status webhook carrying that
      // token can still recover and bind it (WA-APP-02-R1).
      console.error("[whatsapp] ambiguous provider failure, leaving message PENDING for reconciliation", {
        messageId: row.message_id,
      });
      return { error: "WhatsApp did not confirm this message. Please check its status before resending." };
    }

    // Definitive rejection — known Meta failure, no provider_message_id
    // was ever issued, so FAILED is correct and safe here (unlike every
    // post-acceptance failure below, which must never be marked FAILED).
    const reason = cause instanceof MetaClientError ? cause.message : "Provider rejected the message.";
    const { error: failError } = await admin.rpc("fail_whatsapp_outbound_message", {
      p_message_id: row.message_id,
      p_business_id: input.businessId,
      p_failure_reason: reason,
      p_actor_user_id: user.id,
    });
    if (failError) {
      console.error("[whatsapp] fail_whatsapp_outbound_message failed", { message: failError.message });
    }
    return { error: "WhatsApp did not accept this message." };
  }

  // providerAccepted === true from this point on. WA-APP-02:
  // repair_whatsapp_provider_bind is the ONLY path that ever binds a
  // provider_message_id — durable-obligation-first, idempotent,
  // conflict-safe. WA-APP-02-R1: this call is wrapped in its OWN
  // try/catch, entirely separate from the Meta-send try/catch above —
  // a thrown exception here (the RPC transport itself failing BEFORE
  // reaching PostgreSQL, not merely an {error} response FROM Postgres)
  // is a post-acceptance failure and must NEVER be classified as a send
  // failure: never fail_whatsapp_outbound_message, never an ordinary
  // success. The durable pre-send correlation token created in
  // begin_whatsapp_outbound_message (BEFORE Meta was ever contacted)
  // remains the recovery path — a future signed Meta status webhook
  // carrying that token can still identify this exact message and bind
  // its provider_message_id later, even though this call could not.
  try {
    const { data: bindRows, error: bindError } = await admin.rpc("repair_whatsapp_provider_bind", {
      p_message_id: row.message_id,
      p_business_id: input.businessId,
      p_provider_message_id: providerMessageId!,
      p_actor_user_id: user.id,
    });

    if (bindError || !bindRows?.[0]?.resolved) {
      console.error("[whatsapp] repair_whatsapp_provider_bind did not resolve on first attempt", {
        messageId: row.message_id,
        message: bindError?.message,
      });
      return PENDING_RECONCILIATION;
    }
  } catch (cause) {
    console.error("[whatsapp] post-acceptance database transport failure — pending reconciliation, not a send failure", {
      messageId: row.message_id,
      providerAccepted,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return PENDING_RECONCILIATION;
  }

  revalidatePath(`/${input.businessId}/whatsapp`);
  return { success: true };
}

/**
 * WA-APP-02 reconciliation for a `client_creation_key` replay. Never
 * calls Meta. Reads the durable state via
 * get_whatsapp_outbound_message_reconciliation_state (service-role
 * read-only) and either confirms an already-complete bind, retries an
 * already-known pending repair (using ITS OWN stored provider id, never
 * a client-supplied one), or — if the message never got a provider
 * response at all — reports the same safe "ambiguous, do not resend"
 * outcome as a fresh ambiguous timeout would.
 */
async function reconcileExistingOutboundMessage(
  admin: ReturnType<typeof createWhatsappAdminClient>,
  messageId: string,
  businessId: string,
  actorUserId: string
): Promise<WhatsAppSendActionState> {
  const { data: stateRows, error: stateError } = await admin.rpc("get_whatsapp_outbound_message_reconciliation_state", {
    p_message_id: messageId,
    p_business_id: businessId,
  });
  if (stateError) {
    console.error("[whatsapp] get_whatsapp_outbound_message_reconciliation_state failed", { message: stateError.message });
    return GENERIC_ERROR;
  }

  const state = stateRows?.[0];
  if (state?.bound_provider_message_id) {
    // Already fully reconciled — either the original attempt actually
    // succeeded, or an earlier replay already repaired it.
    return { success: true };
  }

  if (state?.has_pending_repair && state.pending_provider_message_id) {
    const { data: bindRows, error: bindError } = await admin.rpc("repair_whatsapp_provider_bind", {
      p_message_id: messageId,
      p_business_id: businessId,
      p_provider_message_id: state.pending_provider_message_id,
      p_actor_user_id: actorUserId,
    });
    if (bindError || !bindRows?.[0]?.resolved) {
      return PENDING_RECONCILIATION;
    }
    return { success: true };
  }

  // No provider_message_id was ever recorded and no repair is pending —
  // this message is still genuinely ambiguous (e.g. an earlier attempt
  // hit a network timeout before Meta ever responded). Never resend.
  return { error: "WhatsApp did not confirm this message. Please check its status before resending." };
}
