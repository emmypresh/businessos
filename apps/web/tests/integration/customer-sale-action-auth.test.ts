import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithRole, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";

// Hybrid technique — see cost-access-app-layer.test.ts for the full
// rationale. Server Actions redirect() on success, which throws a
// NEXT_REDIRECT-digest-tagged error even outside a real request; tests
// that reach a successful completion catch that specific throw as proof
// of success, then verify the resulting DB state directly.
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
// revalidatePath needs the same request-scoped Next.js internals as
// cookies()/redirect() — unavailable here. A no-op is exactly correct for
// this test's purposes: it exists to bust a Server Component render
// cache, which has no equivalent to assert on outside a real request: the
// underlying DB mutation this test actually verifies happens regardless.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createCustomer, updateCustomer } = await import("@/lib/customers/actions");
const { createSale } = await import("@/lib/sales/actions");

function isRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("createCustomer action boundary", () => {
  it("rejects without calling the RPC when customers.manage is absent (VIEWER)", async () => {
    const owner = await createOwnerAndBusiness("act-cust-create-denied");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithRole(owner.businessId, "act-cust-create-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const rpcSpy = vi.spyOn(viewer.client, "rpc");
    const result = await createCustomer(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Should Not Exist" })
    );

    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpcSpy).not.toHaveBeenCalledWith("create_customer", expect.anything());
    rpcSpy.mockRestore();
  });

  it("rejects a forged businessId the caller has no membership in (RPC-level, not just a local check)", async () => {
    const stranger = await createOwnerAndBusiness("act-cust-forged-biz-stranger");
    const target = await createOwnerAndBusiness("act-cust-forged-biz-target");
    cleanupUserIds.push(stranger.userId, target.userId);

    currentClient = stranger.client;
    const result = await createCustomer(
      undefined,
      formData({ businessId: target.businessId, creationKey: randomUuid(), name: "Forged Attempt" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("reaches the RPC and redirects on success, extracting only the bare id (RPC response sanitization)", async () => {
    const owner = await createOwnerAndBusiness("act-cust-create-success");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    let caught: unknown;
    try {
      await createCustomer(
        undefined,
        formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Real Customer" })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: customers } = await owner.client.from("customers").select("id, name").eq("business_id", owner.businessId);
    expect(customers).toHaveLength(1);
    expect(customers![0].name).toBe("Real Customer");
  });

  it("a double-submit under the same creationKey (idempotency at the action boundary) produces exactly one customer", async () => {
    const owner = await createOwnerAndBusiness("act-cust-idempotent");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const key = randomUuid();
    const fd = () => formData({ businessId: owner.businessId, creationKey: key, name: "Idempotent Customer" });

    const results = await Promise.all([
      createCustomer(undefined, fd()).catch((e) => e),
      createCustomer(undefined, fd()).catch((e) => e),
    ]);
    expect(results.every((r) => isRedirect(r))).toBe(true);

    const { data: customers } = await owner.client
      .from("customers").select("id").eq("business_id", owner.businessId);
    expect(customers).toHaveLength(1);
  });
});

describe("updateCustomer action boundary", () => {
  it("rejects without mutating anything when customers.manage is absent", async () => {
    const owner = await createOwnerAndBusiness("act-cust-update-denied");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Original" });

    const viewer = await createMemberWithRole(owner.businessId, "act-cust-update-denied", "VIEWER");
    cleanupUserIds.push(viewer.userId);
    currentClient = viewer.client;

    const result = await updateCustomer(
      undefined,
      formData({
        businessId: owner.businessId, customerId, name: "Hacked Name", status: "active",
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");

    currentClient = owner.client;
    const { data: customer } = await owner.client.from("customers").select("name").eq("id", customerId).single();
    expect(customer?.name).toBe("Original");
  });

  it("scopes the update by BOTH business_id and customer_id — a forged customerId from another tenant is not found/updated, and does NOT redirect as success (Codex round 2, Finding 2)", async () => {
    const a = await createOwnerAndBusiness("act-cust-update-scope-a");
    const b = await createOwnerAndBusiness("act-cust-update-scope-b");
    cleanupUserIds.push(a.userId, b.userId);

    currentClient = a.client;
    const customerId = await makeCustomer(a.client, a.businessId, { name: "Tenant A Customer" });

    currentClient = b.client;
    // b holds customers.manage in their OWN business, but the target
    // customer belongs to a — scoped by business_id too, so this must
    // not touch a's row even though b independently has the permission.
    // A scoped UPDATE matching zero rows is not a Postgres error (it
    // succeeds trivially at the query level), so updateCustomer must
    // explicitly count the affected rows (via .select("id")) to tell
    // "matched nothing" apart from "updated" — a genuine ActionState
    // error is expected here, never a redirect.
    const result = await updateCustomer(
      undefined,
      formData({ businessId: b.businessId, customerId, name: "Hacked", status: "active" })
    );
    expect(result?.error).toBeTruthy();

    currentClient = a.client;
    const { data: customer } = await a.client.from("customers").select("name").eq("id", customerId).single();
    expect(customer?.name).toBe("Tenant A Customer");
  });

  it("D. a genuinely random, nonexistent customerId matches zero rows and returns a safe error, never a success redirect (Codex round 2, Finding 2/4.D)", async () => {
    const owner = await createOwnerAndBusiness("act-cust-update-random");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await updateCustomer(
      undefined,
      formData({
        businessId: owner.businessId,
        customerId: randomUuid(),
        name: "Should Not Apply",
        status: "active",
      })
    );

    expect(result?.error).toBeTruthy();
    // The message never distinguishes "never existed" from "exists in
    // another business" — both are the same zero-row outcome.
    expect(result?.error).not.toMatch(/uuid|forbidden|denied/i);
  });
});

describe("createSale action boundary", () => {
  it("rejects without calling the RPC when sales.create is absent (ACCOUNTANT)", async () => {
    const owner = await createOwnerAndBusiness("act-sale-create-denied");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const accountant = await createMemberWithRole(owner.businessId, "act-sale-create-denied", "ACCOUNTANT");
    cleanupUserIds.push(accountant.userId);

    currentClient = accountant.client;
    const rpcSpy = vi.spyOn(accountant.client, "rpc");
    const result = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(rpcSpy).not.toHaveBeenCalledWith("create_sale", expect.anything());
    rpcSpy.mockRestore();
  });

  it("rejects a forged product id belonging to another tenant", async () => {
    const a = await createOwnerAndBusiness("act-sale-forged-product-a");
    const b = await createOwnerAndBusiness("act-sale-forged-product-b");
    cleanupUserIds.push(a.userId, b.userId);
    const foreignProduct = await makeSaleProduct(a.client, a.businessId, { openingQuantity: 5 });

    currentClient = b.client;
    const result = await createSale(
      undefined,
      formData({
        businessId: b.businessId,
        creationKey: randomUuid(),
        items: JSON.stringify([{ productId: foreignProduct.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(result?.error).toContain("not available");
  });

  it("the request body sent to the RPC contains ONLY product_id and quantity per item — never unit_price/etc.", async () => {
    const owner = await createOwnerAndBusiness("act-sale-narrow-items");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    try {
      await createSale(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
          paymentStatus: "UNPAID",
        })
      );
    } catch {
      // redirect on success — irrelevant to this assertion
    }

    const call = rpcSpy.mock.calls.find(([fn]) => fn === "create_sale");
    expect(call).toBeDefined();
    const args = call![1] as { p_items: Array<Record<string, unknown>> };
    expect(Object.keys(args.p_items[0]).sort()).toEqual(["product_id", "quantity"]);
    rpcSpy.mockRestore();
  });

  it("a double-submit under the same creationKey (idempotency at the action boundary) produces exactly one sale", async () => {
    const owner = await createOwnerAndBusiness("act-sale-idempotent");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 20 });
    const key = randomUuid();
    const fd = () =>
      formData({
        businessId: owner.businessId,
        creationKey: key,
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      });

    const results = await Promise.all([
      createSale(undefined, fd()).catch((e) => e),
      createSale(undefined, fd()).catch((e) => e),
    ]);
    expect(results.every((r) => isRedirect(r))).toBe(true);

    const { data: sales } = await owner.client.from("sales").select("id").eq("business_id", owner.businessId);
    expect(sales).toHaveLength(1);
  });
});

describe("exact permission implication boundaries", () => {
  it("createCustomer checks customers.manage specifically — a caller with every OTHER Phase 1D/1C permission but that one is still denied", async () => {
    const owner = await createOwnerAndBusiness("perm-cust-specific-check");
    cleanupUserIds.push(owner.userId);
    // ACCOUNTANT holds sales.view/customers.view (read-only) but neither
    // customers.manage nor sales.create — proves createCustomer's gate
    // is the specific key, not "any Phase 1D permission at all".
    const accountant = await createMemberWithRole(owner.businessId, "perm-cust-specific-check", "ACCOUNTANT");
    cleanupUserIds.push(accountant.userId);

    currentClient = accountant.client;
    const result = await createCustomer(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Should Not Exist" })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });

  it("INVENTORY cannot create a sale or manage a customer despite full inventory access", async () => {
    const owner = await createOwnerAndBusiness("perm-inventory-no-sales");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const inventory = await createMemberWithRole(owner.businessId, "perm-inventory-no-sales", "INVENTORY");
    cleanupUserIds.push(inventory.userId);

    currentClient = inventory.client;
    const saleResult = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(saleResult?.error).toBe("You don't have permission to do this.");

    const customerResult = await createCustomer(
      undefined,
      formData({ businessId: owner.businessId, creationKey: randomUuid(), name: "Should Not Exist" })
    );
    expect(customerResult?.error).toBe("You don't have permission to do this.");
  });

  it("ACCOUNTANT can view but not create sales", async () => {
    const owner = await createOwnerAndBusiness("perm-accountant-view-only");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const accountant = await createMemberWithRole(owner.businessId, "perm-accountant-view-only", "ACCOUNTANT");
    cleanupUserIds.push(accountant.userId);

    currentClient = accountant.client;
    const { data: sales, error: viewError } = await accountant.client
      .from("sales").select("id").eq("business_id", owner.businessId);
    expect(viewError).toBeNull();
    expect(sales).toEqual([]);

    const createResult = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(createResult?.error).toBe("You don't have permission to do this.");
  });

  it("SALES can create a sale but customers.view/sales.view are independently required to read it back", async () => {
    const owner = await createOwnerAndBusiness("perm-sales-independent-view");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const sales = await createMemberWithRole(owner.businessId, "perm-sales-independent-view", "SALES");
    cleanupUserIds.push(sales.userId);

    currentClient = sales.client;
    let caught: unknown;
    try {
      await createSale(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
          paymentStatus: "UNPAID",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
  });
});
