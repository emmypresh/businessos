import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

// The route module itself lives under app/ (outside this project's
// vitest `include` glob, which only picks up *.test.ts/lib/**/*.test.ts
// files — see vitest.config.ts) — this test file imports it directly by
// path, which vitest resolves and runs exactly like any other module.
// Keeping the TEST FILE under lib/billing/ is what makes it discovered;
// where the code UNDER TEST lives is unrelated to that glob.
import { POST } from "../../app/api/webhooks/paystack/route";

const SECRET = "sk_test_webhook_route_secret";

function sign(body: string): string {
  return createHmac("sha512", SECRET).update(body, "utf8").digest("hex");
}

function makeRequest(body: string, signature?: string | null): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set("x-paystack-signature", signature ?? sign(body));
  }
  return new NextRequest("http://localhost/api/webhooks/paystack", {
    method: "POST",
    headers,
    body,
  });
}

// A single, shared mock admin client — reconfigured per test via
// `rpcResults`/`fromResult`. Mocking at the module boundary
// (lib/billing/admin-client) is the correct seam: everything DOWNSTREAM
// of it (event-key derivation, signature verification, allowlist
// enforcement, replay/conflict handling) is REAL, unmocked code: this
// test proves the ROUTE's own orchestration, while
// lib/billing/webhook-signature.test.ts / webhook-events.test.ts prove
// the pure logic in isolation, and
// tests/integration/subscription-billing-application.test.ts proves the
// real RPCs against a real database.
const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/billing/admin-client", () => ({
  createBillingAdminClient: () => ({
    rpc: rpcMock,
    from: fromMock,
  }),
}));

function chainableSelect(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return chain;
}

beforeEach(() => {
  vi.stubEnv("PAYSTACK_SECRET_KEY", SECRET);
  // PAYSTACK_ENVIRONMENT fail-closed (APP-1L remediation): every test
  // below that expects to reach past signature verification needs a
  // VALID configured environment — the dedicated "fails closed" test
  // further down explicitly unstubs this to prove the opposite.
  vi.stubEnv("PAYSTACK_ENVIRONMENT", "LIVE");
  rpcMock.mockReset();
  fromMock.mockReset();
  fromMock.mockReturnValue(chainableSelect({ data: null, error: null }));
});

describe("POST /api/webhooks/paystack", () => {
  it("rejects a missing signature header BEFORE any database call", async () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });
    const response = await POST(makeRequest(body, null));
    expect(response.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature BEFORE any database call", async () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });
    const response = await POST(makeRequest(body, "0".repeat(128)));
    expect(response.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with AFTER signing", async () => {
    const originalBody = JSON.stringify({ event: "charge.success", data: { amount: 100 } });
    const signature = sign(originalBody);
    const tamperedBody = JSON.stringify({ event: "charge.success", data: { amount: 999999999 } });
    const response = await POST(makeRequest(tamperedBody, signature));
    expect(response.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a valid signature over that exact (unparseable) body", async () => {
    const body = "{not valid json";
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed envelope missing `event`/`data`", async () => {
    const body = JSON.stringify({ foo: "bar" });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("acknowledges (200) an unrecognized event type with NO mutation and NO ingestion", async () => {
    const body = JSON.stringify({ event: "transfer.success", data: { anything: true } });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("acknowledges (200) an allowlisted event whose payload fails its own minimal shape schema, with NO mutation", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { customer: {} } }); // no reference/id/amount
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("processes a NEW, valid, allowlisted event: ingests then dispatches", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "ingest_paystack_provider_event") {
        return { data: [{ id: "evt-1", is_new: true }], error: null };
      }
      return { data: null, error: null };
    });
    const body = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: "ref_route_test", amount: 100, currency: "NGN", customer: {} },
    });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("ingest_paystack_provider_event", expect.any(Object));
  });

  it("returns a safe 200 for an EXACT REPLAY (is_new=false) without dispatching any mutation", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "ingest_paystack_provider_event") {
        return { data: [{ id: "evt-1", is_new: false }], error: null };
      }
      throw new Error(`unexpected call to ${fn}`);
    });
    const body = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: "ref_replay", amount: 100, currency: "NGN", customer: {} },
    });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(200);
    // Only the ingest call happened — no activation/renewal/transaction
    // RPC was ever reached for a replay.
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("PAYSTACK_ENVIRONMENT fail closed: an unset/invalid configured environment rejects with a server config error, BEFORE any database call", async () => {
    vi.stubEnv("PAYSTACK_ENVIRONMENT", "");
    const body = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: "ref_no_env", amount: 100, currency: "NGN", customer: {} },
    });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("PAYSTACK_ENVIRONMENT fail closed: an invalid (lowercase) configured environment also rejects", async () => {
    vi.stubEnv("PAYSTACK_ENVIRONMENT", "test");
    const body = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: "ref_bad_env", amount: 100, currency: "NGN", customer: {} },
    });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("returns 409 on PROVIDER_EVENT_CONFLICT and never dispatches", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "ingest_paystack_provider_event") {
        return { data: null, error: { message: "PROVIDER_EVENT_CONFLICT" } };
      }
      throw new Error(`unexpected call to ${fn}`);
    });
    const body = JSON.stringify({
      event: "charge.success",
      data: { id: 1, reference: "ref_conflict", amount: 100, currency: "NGN", customer: {} },
    });
    const response = await POST(makeRequest(body, sign(body)));
    expect(response.status).toBe(409);
  });
});
