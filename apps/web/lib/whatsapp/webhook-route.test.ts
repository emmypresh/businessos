import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { __resetWhatsappConfigCacheForTests } from "@/lib/whatsapp/config";

// Mirrors lib/billing/webhook-route.test.ts's own exact pattern and
// rationale: mocking at the admin-client module boundary keeps
// signature verification, body-size enforcement, and envelope
// validation REAL and unmocked — this test proves the ROUTE's own
// orchestration. lib/whatsapp/webhook-signature.test.ts and
// lib/whatsapp/webhook-events.test.ts prove the pure logic in
// isolation; tests/integration/whatsapp-application.test.ts proves the
// real RPCs against a real database.
import { POST, GET } from "../../app/api/webhooks/meta-whatsapp/route";

const APP_SECRET = "test_app_secret";
const VERIFY_TOKEN = "test_verify_token";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

function makePostRequest(body: string, signature?: string | null, extraHeaders?: Record<string, string>): NextRequest {
  const headers = new Headers({ "content-type": "application/json", ...extraHeaders });
  if (signature !== null) {
    headers.set("x-hub-signature-256", signature ?? sign(body));
  }
  return new NextRequest("http://localhost/api/webhooks/meta-whatsapp", { method: "POST", headers, body });
}

function makeGetRequest(query: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/webhooks/meta-whatsapp");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method: "GET" });
}

const processMock = vi.fn();
vi.mock("@/lib/whatsapp/webhook-handlers", () => ({
  processMetaWebhookEnvelope: (...args: unknown[]) => processMock(...args),
}));

vi.mock("@/lib/whatsapp/admin-client", () => ({
  createWhatsappAdminClient: () => ({}),
}));

function stubValidConfig() {
  vi.stubEnv("META_WHATSAPP_ACCESS_TOKEN", "token");
  vi.stubEnv("META_WHATSAPP_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN);
  vi.stubEnv("META_GRAPH_API_VERSION", "v21.0");
  vi.stubEnv("META_WHATSAPP_BUSINESS_ACCOUNT_ID", "waba-1");
  vi.stubEnv("META_WHATSAPP_PHONE_NUMBER_ID", "phone-1");
  vi.stubEnv("META_WHATSAPP_DISPLAY_PHONE_NUMBER", "+15550001111");
  vi.stubEnv("WHATSAPP_CONTROLLED_BUSINESS_ID", "11111111-1111-1111-1111-111111111111");
}

beforeEach(() => {
  __resetWhatsappConfigCacheForTests();
  processMock.mockReset();
  processMock.mockResolvedValue({ hadRetryableFailure: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetWhatsappConfigCacheForTests();
});

const VALID_ENVELOPE = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" } } }] }],
});

describe("GET /api/webhooks/meta-whatsapp (verification handshake)", () => {
  it("returns the challenge for a valid token", async () => {
    stubValidConfig();
    const response = await GET(makeGetRequest({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "12345" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("12345");
  });

  it("rejects a wrong token", async () => {
    stubValidConfig();
    const response = await GET(makeGetRequest({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" }));
    expect(response.status).toBe(403);
  });

  it("rejects a missing token", async () => {
    stubValidConfig();
    const response = await GET(makeGetRequest({ "hub.mode": "subscribe", "hub.challenge": "12345" }));
    expect(response.status).toBe(403);
  });

  it("fails closed when WhatsApp is not configured", async () => {
    const response = await GET(makeGetRequest({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "12345" }));
    expect(response.status).toBe(500);
  });
});

describe("POST /api/webhooks/meta-whatsapp (signature + envelope)", () => {
  it("rejects a missing signature BEFORE any processing", async () => {
    stubValidConfig();
    const response = await POST(makePostRequest(VALID_ENVELOPE, null));
    expect(response.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature BEFORE any processing", async () => {
    stubValidConfig();
    const response = await POST(makePostRequest(VALID_ENVELOPE, "sha256=" + "0".repeat(64)));
    expect(response.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with AFTER signing", async () => {
    stubValidConfig();
    const signature = sign(VALID_ENVELOPE);
    const tampered = VALID_ENVELOPE.replace("phone-1", "phone-2");
    const response = await POST(makePostRequest(tampered, signature));
    expect(response.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a valid signature over that exact (unparseable) body", async () => {
    stubValidConfig();
    const body = "{not valid json";
    const response = await POST(makePostRequest(body, sign(body)));
    expect(response.status).toBe(400);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed envelope with the wrong `object` value", async () => {
    stubValidConfig();
    const body = JSON.stringify({ object: "page", entry: [] });
    const response = await POST(makePostRequest(body, sign(body)));
    expect(response.status).toBe(400);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized body via Content-Length BEFORE reading it", async () => {
    stubValidConfig();
    const body = VALID_ENVELOPE;
    const response = await POST(makePostRequest(body, sign(body), { "content-length": String(2_000_000) }));
    expect(response.status).toBe(413);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized body by actual size even without a Content-Length header", async () => {
    stubValidConfig();
    const bigValue = "x".repeat(1_100_000);
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [], padding: bigValue });
    const response = await POST(makePostRequest(body, sign(body)));
    expect(response.status).toBe(413);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("fails closed (500) when WhatsApp is not configured, before signature verification can even matter", async () => {
    const response = await POST(makePostRequest(VALID_ENVELOPE, sign(VALID_ENVELOPE)));
    expect(response.status).toBe(500);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("processes a validly-signed, well-formed envelope and acknowledges 200", async () => {
    stubValidConfig();
    const response = await POST(makePostRequest(VALID_ENVELOPE, sign(VALID_ENVELOPE)));
    expect(response.status).toBe(200);
    expect(processMock).toHaveBeenCalledTimes(1);
  });

  it("WA-APP-01: returns a retry-triggering 5xx (never 200) when processing reports a transient failure, and never leaks internal error detail", async () => {
    stubValidConfig();
    processMock.mockResolvedValue({ hadRetryableFailure: true });
    const response = await POST(makePostRequest(VALID_ENVELOPE, sign(VALID_ENVELOPE)));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBeLessThan(600);
    const json = await response.json();
    expect(JSON.stringify(json)).not.toMatch(/FAILED_RETRYABLE|sqlstate|stack/i);
  });

  it("WA-APP-01: returns a retry-triggering 5xx (never 200) if processing throws unexpectedly — never acknowledges lost work, and never leaks internal error detail", async () => {
    stubValidConfig();
    processMock.mockRejectedValue(new Error("boom"));
    const response = await POST(makePostRequest(VALID_ENVELOPE, sign(VALID_ENVELOPE)));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBeLessThan(600);
    const json = await response.json();
    expect(JSON.stringify(json)).not.toMatch(/boom/);
  });
});
