import { describe, expect, it, vi, beforeEach } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireUser }));

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ hasPermission }));

const { supabaseRpc } = vi.hoisted(() => ({ supabaseRpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: supabaseRpc })),
}));

const { adminRpc } = vi.hoisted(() => ({ adminRpc: vi.fn() }));
vi.mock("@/lib/whatsapp/admin-client", () => ({
  createWhatsappAdminClient: () => ({ rpc: adminRpc }),
}));

const { getWhatsappConfig } = vi.hoisted(() => ({ getWhatsappConfig: vi.fn() }));
vi.mock("@/lib/whatsapp/config", () => ({ getWhatsappConfig }));

const { sendTextMessage, sendTemplateMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
}));
vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/meta-client")>();
  return { ...actual, sendTextMessage, sendTemplateMessage };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { sendWhatsAppMessageAction } from "@/lib/whatsapp/actions";
import { MetaClientError } from "@/lib/whatsapp/meta-client";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "44444444-4444-4444-8444-444444444444";

function baseFormData() {
  return formData({
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    messageType: "TEXT",
    bodyText: "hello",
    clientCreationKey: KEY,
  });
}

const CALLBACK_TOKEN = "0123456789abcdef0123456789abcdef";

const BEGIN_ROW = {
  message_id: MESSAGE_ID,
  is_new: true,
  whatsapp_account_id: "acct-1",
  whatsapp_phone_number_id: "num-1",
  provider_phone_number_id: "pn-1",
  destination_phone_e164: "+2348012345678",
  provider_template_id: null,
  template_name: null,
  template_language: null,
  opaque_callback_token: CALLBACK_TOKEN,
};

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ id: "user-1" });
  hasPermission.mockReset().mockResolvedValue(true);
  supabaseRpc.mockReset();
  adminRpc.mockReset();
  sendTextMessage.mockReset();
  sendTemplateMessage.mockReset();
  getWhatsappConfig.mockReset().mockReturnValue({
    accessToken: "token", appSecret: "secret", verifyToken: "verify", graphApiVersion: "v21.0",
    businessAccountId: "waba-1", phoneNumberId: "pn-1", displayPhoneNumber: "+15550001111",
    controlledBusinessId: BUSINESS_ID,
  });
});

describe("sendWhatsAppMessageAction — ambiguous timeout (K)", () => {
  it("on an ambiguous (retryable) network failure, leaves the message PENDING and never binds/fails it", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockRejectedValue(new MetaClientError("network timeout", true));

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(result?.error).toMatch(/did not confirm/i);
    expect(adminRpc).not.toHaveBeenCalledWith("repair_whatsapp_provider_bind", expect.anything());
    expect(adminRpc).not.toHaveBeenCalledWith("fail_whatsapp_outbound_message", expect.anything());
  });

  it("a same-client-creation-key retry after an ambiguous timeout NEVER calls Meta a second time", async () => {
    // Simulates the retry: begin_whatsapp_outbound_message now reports
    // is_new=false (the first attempt already created the PENDING row).
    supabaseRpc.mockResolvedValue({ data: [{ ...BEGIN_ROW, is_new: false }], error: null });
    // No repair pending, no provider id ever recorded — still ambiguous.
    adminRpc.mockResolvedValue({
      data: [{ bound_provider_message_id: null, has_pending_repair: false, pending_provider_message_id: null }],
      error: null,
    });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(result?.error).toMatch(/did not confirm/i);
  });
});

describe("sendWhatsAppMessageAction — WA-APP-02 post-acceptance bind failure", () => {
  it("when Meta accepts but the durable bind does not resolve, returns pendingReconciliation — never a false success", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockResolvedValue({ providerMessageId: "wamid.123" });
    adminRpc.mockResolvedValue({ data: [{ resolved: false, bound_provider_message_id: "wamid.123" }], error: null });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(result?.success).not.toBe(true);
    expect((result as { pendingReconciliation?: boolean })?.pendingReconciliation).toBe(true);
    expect(adminRpc).toHaveBeenCalledWith(
      "repair_whatsapp_provider_bind",
      expect.objectContaining({ p_message_id: MESSAGE_ID, p_provider_message_id: "wamid.123" })
    );
  });

  it("when the durable bind resolves immediately, returns an ordinary success", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockResolvedValue({ providerMessageId: "wamid.456" });
    adminRpc.mockResolvedValue({ data: [{ resolved: true, bound_provider_message_id: "wamid.456" }], error: null });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(result?.success).toBe(true);
    expect((result as { pendingReconciliation?: boolean })?.pendingReconciliation).toBeUndefined();
  });

  it("same client_creation_key retry with a pending repair retries the repair using its OWN stored provider id — never calls Meta again", async () => {
    supabaseRpc.mockResolvedValue({ data: [{ ...BEGIN_ROW, is_new: false }], error: null });
    adminRpc.mockImplementation(async (name: string) => {
      if (name === "get_whatsapp_outbound_message_reconciliation_state") {
        return { data: [{ bound_provider_message_id: null, has_pending_repair: true, pending_provider_message_id: "wamid.789" }], error: null };
      }
      if (name === "repair_whatsapp_provider_bind") {
        return { data: [{ resolved: true, bound_provider_message_id: "wamid.789" }], error: null };
      }
      throw new Error(`unexpected admin rpc ${name}`);
    });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(adminRpc).toHaveBeenCalledWith(
      "repair_whatsapp_provider_bind",
      expect.objectContaining({ p_provider_message_id: "wamid.789" })
    );
  });

  it("a same-client-creation-key retry that is ALREADY fully bound returns success without touching Meta or the repair path", async () => {
    supabaseRpc.mockResolvedValue({ data: [{ ...BEGIN_ROW, is_new: false }], error: null });
    adminRpc.mockResolvedValue({
      data: [{ bound_provider_message_id: "wamid.already-bound", has_pending_repair: false, pending_provider_message_id: null }],
      error: null,
    });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(result?.success).toBe(true);
    expect(adminRpc).not.toHaveBeenCalledWith("repair_whatsapp_provider_bind", expect.anything());
  });
});

describe("sendWhatsAppMessageAction — WA-APP-02-R1 callback token wiring", () => {
  it("sends Meta the server-derived opaque callback token, never anything client-supplied", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockResolvedValue({ providerMessageId: "wamid.123" });
    adminRpc.mockResolvedValue({ data: [{ resolved: true, bound_provider_message_id: "wamid.123" }], error: null });

    await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bizOpaqueCallbackData: CALLBACK_TOKEN })
    );
  });

  it("a TEMPLATE send also includes the callback token", async () => {
    supabaseRpc.mockResolvedValue({
      data: [{ ...BEGIN_ROW, provider_template_id: "tpl-1", template_name: "hello_world", template_language: "en_US" }],
      error: null,
    });
    sendTemplateMessage.mockResolvedValue({ providerMessageId: "wamid.999" });
    adminRpc.mockResolvedValue({ data: [{ resolved: true, bound_provider_message_id: "wamid.999" }], error: null });

    await sendWhatsAppMessageAction(
      undefined,
      formData({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        messageType: "TEMPLATE",
        templateId: "33333333-3333-4333-8333-333333333334",
        clientCreationKey: KEY,
      })
    );

    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bizOpaqueCallbackData: CALLBACK_TOKEN })
    );
  });
});

describe("sendWhatsAppMessageAction — WA-APP-02-R1 generic catch fix", () => {
  it("a transport exception from the bind RPC call itself (never reaching Postgres) after Meta acceptance returns pendingReconciliation — NEVER fail_whatsapp_outbound_message, NEVER a false success", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockResolvedValue({ providerMessageId: "wamid.transport-fail" });
    // Simulates the RPC call itself throwing (a real network/transport
    // exception) rather than resolving with an {error} — this is the
    // exact WA-APP-02-R1 failure mode: the request never reached
    // PostgreSQL at all.
    adminRpc.mockRejectedValue(new Error("fetch failed: ECONNRESET"));

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect((result as { pendingReconciliation?: boolean })?.pendingReconciliation).toBe(true);
    expect(result?.success).not.toBe(true);
    expect(adminRpc).not.toHaveBeenCalledWith("fail_whatsapp_outbound_message", expect.anything());
  });
});

describe("sendWhatsAppMessageAction — definitive rejection unaffected", () => {
  it("a definitive (non-retryable) Meta rejection still marks the message FAILED, never PENDING-reconciliation", async () => {
    supabaseRpc.mockResolvedValue({ data: [BEGIN_ROW], error: null });
    sendTextMessage.mockRejectedValue(new MetaClientError("invalid recipient", false));
    adminRpc.mockResolvedValue({ data: null, error: null });

    const result = await sendWhatsAppMessageAction(undefined, baseFormData());

    expect(result?.error).toMatch(/did not accept/i);
    expect(adminRpc).toHaveBeenCalledWith("fail_whatsapp_outbound_message", expect.objectContaining({ p_message_id: MESSAGE_ID }));
    expect(adminRpc).not.toHaveBeenCalledWith("repair_whatsapp_provider_bind", expect.anything());
  });
});
