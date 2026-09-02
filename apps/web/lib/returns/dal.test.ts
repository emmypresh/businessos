import { describe, expect, it, vi } from "vitest";

// Codex application-layer security review, SEC-02: a forced Supabase/
// PostgREST error carrying obviously sensitive internal detail (a schema
// name, a SQLSTATE, a permission-denied-for-function message) must NEVER
// reach the thrown, user-facing error message. Every returns DAL function
// is exercised here with a FAKE client whose query/RPC calls resolve to
// exactly such an error — a pure unit test, independent of any real
// database, so the assertion is about THIS CODE's own error-handling
// discipline, not about what a real Postgres instance happens to say.

const SENSITIVE_ERROR = {
  message: 'relation "private.secret_table" does not exist; SQLSTATE 42501; permission denied for function private.example',
  code: "42501",
};

const mockUser = { id: "11111111-1111-4111-8111-111111111111" };

vi.mock("@/lib/auth/dal", () => ({
  requireUser: vi.fn(async () => mockUser),
}));

function chainReject() {
  // Mimics the PostgREST query-builder's own thenable chain
  // (.from().select().eq().eq().maybeSingle()/.order()) — every method
  // returns `this` so any call order resolves to the same forced error.
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: SENSITIVE_ERROR });
      }
      return () => self;
    },
  });
  return self;
}

let mockClient: { from: () => unknown; rpc: () => Promise<{ data: null; error: typeof SENSITIVE_ERROR }> };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockClient,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { listReturns, getReturn, getReturnItems, getReturnsBranchFilterOptions } = await import("./dal");

function assertSafeRejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected rejection, got a resolved value");
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("SQLSTATE");
      expect(message).not.toContain("42501");
      expect(message).not.toContain("private.");
      expect(message).not.toContain("secret_table");
      expect(message).not.toContain("permission denied");
      return message;
    }
  );
}

describe("returns DAL — error disclosure (SEC-02)", () => {
  it("listReturns: a forced RPC error never exposes SQLSTATE/schema/function detail", async () => {
    mockClient = { from: () => chainReject(), rpc: async () => ({ data: null, error: SENSITIVE_ERROR }) };
    const message = await assertSafeRejection(listReturns("22222222-2222-4222-8222-222222222222", {}));
    expect(message).toBe("Unable to load returns.");
  });

  it("getReturn: a forced query error never exposes SQLSTATE/schema/function detail", async () => {
    mockClient = { from: () => chainReject(), rpc: async () => ({ data: null, error: SENSITIVE_ERROR }) };
    const message = await assertSafeRejection(
      getReturn("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
    );
    expect(message).toBe("Unable to load return details.");
  });

  it("getReturnItems: a forced query error never exposes SQLSTATE/schema/function detail", async () => {
    mockClient = { from: () => chainReject(), rpc: async () => ({ data: null, error: SENSITIVE_ERROR }) };
    const message = await assertSafeRejection(
      getReturnItems("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
    );
    expect(message).toBe("Unable to load return items.");
  });

  it("getReturnsBranchFilterOptions: a forced RPC error never exposes SQLSTATE/schema/function detail", async () => {
    mockClient = { from: () => chainReject(), rpc: async () => ({ data: null, error: SENSITIVE_ERROR }) };
    const message = await assertSafeRejection(getReturnsBranchFilterOptions("22222222-2222-4222-8222-222222222222"));
    expect(message).toBe("Unable to load return filters.");
  });
});
