/**
 * Verified against the exact CHECK constraints in
 * supabase/migrations/20260907080000_create_whatsapp_core_tables.sql,
 * 20260907080100_create_whatsapp_consent_and_webhook_events.sql, and
 * 20260907080200_whatsapp_permissions_and_private_writer.sql (frozen
 * Phase 1M DB foundation) — never a bare string literal in application
 * code.
 */

export const WHATSAPP_PROVIDER = {
  META_CLOUD: "META_CLOUD",
} as const;

export const WHATSAPP_ACCOUNT_STATUS = {
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  SUSPENDED: "SUSPENDED",
} as const;
export type WhatsappAccountStatus = (typeof WHATSAPP_ACCOUNT_STATUS)[keyof typeof WHATSAPP_ACCOUNT_STATUS];

export const WHATSAPP_MESSAGE_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  FAILED: "FAILED",
} as const;
export type WhatsappMessageStatus = (typeof WHATSAPP_MESSAGE_STATUS)[keyof typeof WHATSAPP_MESSAGE_STATUS];

export const WHATSAPP_TEMPLATE_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  UNKNOWN: "UNKNOWN",
} as const;

export const WHATSAPP_TEMPLATE_CATEGORY = {
  UTILITY: "UTILITY",
  MARKETING: "MARKETING",
  AUTHENTICATION: "AUTHENTICATION",
  UNKNOWN: "UNKNOWN",
} as const;

// This MVP's send action supports exactly these two message types — see
// begin_whatsapp_outbound_message's own UNSUPPORTED_MESSAGE_TYPE check
// (20260908080000_whatsapp_application_provider_writer.sql). Every other
// value the frozen message_type CHECK allows (IMAGE/DOCUMENT/AUDIO/
// VIDEO/LOCATION/CONTACT/INTERACTIVE) is a possible INBOUND message
// type only in this round, never a supported outbound send.
export const WHATSAPP_OUTBOUND_MESSAGE_TYPE = {
  TEXT: "TEXT",
  TEMPLATE: "TEMPLATE",
} as const;
export type WhatsappOutboundMessageType =
  (typeof WHATSAPP_OUTBOUND_MESSAGE_TYPE)[keyof typeof WHATSAPP_OUTBOUND_MESSAGE_TYPE];

// Meta's own standard customer-service-window duration for an ordinary
// (non-special-category) conversation. Mirrored in
// record_inbound_whatsapp_message's own v_window_hours constant — kept
// here too only for application-layer display copy, never as a value
// this application computes a window from itself (the DATABASE, not the
// browser or this constant, is the sole authority for
// customer_service_window_ends_at).
export const WHATSAPP_SERVICE_WINDOW_HOURS = 24;

export const WHATSAPP_MAX_TEXT_LENGTH = 4096;
