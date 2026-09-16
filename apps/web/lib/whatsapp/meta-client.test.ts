import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { __resetWhatsappConfigCacheForTests } from "@/lib/whatsapp/config";
import { sendTextMessage, sendTemplateMessage, MetaClientError } from "@/lib/whatsapp/meta-client";

// WA-APP-02-R1 — the outbound Meta send request must ALWAYS include the
// server-derived opaque callback token (biz_opaque_callback_data), for
// both TEXT and TEMPLATE sends, and this module must never accept an
// arbitrary/malformed value as if it were a trusted token (defense in
// depth — the real trust boundary is that lib/whatsapp/actions.ts only
// ever sources this value from begin_whatsapp_outbound_message's own
// RPC response, never from formData/browser input).

const CALLBACK_TOKEN = "0123456789abcdef0123456789abcdef";

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

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  __resetWhatsappConfigCacheForTests();
  stubConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetWhatsappConfigCacheForTests();
});

describe("sendTextMessage — WA-APP-02-R1 callback correlation", () => {
  it("includes the exact biz_opaque_callback_data field in the request body", async () => {
    const fetchMock = mockFetchOnce({ messaging_product: "whatsapp", messages: [{ id: "wamid.1" }] });

    await sendTextMessage({ toE164: "+15551234567", body: "hi", bizOpaqueCallbackData: CALLBACK_TOKEN });

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.biz_opaque_callback_data).toBe(CALLBACK_TOKEN);
  });

  it("rejects a malformed callback token before ever calling Meta (defense in depth)", async () => {
    const fetchMock = mockFetchOnce({});
    await expect(
      sendTextMessage({ toE164: "+15551234567", body: "hi", bizOpaqueCallbackData: "not-a-valid-token; DROP TABLE" })
    ).rejects.toBeInstanceOf(MetaClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendTemplateMessage — WA-APP-02-R1 callback correlation", () => {
  it("includes the exact biz_opaque_callback_data field in the request body", async () => {
    const fetchMock = mockFetchOnce({ messaging_product: "whatsapp", messages: [{ id: "wamid.2" }] });

    await sendTemplateMessage({
      toE164: "+15551234567",
      templateName: "hello_world",
      templateLanguage: "en_US",
      bizOpaqueCallbackData: CALLBACK_TOKEN,
    });

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.biz_opaque_callback_data).toBe(CALLBACK_TOKEN);
  });

  it("rejects a malformed callback token before ever calling Meta (defense in depth)", async () => {
    const fetchMock = mockFetchOnce({});
    await expect(
      sendTemplateMessage({
        toE164: "+15551234567",
        templateName: "hello_world",
        templateLanguage: "en_US",
        bizOpaqueCallbackData: "<script>alert(1)</script>",
      })
    ).rejects.toBeInstanceOf(MetaClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
