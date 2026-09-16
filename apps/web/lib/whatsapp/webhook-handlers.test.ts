import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { processMetaWebhookEnvelope } from "@/lib/whatsapp/webhook-handlers";
import { __resetWhatsappConfigCacheForTests } from "@/lib/whatsapp/config";
import type { WebhookEnvelope } from "@/lib/whatsapp/webhook-events";

// Isolates webhook-handlers.ts's own orchestration (tenant resolution,
// customer-match ambiguity, dispatch to the correct atomic RPC, and
// WA-APP-01's retryable-failure signal propagation) with a fully faked
// admin client — no real database. The real-database behavior of the
// atomic RPCs themselves (durability, concurrency, replay-repair) is
// proven by tests/integration/whatsapp-reliability.test.ts; this file's
// own job is proving the JS glue calls the right thing with the right
// arguments, and correctly surfaces FAILED_RETRYABLE as
// hadRetryableFailure.

function stubConfig() {
  vi.stubEnv("META_WHATSAPP_ACCESS_TOKEN", "token");
  vi.stubEnv("META_WHATSAPP_APP_SECRET", "secret");
  vi.stubEnv("META_WHATSAPP_VERIFY_TOKEN", "verify");
  vi.stubEnv("META_GRAPH_API_VERSION", "v21.0");
  vi.stubEnv("META_WHATSAPP_BUSINESS_ACCOUNT_ID", "waba-1");
  vi.stubEnv("META_WHATSAPP_PHONE_NUMBER_ID", "phone-1");
  vi.stubEnv("META_WHATSAPP_DISPLAY_PHONE_NUMBER", "+15550001111");
  vi.stubEnv("WHATSAPP_CONTROLLED_BUSINESS_ID", "11111111-1111-1111-1111-111111111111");
}

beforeEach(() => {
  __resetWhatsappConfigCacheForTests();
  stubConfig();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetWhatsappConfigCacheForTests();
});

type FakeAdminOptions = {
  numberRow?: { id: string; business_id: string; whatsapp_account_id: string; branch_id: string | null; status: string } | null;
  customerRows?: { id: string }[];
  rpcResults?: Record<string, { data: unknown; error: unknown }>;
};

function makeFakeAdmin(opts: FakeAdminOptions) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    return (
      opts.rpcResults?.[name] ?? {
        data: [{ message_id: "msg-1", conversation_id: "conv-1", is_new_message: true, ledger_status: "PROCESSED" }],
        error: null,
      }
    );
  });

  const from = vi.fn((table: string) => {
    if (table === "whatsapp_phone_numbers") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.numberRow ?? null, error: null }) }) }) };
    }
    if (table === "customers") {
      return { select: () => ({ eq: () => ({ eq: async () => ({ data: opts.customerRows ?? [], error: null }) }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { rpc, from, rpcCalls } as unknown as Parameters<typeof processMetaWebhookEnvelope>[0] & { rpcCalls: { name: string; args: unknown }[] };
}

const NUMBER_ROW = { id: "num-1", business_id: "biz-1", whatsapp_account_id: "acct-1", branch_id: null, status: "ACTIVE" };

function envelope(changes: unknown[]): WebhookEnvelope {
  return { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes }] } as WebhookEnvelope;
}

describe("processMetaWebhookEnvelope — tenant resolution", () => {
  it("never mutates when the provider phone number cannot be resolved to an ACTIVE tenant", async () => {
    const admin = makeFakeAdmin({ numberRow: null });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "unknown-phone" }, messages: [{ from: "1234567", id: "wamid.1", timestamp: "1000", type: "text" }] } },
    ]), "hash");
    expect(admin.rpcCalls).toHaveLength(0);
    expect(result.hadRetryableFailure).toBe(false);
  });

  it("skips an entry for a WABA id other than the configured one", async () => {
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW });
    const env: WebhookEnvelope = {
      object: "whatsapp_business_account",
      entry: [{ id: "some-other-waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "1234567", id: "wamid.1", timestamp: "1000", type: "text" }] } }] }],
    } as WebhookEnvelope;
    await processMetaWebhookEnvelope(admin, env, "hash");
    expect(admin.rpcCalls).toHaveLength(0);
  });

  it("ignores a non-`messages` field with zero mutation", async () => {
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW });
    await processMetaWebhookEnvelope(admin, envelope([{ field: "message_template_status_update", value: { some: "thing" } }]), "hash");
    expect(admin.rpcCalls).toHaveLength(0);
  });
});

describe("processMetaWebhookEnvelope — inbound customer matching + atomic dispatch", () => {
  it("resolves exactly one exact-match customer and passes its id to the atomic inbound RPC", async () => {
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW, customerRows: [{ id: "cust-1" }] });
    await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text", text: { body: "hi" } }] } },
    ]), "hash");

    const call = admin.rpcCalls.find((c) => c.name === "ingest_and_process_whatsapp_inbound_message");
    expect(call).toBeTruthy();
    expect((call!.args as { p_customer_id?: string }).p_customer_id).toBe("cust-1");
  });

  it("treats an AMBIGUOUS match (more than one exact hit) as unmatched — never guesses", async () => {
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW, customerRows: [{ id: "cust-1" }, { id: "cust-2" }] });
    await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text" }] } },
    ]), "hash");

    const call = admin.rpcCalls.find((c) => c.name === "ingest_and_process_whatsapp_inbound_message");
    expect((call!.args as { p_customer_id?: string }).p_customer_id).toBeUndefined();
  });

  it("WA-APP-01: surfaces FAILED_RETRYABLE from the atomic inbound RPC as hadRetryableFailure", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: {
        ingest_and_process_whatsapp_inbound_message: {
          data: [{ message_id: null, conversation_id: null, is_new_message: false, ledger_status: "FAILED_RETRYABLE" }],
          error: null,
        },
      },
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text" }] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(true);
  });

  it("does not report a failure when the atomic RPC returns PROCESSED", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: {
        ingest_and_process_whatsapp_inbound_message: {
          data: [{ message_id: "msg-1", conversation_id: "conv-1", is_new_message: true, ledger_status: "PROCESSED" }],
          error: null,
        },
      },
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text" }] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(false);
  });

  it("never reports a failure for a WHATSAPP_WEBHOOK_EVENT_CONFLICT (a changed replay is a permanent anomaly, not retryable)", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: {
        ingest_and_process_whatsapp_inbound_message: { data: null, error: { message: "WHATSAPP_WEBHOOK_EVENT_CONFLICT" } },
      },
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [{ from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text" }] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(false);
  });
});

describe("processMetaWebhookEnvelope — status events", () => {
  it("dispatches a status event to the atomic status RPC with the right args", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: { ingest_and_process_whatsapp_status_event: { data: [{ ledger_status: "PROCESSED", message_resolved: true }], error: null } },
    });
    await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "wamid.1", status: "read", timestamp: "1000" }] } },
    ]), "hash");
    const call = admin.rpcCalls.find((c) => c.name === "ingest_and_process_whatsapp_status_event");
    expect(call).toBeTruthy();
    expect((call!.args as { p_status?: string }).p_status).toBe("READ");
  });

  it("WA-APP-02-R1: forwards biz_opaque_callback_data through to the atomic status RPC as p_opaque_callback_token", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: { ingest_and_process_whatsapp_status_event: { data: [{ ledger_status: "PROCESSED", message_resolved: true }], error: null } },
    });
    await processMetaWebhookEnvelope(admin, envelope([
      {
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone-1" },
          statuses: [{ id: "wamid.1", status: "read", timestamp: "1000", biz_opaque_callback_data: "0123456789abcdef0123456789abcdef" }],
        },
      },
    ]), "hash");
    const call = admin.rpcCalls.find((c) => c.name === "ingest_and_process_whatsapp_status_event");
    expect((call!.args as { p_opaque_callback_token?: string }).p_opaque_callback_token).toBe("0123456789abcdef0123456789abcdef");
  });

  it("passes p_opaque_callback_token as undefined when Meta did not echo one back", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: { ingest_and_process_whatsapp_status_event: { data: [{ ledger_status: "PROCESSED", message_resolved: true }], error: null } },
    });
    await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "wamid.1", status: "read", timestamp: "1000" }] } },
    ]), "hash");
    const call = admin.rpcCalls.find((c) => c.name === "ingest_and_process_whatsapp_status_event");
    expect((call!.args as { p_opaque_callback_token?: string }).p_opaque_callback_token).toBeUndefined();
  });

  it("ignores an unsupported status value with zero mutation (never reaches the RPC)", async () => {
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "wamid.1", status: "deleted", timestamp: "1000" }] } },
    ]), "hash");
    expect(admin.rpcCalls).toHaveLength(0);
    expect(result.hadRetryableFailure).toBe(false);
  });

  it("WA-APP-01: surfaces FAILED_RETRYABLE from the atomic status RPC as hadRetryableFailure", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: { ingest_and_process_whatsapp_status_event: { data: [{ ledger_status: "FAILED_RETRYABLE", message_resolved: false }], error: null } },
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "wamid.1", status: "read", timestamp: "1000" }] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(true);
  });

  it("an unresolved (IGNORED) status event does not report a failure", async () => {
    const admin = makeFakeAdmin({
      numberRow: NUMBER_ROW,
      rpcResults: { ingest_and_process_whatsapp_status_event: { data: [{ ledger_status: "IGNORED", message_resolved: false }], error: null } },
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, statuses: [{ id: "wamid.unknown", status: "delivered", timestamp: "1000" }] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(false);
  });
});

describe("processMetaWebhookEnvelope — mixed batch failure propagation", () => {
  it("a single FAILED_RETRYABLE event anywhere in the batch marks the whole result as hadRetryableFailure=true", async () => {
    let call = 0;
    const admin = makeFakeAdmin({ numberRow: NUMBER_ROW });
    (admin.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      call += 1;
      if (name === "ingest_and_process_whatsapp_inbound_message" && call === 1) {
        return { data: [{ message_id: "m1", conversation_id: "c1", is_new_message: true, ledger_status: "PROCESSED" }], error: null };
      }
      return { data: [{ message_id: null, conversation_id: null, is_new_message: false, ledger_status: "FAILED_RETRYABLE" }], error: null };
    });
    const result = await processMetaWebhookEnvelope(admin, envelope([
      { field: "messages", value: { metadata: { phone_number_id: "phone-1" }, messages: [
        { from: "2348012345678", id: "wamid.1", timestamp: "1000", type: "text" },
        { from: "2348012345679", id: "wamid.2", timestamp: "1001", type: "text" },
      ] } },
    ]), "hash");
    expect(result.hadRetryableFailure).toBe(true);
  });
});
