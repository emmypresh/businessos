import "server-only";

/**
 * Server-only Meta WhatsApp Cloud API configuration — the interim,
 * single-tenant provider posture this round is scoped to (see
 * supabase/migrations/20260908080000_whatsapp_application_provider_writer.sql's
 * own header comment). Every value here is read from server environment
 * variables ONLY — never a NEXT_PUBLIC_ variable, never a database
 * column (the frozen foundation deliberately stores no access token,
 * app secret, or verify token anywhere — see whatsapp_accounts' own
 * frozen header comment). Per-business encrypted credential onboarding
 * (real Meta Embedded Signup) is a separately reviewed future subphase
 * — this file is NOT that, and getWhatsappConfig()'s own callers must
 * never claim otherwise to a user.
 *
 * FAILS CLOSED: getWhatsappConfig() returns null for ANY missing or
 * malformed required value — no partial/default/demo configuration is
 * ever synthesized. Every caller (webhook route, Meta client, connect
 * action, send action) must treat a null return as "WhatsApp is not
 * configured in this environment" and refuse to proceed, never guess.
 */

export type WhatsappConfig = {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  controlledBusinessId: string;
};

const GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

let cached: WhatsappConfig | null | undefined;

/**
 * Reads and validates every required env var. Cached after the first
 * call within a given server process (env vars do not change at
 * runtime) — mirrors lib/billing/paystack-environment.ts's own
 * "validate once, fail closed on anything invalid" convention. Returns
 * null (never throws) so every caller can render/return a clear,
 * generic "not configured" outcome instead of an unhandled exception.
 */
export function getWhatsappConfig(): WhatsappConfig | null {
  if (cached !== undefined) {
    return cached;
  }

  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const appSecret = process.env.META_WHATSAPP_APP_SECRET;
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;
  const graphApiVersion = process.env.META_GRAPH_API_VERSION;
  const businessAccountId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const displayPhoneNumber = process.env.META_WHATSAPP_DISPLAY_PHONE_NUMBER;
  const controlledBusinessId = process.env.WHATSAPP_CONTROLLED_BUSINESS_ID;

  if (
    !nonEmpty(accessToken) ||
    !nonEmpty(appSecret) ||
    !nonEmpty(verifyToken) ||
    !nonEmpty(graphApiVersion) ||
    !GRAPH_API_VERSION_PATTERN.test(graphApiVersion) ||
    !nonEmpty(businessAccountId) ||
    !nonEmpty(phoneNumberId) ||
    !nonEmpty(displayPhoneNumber) ||
    !nonEmpty(controlledBusinessId) ||
    !UUID_PATTERN.test(controlledBusinessId)
  ) {
    cached = null;
    return null;
  }

  cached = {
    accessToken,
    appSecret,
    verifyToken,
    graphApiVersion,
    businessAccountId,
    phoneNumberId,
    displayPhoneNumber,
    controlledBusinessId,
  };
  return cached;
}

/** Test-only hook to reset the module-level cache between test cases. */
export function __resetWhatsappConfigCacheForTests(): void {
  cached = undefined;
}
