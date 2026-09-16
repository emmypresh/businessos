import { z } from "zod";
import { WHATSAPP_OUTBOUND_MESSAGE_TYPE, WHATSAPP_MAX_TEXT_LENGTH } from "@/lib/whatsapp/constants";

/**
 * Client input for sendWhatsAppMessageAction — deliberately minimal, per
 * this phase's own explicit "client input should be minimal" /
 * "server must re-read everything" instructions. NOTHING about
 * destination phone, provider identity, service window, consent, or
 * template approval is accepted from the client here — see
 * begin_whatsapp_outbound_message
 * (20260908080000_whatsapp_application_provider_writer.sql) for what is
 * independently re-derived server-side.
 */
export const SendWhatsAppMessageSchema = z.object({
  businessId: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageType: z.enum([WHATSAPP_OUTBOUND_MESSAGE_TYPE.TEXT, WHATSAPP_OUTBOUND_MESSAGE_TYPE.TEMPLATE]),
  bodyText: z.string().min(1).max(WHATSAPP_MAX_TEXT_LENGTH).optional(),
  templateId: z.string().uuid().optional(),
  clientCreationKey: z.string().min(1).max(128),
});

export const ConnectWhatsappAccountSchema = z.object({
  businessId: z.string().uuid(),
});

export const SyncWhatsappTemplatesSchema = z.object({
  businessId: z.string().uuid(),
});
