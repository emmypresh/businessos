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

export type WhatsappConversationRow = {
  id: string;
  customerId: string | null;
  customerPhoneE164: string;
  status: string;
  lastMessageAt: string | null;
  customerServiceWindowEndsAt: string | null;
};

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
