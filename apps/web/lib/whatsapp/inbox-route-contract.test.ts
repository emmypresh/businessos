import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral coverage for the WhatsApp inbox route (page.tsx). Rather
// than grepping the route's source text (the pre-remediation version of
// this file did exactly that, and a grep proves nothing about actual
// runtime behavior — WAI-006), every test here calls the real Server
// Component function with mocked dependencies and asserts on what it
// actually does: which permission gate it calls, what it passes to the
// rendered <WhatsappInbox>, and how it resolves conversation selection.

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const CONV_A = "22222222-2222-4222-8222-222222222222";
const CONV_B = "33333333-3333-4333-8333-333333333333";
const CROSS_BUSINESS_CONV = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";

function conversation(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    customerId: null,
    customerPhoneE164: "+15551234567",
    status: "OPEN",
    lastMessageAt: null,
    customerServiceWindowEndsAt: null,
    customerName: null,
    serviceMessagesAllowed: null,
    whatsappAccountId: ACCOUNT_ID,
    serviceWindowOpen: false,
    lastMessage: null,
    ...overrides,
  };
}

const { requirePermissionOrNotFound } = vi.hoisted(() => ({ requirePermissionOrNotFound: vi.fn() }));
vi.mock("@/lib/business/dal", () => ({ requirePermissionOrNotFound }));

const { listWhatsappInboxConversations, listWhatsappConversationMessages, listSendableWhatsappTemplates } = vi.hoisted(() => ({
  listWhatsappInboxConversations: vi.fn(),
  listWhatsappConversationMessages: vi.fn(),
  listSendableWhatsappTemplates: vi.fn(),
}));
vi.mock("@/lib/whatsapp/dal", () => ({
  listWhatsappInboxConversations,
  listWhatsappConversationMessages,
  listSendableWhatsappTemplates,
}));

vi.mock("@/components/whatsapp/whatsapp-inbox", () => ({
  // Capture props without needing a DOM renderer — page.tsx just
  // constructs and returns this element directly.
  WhatsappInbox: (props: Record<string, unknown>) => ({ type: "WhatsappInbox", props }),
}));

const WhatsappInboxPage = (await import("@/app/[businessId]/whatsapp/page")).default;

beforeEach(() => {
  requirePermissionOrNotFound.mockReset();
  listWhatsappInboxConversations.mockReset();
  listWhatsappConversationMessages.mockReset();
  listSendableWhatsappTemplates.mockReset();
});

function callPage(conversationQuery?: string) {
  return WhatsappInboxPage({
    params: Promise.resolve({ businessId: BUSINESS_ID }),
    searchParams: Promise.resolve(conversationQuery ? { conversation: conversationQuery } : {}),
  });
}

describe("WhatsApp inbox route", () => {
  it("denies a caller without whatsapp.view before any conversation data is read", async () => {
    requirePermissionOrNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    await expect(callPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listWhatsappInboxConversations).not.toHaveBeenCalled();
  });

  it("gates the page on whatsapp.view specifically, for this exact business", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: () => false });
    listWhatsappInboxConversations.mockResolvedValue([]);
    await callPage();
    expect(requirePermissionOrNotFound).toHaveBeenCalledWith(BUSINESS_ID, "whatsapp.view");
  });

  it("computes canSend independently from whatsapp.send — a view-only caller gets canSend:false", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: (perm: string) => perm !== "whatsapp.send" });
    listWhatsappInboxConversations.mockResolvedValue([]);
    const element = (await callPage()) as { props: { canSend: boolean } };
    expect(element.props.canSend).toBe(false);
  });

  it("grants canSend:true only when whatsapp.send is present", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: () => true });
    listWhatsappInboxConversations.mockResolvedValue([]);
    const element = (await callPage()) as { props: { canSend: boolean } };
    expect(element.props.canSend).toBe(true);
  });

  it("mobile base route (no ?conversation=) selects nothing — the list stays the view", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: () => true });
    listWhatsappInboxConversations.mockResolvedValue([conversation(CONV_A), conversation(CONV_B)]);
    const element = (await callPage()) as { props: { activeConversation: unknown; messages: unknown; templates: unknown } };
    expect(element.props.activeConversation).toBeNull();
    expect(listWhatsappConversationMessages).not.toHaveBeenCalled();
    expect(listSendableWhatsappTemplates).not.toHaveBeenCalled();
  });

  it("selecting a conversation present in this business's own list loads its thread", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: () => true });
    listWhatsappInboxConversations.mockResolvedValue([conversation(CONV_A), conversation(CONV_B)]);
    listWhatsappConversationMessages.mockResolvedValue([{ id: "m1" }]);
    listSendableWhatsappTemplates.mockResolvedValue([]);
    const element = (await callPage(CONV_B)) as { props: { activeConversation: { id: string } } };
    expect(element.props.activeConversation?.id).toBe(CONV_B);
    expect(listWhatsappConversationMessages).toHaveBeenCalledWith(BUSINESS_ID, CONV_B);
    expect(listSendableWhatsappTemplates).toHaveBeenCalledWith(BUSINESS_ID, ACCOUNT_ID);
  });

  it("a conversation id from another business (not in this business's own scoped list) never loads a thread", async () => {
    requirePermissionOrNotFound.mockResolvedValue({ has: () => true });
    listWhatsappInboxConversations.mockResolvedValue([conversation(CONV_A)]);
    const element = (await callPage(CROSS_BUSINESS_CONV)) as { props: { activeConversation: unknown } };
    expect(element.props.activeConversation).toBeNull();
    expect(listWhatsappConversationMessages).not.toHaveBeenCalled();
    expect(listSendableWhatsappTemplates).not.toHaveBeenCalled();
  });
});
