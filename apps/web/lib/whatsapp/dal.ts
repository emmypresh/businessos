import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// Every read here is a plain, RLS-gated PostgREST query against the
// frozen whatsapp.view-policed tables — never a new privileged read
// RPC. See supabase/migrations/20260907080000_create_whatsapp_core_tables.sql
// for the exact SELECT policy every one of these relies on.

export type WhatsappAccountRow = {
  id: string;
  status: string;
  displayName: string | null;
  providerBusinessAccountId: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
};

/**
 * Never returns access token/app secret/verify token — these columns do
 * not exist on this table at all (see the frozen table's own header
 * comment); this DAL simply cannot leak what was never stored.
 */
export const getWhatsappAccount = cache(async (businessId: string): Promise<WhatsappAccountRow | null> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("whatsapp_accounts")
    .select("id, status, display_name, provider_business_account_id, connected_at, disconnected_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    status: data.status,
    displayName: data.display_name,
    providerBusinessAccountId: data.provider_business_account_id,
    connectedAt: data.connected_at,
    disconnectedAt: data.disconnected_at,
  };
});

export type WhatsappPhoneNumberRow = {
  id: string;
  displayPhoneNumber: string;
  status: string;
  isPrimary: boolean;
};

export const getWhatsappPhoneNumbers = cache(async (businessId: string): Promise<WhatsappPhoneNumberRow[]> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("whatsapp_phone_numbers")
    .select("id, display_phone_number, status, is_primary")
    .eq("business_id", businessId)
    .order("is_primary", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id,
    displayPhoneNumber: row.display_phone_number,
    status: row.status,
    isPrimary: row.is_primary,
  }));
});

export type WhatsappTemplateRow = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
};

export const listWhatsappTemplates = cache(async (businessId: string): Promise<WhatsappTemplateRow[]> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("whatsapp_templates")
    .select("id, name, language, category, status")
    .eq("business_id", businessId)
    .order("name", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
  }));
});

export type WhatsappSendableTemplateRow = { id: string; name: string; language: string };

// WAI-002: the inbox composer's template selector must never be able to
// offer a MARKETING template, a template belonging to a different WABA,
// or one that is not currently APPROVED — regardless of what
// listWhatsappTemplates (used by the settings/management page, which
// intentionally shows every status for visibility) returns. This is a
// defence-in-depth filter only: the frozen begin_whatsapp_outbound_message
// RPC independently re-validates status/category/account server-side on
// send and remains the sole authority (TEMPLATE_NOT_APPROVED /
// TEMPLATE_MARKETING_NOT_ALLOWED / TEMPLATE_WRONG_ACCOUNT).
export const listSendableWhatsappTemplates = cache(
  async (businessId: string, whatsappAccountId: string): Promise<WhatsappSendableTemplateRow[]> => {
    if (!whatsappAccountId) return [];
    const supabase = await createClient();
    const { data } = await supabase
      .from("whatsapp_templates")
      .select("id, name, language")
      .eq("business_id", businessId)
      .eq("whatsapp_account_id", whatsappAccountId)
      .eq("status", "APPROVED")
      .neq("category", "MARKETING")
      .order("name", { ascending: true });

    return (data ?? []).map((row) => ({ id: row.id, name: row.name, language: row.language }));
  }
);

export type WhatsappConversationRow = {
  id: string;
  customerId: string | null;
  customerPhoneE164: string;
  status: string;
  lastMessageAt: string | null;
  customerServiceWindowEndsAt: string | null;
};

// Inbox reads deliberately compose only frozen, RLS-protected tables.
// There is no privileged aggregate/RPC and every individual query carries
// business_id as defence in depth alongside the frozen whatsapp.view policy.
export type WhatsappInboxConversationRow = WhatsappConversationRow & {
  customerName: string | null;
  serviceMessagesAllowed: boolean | null;
  // Which WABA/account this conversation's sending number belongs to —
  // the ONLY account identifier exposed to the browser, and only so the
  // UI can request templates scoped to the correct account (WAI-002).
  // Never the account's provider secrets.
  whatsappAccountId: string;
  // Server-derived (Node runtime clock, never the browser's) — the
  // composer MUST use this field, never its own Date.now(), to decide
  // TEXT vs TEMPLATE mode (WAI-004). The frozen begin_whatsapp_outbound_message
  // RPC still independently re-validates the window against the
  // database's own trusted time at send time regardless of this value.
  serviceWindowOpen: boolean;
  lastMessage: { bodyText: string | null; messageType: string; direction: string; status: string; createdAt: string } | null;
};
type InboxPreviewMessage = { conversation_id: string; body_text: string | null; message_type: string; direction: string; status: string; created_at: string };

const INBOX_PAGE_SIZE = 50;

export const listWhatsappInboxConversations = cache(
  async (businessId: string): Promise<WhatsappInboxConversationRow[]> => {
    const supabase = await createClient();
    const { data: conversations, error: conversationError } = await supabase
      .from("whatsapp_conversations")
      .select("id, customer_id, customer_phone_e164, status, last_message_at, customer_service_window_ends_at, whatsapp_phone_number_id")
      .eq("business_id", businessId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(INBOX_PAGE_SIZE);
    if (conversationError) throw new Error(`Failed to load WhatsApp conversations: ${conversationError.message}`);

    const rows = conversations ?? [];
    const conversationIds = rows.map((row) => row.id);
    const customerIds = rows.flatMap((row) => (row.customer_id ? [row.customer_id] : []));
    const phoneNumberIds = [...new Set(rows.map((row) => row.whatsapp_phone_number_id))];

    const [customersResult, preferencesResult, messagesResult, phoneNumbersResult] = await Promise.all([
      customerIds.length
        ? supabase.from("customers").select("id, name").eq("business_id", businessId).in("id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length
        ? supabase
            .from("customer_whatsapp_preferences")
            .select("customer_id, service_messages_allowed")
            .eq("business_id", businessId)
            .in("customer_id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      conversationIds.length
        ? supabase
            .from("whatsapp_messages")
            .select("conversation_id, body_text, message_type, direction, status, created_at")
            .eq("business_id", businessId)
            .in("conversation_id", conversationIds)
            .order("created_at", { ascending: false })
            .limit(INBOX_PAGE_SIZE * 10)
        : Promise.resolve({ data: [], error: null }),
      // Minimum account identifier needed to scope the send-composer's
      // template list to the correct WABA (WAI-002) — never the
      // provider secrets that live on whatsapp_accounts itself.
      phoneNumberIds.length
        ? supabase.from("whatsapp_phone_numbers").select("id, whatsapp_account_id").eq("business_id", businessId).in("id", phoneNumberIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (customersResult.error || preferencesResult.error || messagesResult.error || phoneNumbersResult.error) {
      throw new Error("Failed to load WhatsApp inbox details.");
    }

    const customerNames = new Map((customersResult.data ?? []).map((customer) => [customer.id, customer.name]));
    const serviceConsent = new Map(
      (preferencesResult.data ?? []).map((preference) => [preference.customer_id, preference.service_messages_allowed])
    );
    const accountByPhoneNumber = new Map((phoneNumbersResult.data ?? []).map((row) => [row.id, row.whatsapp_account_id]));
    const latestMessages = new Map<string, InboxPreviewMessage>();
    for (const message of messagesResult.data ?? []) {
      if (!latestMessages.has(message.conversation_id)) latestMessages.set(message.conversation_id, message);
    }

    // Server (Node runtime) clock — never the browser's — is the trusted
    // basis for the read-model's serviceWindowOpen flag (WAI-004). The
    // frozen RPC re-validates against the database's own time at send
    // time regardless.
    const trustedNow = Date.now();

    return rows.map((row) => {
      const latest = latestMessages.get(row.id);
      return {
        id: row.id,
        customerId: row.customer_id,
        customerPhoneE164: row.customer_phone_e164,
        status: row.status,
        lastMessageAt: row.last_message_at,
        customerServiceWindowEndsAt: row.customer_service_window_ends_at,
        customerName: row.customer_id ? customerNames.get(row.customer_id) ?? null : null,
        serviceMessagesAllowed: row.customer_id ? serviceConsent.get(row.customer_id) ?? null : null,
        // Fails closed: an unmapped phone number (should never happen —
        // the frozen FK requires one) yields an empty string that can
        // never match a real template's whatsapp_account_id, rather
        // than silently falling open to "no account filter".
        whatsappAccountId: accountByPhoneNumber.get(row.whatsapp_phone_number_id) ?? "",
        serviceWindowOpen: row.customer_service_window_ends_at
          ? new Date(row.customer_service_window_ends_at).getTime() > trustedNow
          : false,
        lastMessage: latest
          ? { bodyText: latest.body_text, messageType: latest.message_type, direction: latest.direction, status: latest.status, createdAt: latest.created_at }
          : null,
      };
    });
  }
);

export type WhatsappInboxMessageRow = {
  id: string;
  direction: string;
  messageType: string;
  bodyText: string | null;
  status: string;
  createdAt: string;
};

// WAI-003: failure_reason is intentionally NEVER selected here. It can
// carry raw provider/webhook diagnostic text (see the frozen
// whatsapp_messages table's own failure_reason column), so this
// browser-facing read model excludes the column entirely rather than
// filtering it client-side — the UI renders one fixed safe label for
// every FAILED message regardless (components/whatsapp/whatsapp-inbox.tsx).
export const listWhatsappConversationMessages = cache(
  async (businessId: string, conversationId: string): Promise<WhatsappInboxMessageRow[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .select("id, direction, message_type, body_text, status, created_at")
      .eq("business_id", businessId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(`Failed to load WhatsApp messages: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: row.id,
      direction: row.direction,
      messageType: row.message_type,
      bodyText: row.body_text,
      status: row.status,
      createdAt: row.created_at,
    }));
  }
);

export const getWhatsappConversation = cache(
  async (businessId: string, conversationId: string): Promise<WhatsappConversationRow | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("whatsapp_conversations")
      .select("id, customer_id, customer_phone_e164, status, last_message_at, customer_service_window_ends_at")
      .eq("business_id", businessId)
      .eq("id", conversationId)
      .maybeSingle();

    if (!data) return null;
    return {
      id: data.id,
      customerId: data.customer_id,
      customerPhoneE164: data.customer_phone_e164,
      status: data.status,
      lastMessageAt: data.last_message_at,
      customerServiceWindowEndsAt: data.customer_service_window_ends_at,
    };
  }
);
