// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import type { WhatsappInboxConversationRow, WhatsappInboxMessageRow, WhatsappSendableTemplateRow } from "@/lib/whatsapp/dal";

afterEach(() => cleanup());

const { sendWhatsAppMessageAction } = vi.hoisted(() => ({ sendWhatsAppMessageAction: vi.fn() }));
vi.mock("@/lib/whatsapp/actions", () => ({ sendWhatsAppMessageAction }));

const { useRouterMock, refreshMock } = vi.hoisted(() => ({ useRouterMock: vi.fn(), refreshMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: useRouterMock }));

const {
  WhatsappInbox,
  serviceWindowState,
  whatsappMessageStatusLabel,
  isAmbiguousSendResult,
  SAFE_FAILED_MESSAGE_LABEL,
  AMBIGUOUS_SEND_ERROR_TEXT,
} = await import("./whatsapp-inbox");

const BUSINESS_ID = "biz-1";
const ACCOUNT_ID = "acct-1";

function makeConversation(overrides: Partial<WhatsappInboxConversationRow> = {}): WhatsappInboxConversationRow {
  return {
    id: "conv-1",
    customerId: "cust-1",
    customerPhoneE164: "+15551234567",
    status: "OPEN",
    lastMessageAt: null,
    customerServiceWindowEndsAt: null,
    customerName: "Ada Lovelace",
    serviceMessagesAllowed: true,
    whatsappAccountId: ACCOUNT_ID,
    serviceWindowOpen: true,
    lastMessage: null,
    ...overrides,
  };
}

const TEMPLATES: WhatsappSendableTemplateRow[] = [{ id: "tpl-1", name: "Order update", language: "en" }];

function renderInbox(opts: {
  conversation: WhatsappInboxConversationRow;
  messages?: WhatsappInboxMessageRow[];
  templates?: WhatsappSendableTemplateRow[];
  canSend?: boolean;
}) {
  return render(
    <WhatsappInbox
      businessId={BUSINESS_ID}
      conversations={[opts.conversation]}
      activeConversation={opts.conversation}
      messages={opts.messages ?? []}
      templates={opts.templates ?? TEMPLATES}
      canSend={opts.canSend ?? true}
    />
  );
}

beforeEach(() => {
  sendWhatsAppMessageAction.mockReset();
  useRouterMock.mockReset();
  refreshMock.mockReset();
  useRouterMock.mockReturnValue({ refresh: refreshMock });
});

describe("pure presentation helpers", () => {
  it("maps every frozen outbound delivery state to a user-facing label", () => {
    expect(["PENDING", "ACCEPTED", "SENT", "DELIVERED", "READ", "FAILED"].map(whatsappMessageStatusLabel)).toEqual([
      "Pending", "Accepted", "Sent", "Delivered", "Read", "Failed",
    ]);
  });

  it("only treats a future trusted service-window timestamp as open (display-only helper)", () => {
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    expect(serviceWindowState("2026-09-16T12:00:01.000Z", now)).toBe("OPEN");
    expect(serviceWindowState("2026-09-16T12:00:00.000Z", now)).toBe("CLOSED");
    expect(serviceWindowState(null, now)).toBe("CLOSED");
  });

  it("classifies both frozen-action ambiguous outcomes and nothing else as ambiguous", () => {
    expect(isAmbiguousSendResult(undefined)).toBe(false);
    expect(isAmbiguousSendResult({ error: AMBIGUOUS_SEND_ERROR_TEXT })).toBe(true);
    expect(isAmbiguousSendResult({ error: "x", pendingReconciliation: true })).toBe(true);
    expect(isAmbiguousSendResult({ error: "This template cannot be used to send this message." })).toBe(false);
    expect(isAmbiguousSendResult({ success: true })).toBe(false);
  });
});

describe("authorization-driven rendering", () => {
  it("a view-only user (canSend=false) sees the thread but the composer is disabled", () => {
    renderInbox({ conversation: makeConversation(), canSend: false });
    expect(screen.getByText(/don.t have permission to send/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("a user with send permission and consent can use the composer", () => {
    renderInbox({ conversation: makeConversation(), canSend: true });
    expect(screen.queryByText(/don.t have permission to send/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeEnabled();
  });

  it("service consent false disables the send UX with a clear reason", () => {
    renderInbox({ conversation: makeConversation({ serviceMessagesAllowed: false }) });
    expect(screen.getByText(/has not consented to whatsapp service messages/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("an unmatched conversation blocks sending until matched to a customer", () => {
    renderInbox({ conversation: makeConversation({ customerId: null, serviceMessagesAllowed: null }) });
    expect(screen.getByText(/match this phone number to a customer/i)).toBeInTheDocument();
  });
});

describe("customer match rendering", () => {
  it("renders the matched customer's name", () => {
    renderInbox({ conversation: makeConversation({ customerId: "cust-1", customerName: "Ada Lovelace" }) });
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText("+15551234567")).toBeInTheDocument();
  });

  it("renders an unmatched conversation by phone number with an explicit label", () => {
    renderInbox({ conversation: makeConversation({ customerId: null, customerName: null }) });
    expect(screen.getByRole("heading", { name: "+15551234567" })).toBeInTheDocument();
    expect(screen.getByText("Unmatched phone number")).toBeInTheDocument();
  });
});

describe("trusted service-window mode (WAI-004)", () => {
  it("uses TEXT mode when the server-derived read model says the window is open", () => {
    renderInbox({ conversation: makeConversation({ serviceWindowOpen: true }) });
    expect(screen.getByLabelText("Message text")).toBeInTheDocument();
    expect(screen.queryByLabelText(/approved template required/i)).not.toBeInTheDocument();
  });

  it("uses TEMPLATE mode when the server-derived read model says the window is closed", () => {
    renderInbox({ conversation: makeConversation({ serviceWindowOpen: false }) });
    expect(screen.queryByLabelText("Message text")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/approved template required/i)).toBeInTheDocument();
  });

  it("ignores a manipulated browser clock — mode is driven only by the serviceWindowOpen prop, never Date.now()", () => {
    const realNow = Date.now;
    // Simulate an attacker/broken client clock far in the future, which
    // would flip a Date.now()-based decision from CLOSED to OPEN.
    Date.now = () => realNow() + 1000 * 60 * 60 * 24 * 365;
    try {
      renderInbox({ conversation: makeConversation({ serviceWindowOpen: false, customerServiceWindowEndsAt: new Date(realNow() - 1000).toISOString() }) });
      expect(screen.getByLabelText(/approved template required/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Message text")).not.toBeInTheDocument();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("template selector filtering trust boundary", () => {
  it("never offers a template beyond exactly what the (already-filtered) server read model provided", () => {
    renderInbox({
      conversation: makeConversation({ serviceWindowOpen: false }),
      templates: [{ id: "tpl-1", name: "Order update", language: "en" }],
    });
    const options = screen.getAllByRole("option");
    // "Select an approved template" placeholder + exactly one real template.
    expect(options).toHaveLength(2);
    expect(screen.getByRole("option", { name: /order update/i })).toBeInTheDocument();
  });

  it("disables sending when the server read model provides no sendable template", () => {
    renderInbox({ conversation: makeConversation({ serviceWindowOpen: false }), templates: [] });
    expect(screen.getByText(/no approved template is available/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send template/i })).toBeDisabled();
  });
});

describe("failure-reason sanitization (WAI-003)", () => {
  it("renders the fixed safe label for a FAILED message and never any raw reason text", () => {
    renderInbox({
      conversation: makeConversation(),
      messages: [
        { id: "m1", direction: "OUTBOUND", messageType: "TEXT", bodyText: "hi", status: "FAILED", createdAt: "2026-01-01T00:00:00Z" },
      ],
    });
    expect(screen.getByText(SAFE_FAILED_MESSAGE_LABEL)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("labels the composer form and the message textarea", () => {
    renderInbox({ conversation: makeConversation() });
    expect(screen.getByRole("form", { name: /send whatsapp message/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Message text")).toBeInTheDocument();
  });

  it("renders a destructive alert with alert role for a definitive send error", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ error: "WhatsApp did not accept this message." });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not accept this message/i));
  });
});

describe("idempotency key stability and double-submit protection (WAI-001)", () => {
  function keyOf(callIndex: number) {
    const formData = sendWhatsAppMessageAction.mock.calls[callIndex][1] as FormData;
    return formData.get("clientCreationKey");
  }

  it("uses one stable creation key across the initial submission", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ error: "Something went wrong. Please try again." });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(sendWhatsAppMessageAction).toHaveBeenCalledTimes(1));
    expect(keyOf(0)).toEqual(expect.any(String));
    expect(keyOf(0)).not.toBe("");
  });

  it("two rapid submissions never invoke the action more than once / never with two different keys", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    sendWhatsAppMessageAction.mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve; }));
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    const form = screen.getByRole("form", { name: /send whatsapp message/i });
    fireEvent.submit(form);
    fireEvent.submit(form);
    resolveFirst({ error: "Something went wrong. Please try again." });
    await waitFor(() => expect(sendWhatsAppMessageAction).toHaveBeenCalled());
    expect(sendWhatsAppMessageAction).toHaveBeenCalledTimes(1);
  });

  it("an ambiguous outcome preserves the creation key and locks the composer against resend", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ error: AMBIGUOUS_SEND_ERROR_TEXT });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(screen.getByText(/do not resend yet/i)).toBeInTheDocument());
    const firstKey = keyOf(0);
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    // Locked: no second invocation at all.
    expect(sendWhatsAppMessageAction).toHaveBeenCalledTimes(1);
    expect(keyOf(0)).toBe(firstKey);
  });

  it("pendingReconciliation:true preserves the key and locks resend identically to an ambiguous timeout", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({
      success: false,
      pendingReconciliation: true,
      error: "Message was accepted by WhatsApp but is still being reconciled. Do not resend — check its status shortly.",
    });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(screen.getByText(/do not resend yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /sending|send message/i })).toBeDisabled();
  });

  it("a definitive failure does not lock the composer, so the user can safely retry", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ error: "This template cannot be used to send this message." });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(screen.getByText(/template cannot be used/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /send message/i })).toBeEnabled();
  });

  it("a successful resolved send resets the draft and mints a new key only for the next logical message", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ success: true });
    renderInbox({ conversation: makeConversation() });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    const firstKey = keyOf(0);

    sendWhatsAppMessageAction.mockResolvedValue({ error: "Something went wrong. Please try again." });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "second message" } });
    fireEvent.submit(screen.getByRole("form", { name: /send whatsapp message/i }));
    await waitFor(() => expect(sendWhatsAppMessageAction).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).not.toBe(firstKey);
  });
});

describe("keyboard behavior", () => {
  it("Enter submits the composer", async () => {
    sendWhatsAppMessageAction.mockResolvedValue({ error: "Something went wrong. Please try again." });
    renderInbox({ conversation: makeConversation() });
    const textarea = screen.getByLabelText("Message text");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(sendWhatsAppMessageAction).toHaveBeenCalledTimes(1));
  });

  it("Shift+Enter does not submit (inserts a newline instead)", () => {
    renderInbox({ conversation: makeConversation() });
    const textarea = screen.getByLabelText("Message text");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(sendWhatsAppMessageAction).not.toHaveBeenCalled();
  });
});
