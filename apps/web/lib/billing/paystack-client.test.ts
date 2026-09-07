import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { disableSubscription, initializeTransaction, PaystackClientError } from "./paystack-client";

// The network layer is mocked entirely — this codebase's own established
// "no automated test requires real Paystack network access" convention.
// Every assertion here proves the REQUEST shape (endpoint, method,
// headers, body) and the RESPONSE handling — never a real HTTP call.

const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_unit_secret");
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("disableSubscription", () => {
  it("POSTs to the fixed /subscription/disable endpoint with a Bearer header and the code/token body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true, message: "ok" }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await disableSubscription({ code: "SUB_123", token: "tok_secret_value" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.paystack.co/subscription/disable");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk_test_unit_secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ code: "SUB_123", token: "tok_secret_value" });
  });

  it("resolves without throwing on a successful provider response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: true, message: "ok" }), { status: 200 })) as unknown as typeof fetch;
    await expect(disableSubscription({ code: "SUB_1", token: "tok_1" })).resolves.toBeUndefined();
  });

  it("throws a generic PaystackClientError on a provider-reported failure, never leaking the token", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: false, message: "Subscription not found" }), { status: 400 })) as unknown as typeof fetch;

    const secretToken = "tok_super_secret_value";
    let thrown: unknown;
    try {
      await disableSubscription({ code: "SUB_1", token: secretToken });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(PaystackClientError);
    expect((thrown as Error).message).not.toContain(secretToken);
  });

  it("throws a generic PaystackClientError on a network failure, never leaking the token", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const secretToken = "tok_network_secret";
    let thrown: unknown;
    try {
      await disableSubscription({ code: "SUB_1", token: secretToken });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(PaystackClientError);
    expect((thrown as Error).message).not.toContain(secretToken);
  });

  it("never includes the token in any console.error call", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: false, message: "fail" }), { status: 400 })) as unknown as typeof fetch;
    const secretToken = "tok_log_secret_check";

    await expect(disableSubscription({ code: "SUB_1", token: secretToken })).rejects.toThrow();

    for (const call of errorSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretToken);
    }
  });

  it("throws PaystackClientError when PAYSTACK_SECRET_KEY is unset", async () => {
    vi.unstubAllEnvs();
    await expect(disableSubscription({ code: "SUB_1", token: "tok_1" })).rejects.toBeInstanceOf(PaystackClientError);
  });
});

describe("initializeTransaction", () => {
  it("POSTs to /transaction/initialize with the exact amount/currency/reference/plan/metadata given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          message: "ok",
          data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: "ref_1" },
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await initializeTransaction({
      email: "owner@example.test",
      amountMinor: "150000",
      currency: "NGN",
      reference: "ref_1",
      planCode: "PLN_abc",
      metadata: { business_id: "biz_1" },
    });

    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/abc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.amount).toBe("150000");
    expect(body.currency).toBe("NGN");
    expect(body.reference).toBe("ref_1");
    expect(body.plan).toBe("PLN_abc");
  });

  it("throws PaystackClientError on a provider-reported failure", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: false, message: "bad request" }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      initializeTransaction({ email: "a@b.test", amountMinor: "100", currency: "NGN", reference: "r1" })
    ).rejects.toBeInstanceOf(PaystackClientError);
  });
});
