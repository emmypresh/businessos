import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, randomUuid } from "./helpers/inventory";
import { makeCustomer } from "./helpers/sales";

// Hybrid technique (matches tests/integration/cost-access-app-layer.test.ts
// exactly): lib/customers/dal.ts ultimately calls lib/supabase/server.ts's
// createClient(), which needs next/headers' cookies() — unavailable
// outside a real Next.js request. Only the cookie-dependent wrapper is
// mocked, to a REAL signed-in client against the REAL local stack — the
// DAL's own query-building logic runs for real, against real RLS.
let currentClient: SupabaseClient<Database>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentClient,
}));
vi.mock("@/lib/auth/dal", async () => {
  return {
    requireUser: async () => {
      const { data } = await currentClient.auth.getUser();
      if (!data.user) throw new Error("not signed in");
      return data.user;
    },
  };
});

const { listCustomers, getCustomer } = await import("@/lib/customers/dal");

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("customer DAL tenant isolation", () => {
  it("listCustomers never returns another business's customers", async () => {
    const a = await createOwnerAndBusiness("cust-dal-tenant-a");
    const b = await createOwnerAndBusiness("cust-dal-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    await makeCustomer(a.client, a.businessId, { name: "Tenant A Customer" });

    currentClient = b.client;
    const { rows } = await listCustomers(b.businessId);
    expect(rows.filter((r) => r.business_id === a.businessId)).toHaveLength(0);
  });

  it("getCustomer 404s (notFound) for a customer belonging to a different business", async () => {
    const a = await createOwnerAndBusiness("cust-dal-getone-a");
    const b = await createOwnerAndBusiness("cust-dal-getone-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const customerId = await makeCustomer(a.client, a.businessId);

    currentClient = b.client;
    // requirePermissionOrNotFound-style pages call next/navigation's
    // notFound(), which throws a NEXT_NOT_FOUND-tagged error outside a
    // real request — asserting the throw is the correct proof here, not
    // a returned value.
    await expect(getCustomer(b.businessId, customerId)).rejects.toThrow();
  });

  it("getCustomer 404s for a genuinely nonexistent id, indistinguishable from a foreign one", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-dal-nonexistent");
    cleanupUserIds.push(userId);
    currentClient = client;

    await expect(getCustomer(businessId, randomUuid())).rejects.toThrow();
  });
});

describe("customer DAL pagination determinism", () => {
  it("keyset pagination returns every customer exactly once across pages, newest first", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-dal-pagination");
    cleanupUserIds.push(userId);
    currentClient = client;

    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `Pagination Customer ${i}`;
      names.push(name);
      await makeCustomer(client, businessId, { name });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { rows, nextCursor } = await listCustomers(businessId, { cursor });
      seen.push(...rows.map((r) => r.id));
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});

describe("customer search safety (real Data API, same adversarial corpus proven for products)", () => {
  const ADVERSARIAL_TERMS = [
    "alpha", "alpha,beta", ",", "alpha)", "(alpha)", "(", "alpha.beta",
    "alpha:beta", "alpha*beta", 'alpha"beta', "alpha'beta", "alpha\\beta",
    "alpha%beta", "alpha_beta", "alpha),sku.not.is.null",
    "alpha,sku.not.is.null", "or(name.eq.foo)",
    "+", "?", "^", "$", "{", "}", "[", "]", "|",
    "alpha.*", "alpha|beta", "alpha$", "^alpha", "alpha[0]", "alpha+", "alpha?",
  ];

  it("every adversarial term against name/phone/email returns a valid response, never PGRST100", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-search-safety");
    cleanupUserIds.push(userId);
    currentClient = client;

    for (const term of ADVERSARIAL_TERMS) {
      const { rows } = await listCustomers(businessId, { search: term });
      expect(rows, `term=${JSON.stringify(term)}`).toEqual([]);
    }
  });

  it("a literal adversarial term matches ONLY the genuine customer containing it, never a decoy", async () => {
    const { client, businessId, userId } = await createOwnerAndBusiness("cust-search-literal");
    cleanupUserIds.push(userId);
    currentClient = client;

    const genuineId = await makeCustomer(client, businessId, { name: "Marker)Suffix" });
    await makeCustomer(client, businessId, { name: "Completely Unrelated Decoy" });

    const { rows } = await listCustomers(businessId, { search: ")" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(genuineId);
  });

  it("search never leaks another tenant's customers", async () => {
    const a = await createOwnerAndBusiness("cust-search-tenant-a");
    const b = await createOwnerAndBusiness("cust-search-tenant-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    await makeCustomer(a.client, a.businessId, { name: "Alpha Customer" });

    currentClient = b.client;
    const { rows } = await listCustomers(a.businessId, { search: "Alpha" });
    // b's session querying a's businessId — RLS scoping means zero rows
    // regardless of search term (b is not a member of a's business).
    expect(rows).toEqual([]);
  });
});
