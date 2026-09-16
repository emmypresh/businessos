import "server-only";
import { z } from "zod";
import { getWhatsappConfig } from "@/lib/whatsapp/config";

/**
 * Narrow, server-only Meta WhatsApp Cloud API client — direct HTTPS
 * Graph API calls, deliberately NOT an SDK (per this round's own
 * explicit "do not use an archived/unmaintained SDK as the trust
 * boundary" instruction). Exactly the three capabilities this round
 * needs: sendTextMessage, sendTemplateMessage, and the optional
 * getTemplates read used by the template-sync action. Every other Graph
 * API surface (media upload, Embedded Signup, campaigns) is out of
 * scope — see this phase's own final report.
 *
 * META_WHATSAPP_ACCESS_TOKEN is read ONLY via getWhatsappConfig()
 * (lib/whatsapp/config.ts) — never logged, never returned, never
 * embedded in a thrown error message. Every error this module throws is
 * a sanitized, generic MetaClientError; full provider response bodies
 * are only ever passed to console.error (server-side only), and even
 * there the access token itself never appears in that response body
 * (Meta does not echo request headers back).
 */

const GRAPH_HOST = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 15_000;

export class MetaClientError extends Error {
  constructor(message: string, public readonly retryable: boolean = false) {
    super(message);
    this.name = "MetaClientError";
  }
}

function graphBase(graphApiVersion: string): string {
  return `${GRAPH_HOST}/${graphApiVersion}`;
}

async function graphFetch(url: string, accessToken: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // AbortSignal.timeout / network failure is AMBIGUOUS — the request
    // may or may not have reached Meta. Never retried automatically
    // here (this phase's own explicit "ambiguous timeout: no blind
    // second send" instruction) — the caller (lib/whatsapp/actions.ts)
    // treats this as a synchronous failure and marks the local message
    // FAILED via the trusted writer, exactly once.
    console.error("[meta-whatsapp] network error", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    throw new MetaClientError("Could not reach WhatsApp. Please try again.", true);
  }
}

const SendMessageResponseSchema = z.object({
  messaging_product: z.literal("whatsapp").optional(),
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
}).passthrough();

export type SendMessageResult = { providerMessageId: string };

async function parseSendResponse(response: Response): Promise<SendMessageResult> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    // Sanitized log only — the error field can carry an fbtrace_id and
    // a message but never anything from this application's own request
    // beyond the http status. Never the access token (not present in
    // any response body Meta returns).
    console.error("[meta-whatsapp] send failed", {
      httpStatus: response.status,
      providerError: (body as { error?: { message?: string; code?: number } } | null)?.error?.message,
    });
    // 5xx and 429 are treated as retryable-by-the-CALLER's-own-policy
    // signals only insofar as they are surfaced distinctly — this
    // module itself never auto-retries (see graphFetch's own comment).
    throw new MetaClientError("WhatsApp did not accept this message.", response.status >= 500 || response.status === 429);
  }

  const parsed = SendMessageResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[meta-whatsapp] send response failed shape validation");
    throw new MetaClientError("WhatsApp returned an unexpected response.", false);
  }

  return { providerMessageId: parsed.data.messages[0].id };
}

// WA-APP-02-R1: `biz_opaque_callback_data` is Meta's own documented
// Cloud API field for exactly this purpose — a top-level string on the
// outbound message request that Meta echoes back verbatim on the
// corresponding message-status webhook, letting a later signed webhook
// identify the exact local message even when the synchronous send
// response (or the immediate post-send bind call) never reaches this
// application. Max 512 characters per Meta's own documented limit; this
// application's own token is always a fixed 32-hex-character value (see
// begin_whatsapp_outbound_message,
// 20260908080200_whatsapp_outbound_provider_correlation.sql), never
// anything longer, and is ALWAYS the server-derived value returned by
// that RPC — this client accepts it as a plain input like any other
// field and applies no further trust decision of its own; the caller
// (lib/whatsapp/actions.ts) is responsible for never sourcing it from
// browser/form input.
const CALLBACK_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

function assertValidCallbackToken(token: string): void {
  if (!CALLBACK_TOKEN_PATTERN.test(token)) {
    // Defensive only — this should be structurally impossible given the
    // token's own database CHECK constraint. Never sent to Meta
    // malformed.
    throw new MetaClientError("WhatsApp message could not be sent.", false);
  }
}

export type SendTextMessageInput = {
  toE164: string;
  body: string;
  bizOpaqueCallbackData: string;
};

/**
 * POST /{phone_number_id}/messages — a free-form TEXT message. The
 * caller is responsible for having ALREADY enforced consent/service
 * window server-side (begin_whatsapp_outbound_message) — this client
 * enforces nothing about consent or the service window itself; it is a
 * dumb transport, exactly one Graph API call. `bizOpaqueCallbackData` is
 * REQUIRED (WA-APP-02-R1) — every outbound send always has a durable
 * pre-send correlation token by the time this function is ever called.
 */
export async function sendTextMessage(input: SendTextMessageInput): Promise<SendMessageResult> {
  const config = getWhatsappConfig();
  if (!config) {
    throw new MetaClientError("WhatsApp is not configured.", false);
  }
  assertValidCallbackToken(input.bizOpaqueCallbackData);

  const url = `${graphBase(config.graphApiVersion)}/${config.phoneNumberId}/messages`;
  const response = await graphFetch(url, config.accessToken, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.toE164.replace("+", ""),
      type: "text",
      text: { body: input.body },
      biz_opaque_callback_data: input.bizOpaqueCallbackData,
    }),
  });

  return parseSendResponse(response);
}

export type SendTemplateMessageInput = {
  toE164: string;
  templateName: string;
  templateLanguage: string;
  bizOpaqueCallbackData: string;
};

/**
 * POST /{phone_number_id}/messages — an approved TEMPLATE message. No
 * component/variable substitution is implemented in this MVP round
 * (bodies with variables are out of scope — see this phase's own final
 * report); only a template with no required variables can be sent
 * through this call today. `bizOpaqueCallbackData` is REQUIRED
 * (WA-APP-02-R1) — see sendTextMessage's own identical comment.
 */
export async function sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendMessageResult> {
  const config = getWhatsappConfig();
  if (!config) {
    throw new MetaClientError("WhatsApp is not configured.", false);
  }
  assertValidCallbackToken(input.bizOpaqueCallbackData);

  const url = `${graphBase(config.graphApiVersion)}/${config.phoneNumberId}/messages`;
  const response = await graphFetch(url, config.accessToken, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.toE164.replace("+", ""),
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.templateLanguage },
      },
      biz_opaque_callback_data: input.bizOpaqueCallbackData,
    }),
  });

  return parseSendResponse(response);
}

const TemplateListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      language: z.string().min(1),
      category: z.string().min(1),
      status: z.string().min(1),
    }).passthrough()
  ),
}).passthrough();

export type ProviderTemplate = {
  providerTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
};

/**
 * GET /{waba_id}/message_templates — optional read used by the
 * template-sync action only. Never used to CREATE a template (no
 * template-creation UI/API exists in this round).
 */
export async function getTemplates(): Promise<ProviderTemplate[]> {
  const config = getWhatsappConfig();
  if (!config) {
    throw new MetaClientError("WhatsApp is not configured.", false);
  }

  const url = `${graphBase(config.graphApiVersion)}/${config.businessAccountId}/message_templates?limit=100`;
  const response = await graphFetch(url, config.accessToken, { method: "GET" });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    console.error("[meta-whatsapp] getTemplates failed", { httpStatus: response.status });
    throw new MetaClientError("Could not fetch templates from WhatsApp.", response.status >= 500);
  }

  const parsed = TemplateListResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[meta-whatsapp] getTemplates response failed shape validation");
    throw new MetaClientError("WhatsApp returned an unexpected response.", false);
  }

  return parsed.data.data.map((t) => ({
    providerTemplateId: t.id,
    name: t.name,
    language: t.language,
    category: t.category.toUpperCase(),
    status: t.status.toUpperCase(),
  }));
}
