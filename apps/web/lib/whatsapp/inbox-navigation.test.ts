import { describe, expect, it } from "vitest";
import { selectActiveWhatsappConversation } from "./inbox-navigation";
import type { WhatsappInboxConversationRow } from "./dal";

function conversation(id: string): WhatsappInboxConversationRow {
  return {
    id,
    customerId: null,
    customerPhoneE164: "+15551234567",
    status: "OPEN",
    lastMessageAt: null,
    customerServiceWindowEndsAt: null,
    customerName: null,
    serviceMessagesAllowed: null,
    whatsappAccountId: "acct",
    serviceWindowOpen: false,
    lastMessage: null,
  };
}

describe("selectActiveWhatsappConversation (WAI-005)", () => {
  const list = [conversation("a"), conversation("b")];

  it("selects nothing when no conversation is requested (mobile base route shows the list)", () => {
    expect(selectActiveWhatsappConversation(list, undefined)).toBeNull();
  });

  it("never falls back to the first conversation in the list", () => {
    expect(selectActiveWhatsappConversation(list, undefined)).not.toBe(list[0]);
  });

  it("selects the requested conversation when it is present in this business's own list", () => {
    expect(selectActiveWhatsappConversation(list, "b")).toBe(list[1]);
  });

  it("selects nothing for an id absent from this business's own scoped list (cross-business or stale id)", () => {
    expect(selectActiveWhatsappConversation(list, "cross-business-id")).toBeNull();
  });

  it("selects nothing for an empty conversation list regardless of the requested id", () => {
    expect(selectActiveWhatsappConversation([], "a")).toBeNull();
  });
});
