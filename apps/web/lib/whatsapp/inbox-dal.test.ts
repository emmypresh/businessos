import { describe, expect, it, vi } from "vitest";

// Real behavioral coverage for the inbox read model (WAI-002/003/004),
// exercised against a tiny in-memory query engine that actually applies
// .eq/.neq/.in filters — not a source-text/grep assertion.

type Row = Record<string, unknown>;

function makeTable(rows: Row[]) {
  let filtered = [...rows];
  let selectedColumns = "";
  const builder = {
    select(columns: string) {
      selectedColumns = columns;
      return builder;
    },
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    neq(col: string, val: unknown) {
      filtered = filtered.filter((r) => r[col] !== val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filtered = filtered.filter((r) => vals.includes(r[col]));
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      return { data: filtered[0] ?? null, error: null };
    },
    then(resolve: (v: { data: Row[]; error: null; selectedColumns: string }) => void) {
      resolve({ data: filtered, error: null, selectedColumns });
    },
  };
  return builder;
}

const BUSINESS_ID = "biz-1";
const OTHER_BUSINESS_ID = "biz-2";
const ACCOUNT_ID = "acct-1";
const OTHER_ACCOUNT_ID = "acct-2";
const PHONE_NUMBER_ID = "phone-1";

let db: Record<string, Row[]>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => makeTable(db[table] ?? []),
  }),
}));

const { listSendableWhatsappTemplates, listWhatsappInboxConversations, listWhatsappConversationMessages } = await import(
  "./dal"
);

describe("listSendableWhatsappTemplates (WAI-002)", () => {
  const templates: Row[] = [
    { id: "t-approved-utility", name: "Order update", language: "en", category: "UTILITY", status: "APPROVED", business_id: BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
    { id: "t-marketing", name: "Big sale", language: "en", category: "MARKETING", status: "APPROVED", business_id: BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
    { id: "t-rejected", name: "Old template", language: "en", category: "UTILITY", status: "REJECTED", business_id: BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
    { id: "t-paused", name: "Paused template", language: "en", category: "UTILITY", status: "PAUSED", business_id: BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
    { id: "t-disabled", name: "Disabled template", language: "en", category: "UTILITY", status: "DISABLED", business_id: BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
    { id: "t-wrong-account", name: "Other account", language: "en", category: "UTILITY", status: "APPROVED", business_id: BUSINESS_ID, whatsapp_account_id: OTHER_ACCOUNT_ID },
    { id: "t-other-business", name: "Other business", language: "en", category: "UTILITY", status: "APPROVED", business_id: OTHER_BUSINESS_ID, whatsapp_account_id: ACCOUNT_ID },
  ];

  it("returns only APPROVED, non-MARKETING templates for the requested business and account", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, ACCOUNT_ID);
    expect(result.map((t) => t.id)).toEqual(["t-approved-utility"]);
  });

  it("never returns a MARKETING template", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, ACCOUNT_ID);
    expect(result.some((t) => t.id === "t-marketing")).toBe(false);
  });

  it("never returns a REJECTED, PAUSED, or DISABLED template", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, ACCOUNT_ID);
    expect(result.some((t) => ["t-rejected", "t-paused", "t-disabled"].includes(t.id))).toBe(false);
  });

  it("never returns an approved template belonging to a different WhatsApp account", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, ACCOUNT_ID);
    expect(result.some((t) => t.id === "t-wrong-account")).toBe(false);
  });

  it("never returns a template from a different business", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, ACCOUNT_ID);
    expect(result.some((t) => t.id === "t-other-business")).toBe(false);
  });

  it("returns nothing (and never queries) when no account id is known", async () => {
    db = { whatsapp_templates: templates };
    const result = await listSendableWhatsappTemplates(BUSINESS_ID, "");
    expect(result).toEqual([]);
  });
});

describe("listWhatsappConversationMessages (WAI-003)", () => {
  it("never selects the failure_reason column, and mapped rows never carry it", async () => {
    db = {
      whatsapp_messages: [
        {
          id: "m1",
          direction: "OUTBOUND",
          message_type: "TEXT",
          body_text: "hi",
          status: "FAILED",
          created_at: "2026-01-01T00:00:00Z",
          business_id: BUSINESS_ID,
          conversation_id: "conv-1",
          failure_reason: "Meta error 131047: re-engagement required, internal trace abc123",
        },
      ],
    };
    const result = await listWhatsappConversationMessages(BUSINESS_ID, "conv-1");
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("failureReason");
    expect(JSON.stringify(result)).not.toContain("131047");
    expect(JSON.stringify(result)).not.toContain("internal trace");
  });
});

describe("listWhatsappInboxConversations — trusted service window (WAI-004)", () => {
  it("marks the window OPEN when the trusted end timestamp is in the future, regardless of what a manipulated client clock would compute", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db = {
      whatsapp_conversations: [
        {
          id: "conv-open",
          customer_id: null,
          customer_phone_e164: "+15551234567",
          status: "OPEN",
          last_message_at: null,
          customer_service_window_ends_at: future,
          whatsapp_phone_number_id: PHONE_NUMBER_ID,
          business_id: BUSINESS_ID,
        },
      ],
      customers: [],
      customer_whatsapp_preferences: [],
      whatsapp_messages: [],
      whatsapp_phone_numbers: [{ id: PHONE_NUMBER_ID, whatsapp_account_id: ACCOUNT_ID, business_id: BUSINESS_ID }],
    };
    const [row] = await listWhatsappInboxConversations(BUSINESS_ID);
    expect(row.serviceWindowOpen).toBe(true);
    expect(row.whatsappAccountId).toBe(ACCOUNT_ID);
  });

  it("marks the window CLOSED once the trusted end timestamp is in the past", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db = {
      whatsapp_conversations: [
        {
          id: "conv-closed",
          customer_id: null,
          customer_phone_e164: "+15551234567",
          status: "OPEN",
          last_message_at: null,
          customer_service_window_ends_at: past,
          whatsapp_phone_number_id: PHONE_NUMBER_ID,
          business_id: BUSINESS_ID,
        },
      ],
      customers: [],
      customer_whatsapp_preferences: [],
      whatsapp_messages: [],
      whatsapp_phone_numbers: [{ id: PHONE_NUMBER_ID, whatsapp_account_id: ACCOUNT_ID, business_id: BUSINESS_ID }],
    };
    const [row] = await listWhatsappInboxConversations(BUSINESS_ID);
    expect(row.serviceWindowOpen).toBe(false);
  });

  it("fails closed to an empty account id (never matches any template) if a phone number has no mapped account", async () => {
    db = {
      whatsapp_conversations: [
        {
          id: "conv-orphan",
          customer_id: null,
          customer_phone_e164: "+15551234567",
          status: "OPEN",
          last_message_at: null,
          customer_service_window_ends_at: null,
          whatsapp_phone_number_id: "missing-phone",
          business_id: BUSINESS_ID,
        },
      ],
      customers: [],
      customer_whatsapp_preferences: [],
      whatsapp_messages: [],
      whatsapp_phone_numbers: [],
    };
    const [row] = await listWhatsappInboxConversations(BUSINESS_ID);
    expect(row.whatsappAccountId).toBe("");
  });
});
