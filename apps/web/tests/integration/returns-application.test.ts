import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct } from "./helpers/sales";
import { createBranch, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1I application layer — exercises the REAL Server Actions
// (lib/returns/actions.ts) against a real database, mirroring
// invoice-application.test.ts's own exact hybrid technique: redirect()
// throws a real NEXT_REDIRECT-digest error even outside a request,
// caught here as proof of success.
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createSaleReturn, searchReturnableSalesAction, getReturnableSaleItemsAction } = await import(
  "@/lib/returns/actions"
);
const { listReturns, getReturn, getReturnItems, getReturnsBranchFilterOptions } = await import("@/lib/returns/dal");

function isRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

function redirectUrl(e: unknown): string | undefined {
  if (!isRedirect(e)) return undefined;
  return (e as { digest: string }).digest.split(";").slice(2, -2).join(";");
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

async function createCompletedSale(
  client: SupabaseClient<Database>,
  businessId: string,
  overrides: {
    quantity?: number;
    sellingPrice?: number;
    branchId?: string;
    amountPaid?: number;
    // The product is always created via `client` — a separate seller
    // (e.g. a Branch-B-only creator with sales.create but no
    // products.manage) issues the SALE itself via this override instead.
    saleClient?: SupabaseClient<Database>;
    trackInventory?: boolean;
  } = {}
) {
  const product = await makeSaleProduct(client, businessId, {
    sellingPrice: overrides.sellingPrice ?? 1000,
    trackInventory: overrides.trackInventory,
  });
  const saleClient = overrides.saleClient ?? client;
  const { data: saleId, error } = await saleClient.rpc("create_sale", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_items: [{ product_id: product.id, quantity: overrides.quantity ?? 5 }],
    p_payment_status: "PAID",
    p_payment_method: "CASH",
    p_branch_id: overrides.branchId,
  });
  if (error || !saleId) throw new Error(`fixture sale creation failed: ${error?.message}`);
  const { data: saleItems } = await client.from("sale_items").select("id").eq("sale_id", saleId as string);
  return { saleId: saleId as string, saleItemId: saleItems![0].id as string, product };
}

describe("createSaleReturn — application layer", () => {
  it("a well-formed request succeeds, redirects to the detail page, and is readable afterward with the correct snapshot", async () => {
    const owner = await createOwnerAndBusiness("app-ret-create");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 5 });

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createSaleReturn(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          saleId,
          items: JSON.stringify([{ saleItemId, quantity: "2", restock: true }]),
          refundAmount: "0",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
    expect(redirectUrl(caught)).toContain(`/${owner.businessId}/returns/`);

    const { data: returns } = await owner.client.from("sale_returns").select("id, sale_id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
  });

  it("a caller without returns.manage is denied — no redirect, a controlled error instead", async () => {
    const owner = await createOwnerAndBusiness("app-ret-unauthorized");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-ret-unauthorized", ["returns.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "1", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.error).toContain("permission");
  });

  it("returns.manage WITHOUT returns.view still gets a complete, usable create flow — redirected to an accessible success state, never the unauthorized detail page", async () => {
    const owner = await createOwnerAndBusiness("app-ret-manage-only");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 3 });
    // Deliberately WITHOUT returns.view, sales.view, sales.create,
    // inventory.view, inventory.adjust, branches.view — returns.manage
    // must be entirely self-contained.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-ret-manage-only", ["returns.manage"]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    let caught: unknown;
    try {
      await createSaleReturn(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          saleId,
          items: JSON.stringify([{ saleItemId, quantity: "1", restock: true }]),
          refundAmount: "0",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
    // Never the detail page (returns.view-gated, would 404 them) — the
    // accessible fallback with the generic success banner.
    expect(redirectUrl(caught)).toBe(`/${owner.businessId}/returns/new?created=1`);

    // The return really was created, and the manage-only caller genuinely
    // cannot read it back through the normal list/detail path.
    const { data: viaAdmin } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(viaAdmin).toHaveLength(1);
    const { data: viaWorker } = await worker.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(viaWorker ?? []).toHaveLength(0);
  });

  it("a wrong-branch returns.manage caller cannot select or create a return for an inaccessible sale", async () => {
    const owner = await createOwnerAndBusiness("app-ret-wrong-branch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "App Ret Branch B" });
    // The OWNER cannot self-assign to a non-default branch (the frozen
    // CANNOT_MANAGE_SELF invariant) — a separate creator, assigned to
    // Branch B, makes the fixture sale there instead.
    const creator = await createMemberWithCustomPermissions(owner.businessId, "app-ret-wrong-branch-creator", [
      "sales.create",
    ]);
    cleanupUserIds.push(creator.userId);
    const creatorMemberId = await getMemberId(owner.businessId, creator.userId);
    await assignMemberToBranch(owner.client, owner.businessId, creatorMemberId, [branchB]);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, {
      quantity: 3,
      branchId: branchB,
      saleClient: creator.client,
      trackInventory: false,
    });
    // Assigned only to the DEFAULT branch (A), not Branch B.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-ret-wrong-branch", ["returns.manage"]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    const itemsResult = await getReturnableSaleItemsAction(owner.businessId, saleId);
    expect(itemsResult.ok).toBe(false);
    if (!itemsResult.ok) {
      expect(itemsResult.error).toBe("The sale is no longer available for return.");
    }

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "1", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.saleId?.[0]).toBe("The sale is no longer available for return.");

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(0);
  });

  it("a malformed (non-empty) businessId never reaches getPermissions or the RPC", async () => {
    const owner = await createOwnerAndBusiness("app-ret-malformed-business");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: "not-a-uuid",
        creationKey: randomUuid(),
        saleId: randomUuid(),
        items: JSON.stringify([]),
        refundAmount: "0",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(result?.fieldErrors).toBeUndefined();
  });

  it("a malformed saleId is rejected as a controlled field error", async () => {
    const owner = await createOwnerAndBusiness("app-ret-malformed-sale");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId: "not-a-uuid",
        items: JSON.stringify([{ saleItemId: randomUuid(), quantity: "1", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.saleId).toBeTruthy();
  });

  it("a malformed sale_item id inside the items array is rejected as a controlled field error", async () => {
    const owner = await createOwnerAndBusiness("app-ret-malformed-item");
    cleanupUserIds.push(owner.userId);
    const { saleId } = await createCompletedSale(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId: "not-a-uuid", quantity: "1", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.items).toBeTruthy();
  });

  it("a malformed items JSON blob fails as a controlled field error, never a thrown parse exception", async () => {
    const owner = await createOwnerAndBusiness("app-ret-bad-json");
    cleanupUserIds.push(owner.userId);
    const { saleId } = await createCompletedSale(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: "{not valid json",
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.items).toBeTruthy();
  });

  it("strict unknown-field rejection: a forged snapshot field smuggled into an item is rejected, never silently dropped-and-accepted or forwarded to the RPC", async () => {
    const owner = await createOwnerAndBusiness("app-ret-forged-field");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([
          { saleItemId, quantity: "1", restock: true, productNameSnapshot: "Forged", unitPriceSnapshot: "1" },
        ]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.items).toBeTruthy();
    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(0);
  });

  it("quantity precision: more than 3 decimal places is rejected as a controlled field error before any RPC call", async () => {
    const owner = await createOwnerAndBusiness("app-ret-qty-precision");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "1.2345", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.items).toBeTruthy();
  });

  it("refund precision: more than 2 decimal places is rejected as a controlled field error", async () => {
    const owner = await createOwnerAndBusiness("app-ret-refund-precision");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "1", restock: true }]),
        refundAmount: "1.999",
        refundMethod: "CASH",
      })
    );
    expect(result?.fieldErrors?.refundAmount).toBeTruthy();
  });

  it("safe DB error mapping: an over-return quantity surfaces a controlled message, never a raw SQLSTATE", async () => {
    const owner = await createOwnerAndBusiness("app-ret-safe-mapping-qty");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 2 });
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "3", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.fieldErrors?.items?.[0]).toBe("One or more items exceed the quantity available to return.");
  });

  it("safe DB error mapping: a refund exceeding the sale's amount_paid surfaces a controlled message", async () => {
    const owner = await createOwnerAndBusiness("app-ret-safe-mapping-refund");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, {
      quantity: 1,
      sellingPrice: 100,
    });
    currentClient = owner.client;

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "1", restock: true }]),
        refundAmount: "500",
        refundMethod: "CASH",
      })
    );
    expect(result?.fieldErrors?.refundAmount?.[0]).toBe("The refund amount is more than this sale can refund.");
  });

  it("idempotency: an exact retry with the same creation key returns the same result (no second Server Action-level mutation)", async () => {
    const owner = await createOwnerAndBusiness("app-ret-idempotent");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 5 });
    currentClient = owner.client;
    const creationKey = randomUuid();
    const fields = {
      businessId: owner.businessId,
      creationKey,
      saleId,
      items: JSON.stringify([{ saleItemId, quantity: "2", restock: true }]),
      refundAmount: "0",
    };

    let first: unknown;
    try {
      await createSaleReturn(undefined, formData(fields));
    } catch (e) {
      first = e;
    }
    let second: unknown;
    try {
      await createSaleReturn(undefined, formData(fields));
    } catch (e) {
      second = e;
    }
    expect(isRedirect(first)).toBe(true);
    expect(isRedirect(second)).toBe(true);
    expect(redirectUrl(first)).toBe(redirectUrl(second));

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
  });

  it("idempotency: the same creation key with a changed payload surfaces a controlled conflict message", async () => {
    const owner = await createOwnerAndBusiness("app-ret-idempotent-conflict");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 5 });
    currentClient = owner.client;
    const creationKey = randomUuid();

    try {
      await createSaleReturn(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey,
          saleId,
          items: JSON.stringify([{ saleItemId, quantity: "2", restock: true }]),
          refundAmount: "0",
        })
      );
    } catch {
      // expected redirect
    }

    const result = await createSaleReturn(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey,
        saleId,
        items: JSON.stringify([{ saleItemId, quantity: "3", restock: true }]),
        refundAmount: "0",
      })
    );
    expect(result?.error).toContain("already have been created");
  });

  it("no caller snapshots reach storage: product name/price stored on the return item are the REAL, server-derived values, never the caller's own submitted item fields", async () => {
    const owner = await createOwnerAndBusiness("app-ret-no-forged-snapshot");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId, product } = await createCompletedSale(owner.client, owner.businessId, {
      quantity: 2,
      sellingPrice: 750,
    });
    currentClient = owner.client;

    let caught: unknown;
    try {
      await createSaleReturn(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          saleId,
          items: JSON.stringify([{ saleItemId, quantity: "1", restock: false }]),
          refundAmount: "0",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: items } = await owner.client
      .from("sale_return_items")
      .select("product_name_snapshot, unit_price_snapshot, product_id")
      .eq("sale_item_id", saleItemId);
    expect(items).toHaveLength(1);
    expect(items![0].product_id).toBe(product.id);
    expect(Number(items![0].unit_price_snapshot)).toBe(750);
  });
});

describe("searchReturnableSalesAction — permission independence", () => {
  it("returns.manage alone (no sales.view) can find an eligible sale", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-manage-only");
    cleanupUserIds.push(owner.userId);
    const { saleId } = await createCompletedSale(owner.client, owner.businessId);
    const { data: saleRow } = await owner.client.from("sales").select("sale_number").eq("id", saleId).single();
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-ret-search-manage-only", [
      "returns.manage",
    ]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    const results = await searchReturnableSalesAction(owner.businessId, saleRow!.sale_number as string);
    expect(results.some((r) => r.id === saleId)).toBe(true);
  });

  it("a caller with sales.view but no returns.manage gets no results", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-no-manage");
    cleanupUserIds.push(owner.userId);
    const { saleId } = await createCompletedSale(owner.client, owner.businessId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-ret-search-no-manage", [
      "sales.view",
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const results = await searchReturnableSalesAction(owner.businessId, "");
    expect(results.some((r) => r.id === saleId)).toBe(false);
  });

  it("a malformed businessId returns an empty result, never a thrown error", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-malformed");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const results = await searchReturnableSalesAction("not-a-uuid", "");
    expect(results).toEqual([]);
  });
});

describe("returns DAL — permission and tenant scope", () => {
  it("listReturns/getReturn/getReturnItems/getReturnsBranchFilterOptions work for a returns.view-only caller", async () => {
    const owner = await createOwnerAndBusiness("app-ret-dal-view");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 2 });
    const { data: returnId } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: false }],
      p_refund_amount: 0,
    });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-ret-dal-view", ["returns.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const { rows } = await listReturns(owner.businessId, {});
    expect(rows.some((r) => r.id === returnId)).toBe(true);

    const detail = await getReturn(owner.businessId, returnId as string);
    expect(detail.id).toBe(returnId);

    const items = await getReturnItems(owner.businessId, returnId as string);
    expect(items).toHaveLength(1);

    const branches = await getReturnsBranchFilterOptions(owner.businessId);
    expect(branches.length).toBeGreaterThan(0);
  });

  // list_returns_for_viewer (unlike a plain PostgREST select) is itself
  // authorized on returns.view — a caller without it gets a hard
  // rejection from the RPC, never a silently-empty RLS-scoped result.
  // The real protection against an unauthorized caller ever reaching this
  // call at all is the LIST PAGE's own requirePermissionOrNotFound gate
  // (app/[businessId]/returns/page.tsx) — this test documents the DAL
  // function's own actual contract, which the page's gate makes
  // unreachable in normal use.
  it("a caller without returns.view is rejected by listReturns — the RPC's own authorization, never inferred from a silently-empty RLS-scoped result", async () => {
    const owner = await createOwnerAndBusiness("app-ret-dal-no-view");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 2 });
    await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: false }],
      p_refund_amount: 0,
    });
    const stranger = await createMemberWithCustomPermissions(owner.businessId, "app-ret-dal-no-view", ["sales.view"]);
    cleanupUserIds.push(stranger.userId);

    currentClient = stranger.client;
    // Codex security review, SEC-02: listReturns now throws a GENERIC
    // message on any RPC error — including this authorization failure —
    // never the raw `insufficient_privilege`/SQLSTATE detail. The
    // rejection itself (never a silently-empty result) is still the
    // property under test here.
    await expect(listReturns(owner.businessId, {})).rejects.toThrow("Unable to load returns.");
  });
});

// Codex application-layer security review, SEC-01 — unbounded returns-list
// search. Two independent boundaries are proven: the APPLICATION's own
// truncation before RPC dispatch (listReturns, lib/returns/dal.ts), and
// the RPC's own INDEPENDENT truncation
// (list_returns_for_viewer, 20260902080000_returns_application_picker_rpcs.sql)
// — since that RPC is directly callable by any authenticated caller,
// bypassing the DAL entirely.
describe("listReturns / list_returns_for_viewer — SEC-01 search bound", () => {
  it("the APPLICATION boundary sends the RPC no more than 200 characters, even when the caller passes 500+", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-bound-app");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    const longSearch = "a".repeat(500);
    await listReturns(owner.businessId, { search: longSearch });

    const call = rpcSpy.mock.calls.find((c) => c[0] === "list_returns_for_viewer");
    expect(call).toBeTruthy();
    const sentSearch = (call![1] as { p_search?: string }).p_search;
    expect(sentSearch).toBeTruthy();
    expect(sentSearch!.length).toBeLessThanOrEqual(200);
    expect(sentSearch).toBe(longSearch.slice(0, 200));
    rpcSpy.mockRestore();
  });

  it("undefined search stays undefined — never coerced into an empty or truncated string", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-bound-undefined");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    await listReturns(owner.businessId, {});
    const call = rpcSpy.mock.calls.find((c) => c[0] === "list_returns_for_viewer");
    expect((call![1] as { p_search?: string }).p_search).toBeUndefined();
    rpcSpy.mockRestore();
  });

  it("a DIRECT authenticated RPC call with a 500+ character p_search is safely bounded — never a crash, never unbounded processing", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-bound-direct");
    cleanupUserIds.push(owner.userId);

    // Bypasses the application DAL entirely — calls the RPC exactly as
    // any authenticated caller could via supabase.rpc(...) directly.
    const { data, error } = await owner.client.rpc("list_returns_for_viewer", {
      p_business_id: owner.businessId,
      p_search: "b".repeat(100_000),
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("the deployed RPC's own source truncates p_search to 200 characters BEFORE wildcard-escaping — a structural regression guard", async () => {
    const sql = createTestDbClient();
    try {
      const [row] = await sql<{ definition: string }[]>`
        select pg_get_functiondef('public.list_returns_for_viewer'::regproc) as definition
      `;
      // Asserts the actual deployed function body contains the
      // truncation call, and that it appears BEFORE the wildcard-escape
      // (replace(...)) logic — never after an expensive pattern has
      // already been built from the untruncated input.
      const truncateIndex = row.definition.indexOf("left(p_search, 200)");
      const escapeIndex = row.definition.indexOf("replace(replace(replace(btrim(v_search)");
      expect(truncateIndex).toBeGreaterThan(-1);
      expect(escapeIndex).toBeGreaterThan(-1);
      expect(truncateIndex).toBeLessThan(escapeIndex);
    } finally {
      await sql.end();
    }
  });

  it("wildcard escaping (%, _, \\) is unchanged for list_returns_for_viewer", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-wildcard");
    cleanupUserIds.push(owner.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 2 });
    const { data: returnId } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: false }],
      p_refund_amount: 0,
    });
    const { data: returnRow } = await owner.client
      .from("sale_returns")
      .select("return_number")
      .eq("id", returnId as string)
      .single();

    // A literal `%`/`_`/`\` in the search term must never act as an SQL
    // wildcard/escape character — searching for one directly (absent from
    // every real return_number, which is always `RET-######`) must match
    // NOTHING, proving these are escaped rather than passed through raw.
    for (const literal of ["%", "_", "\\"]) {
      const { rows } = await listReturnsAs(owner.client, owner.businessId, literal);
      expect(rows.some((r) => r.id === returnId)).toBe(false);
    }

    // A genuine substring of the real return number still matches.
    const { rows: realMatch } = await listReturnsAs(
      owner.client,
      owner.businessId,
      (returnRow!.return_number as string).slice(0, 6)
    );
    expect(realMatch.some((r) => r.id === returnId)).toBe(true);
  });

  it("tenant scope, permission gate, and empty-search behavior are unchanged by the SEC-01 fix", async () => {
    const owner = await createOwnerAndBusiness("app-ret-search-tenant-a");
    cleanupUserIds.push(owner.userId);
    const other = await createOwnerAndBusiness("app-ret-search-tenant-b");
    cleanupUserIds.push(other.userId);
    const { saleId, saleItemId } = await createCompletedSale(owner.client, owner.businessId, { quantity: 2 });
    const { data: returnId } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: false }],
      p_refund_amount: 0,
    });

    // Empty search: unchanged — returns the full (unfiltered) page.
    currentClient = owner.client;
    const { rows: unfiltered } = await listReturns(owner.businessId, {});
    expect(unfiltered.some((r) => r.id === returnId)).toBe(true);

    // No cross-business enumeration: business B's own caller, searching
    // ITS OWN (nonexistent) business for business A's real return number,
    // sees nothing — tenant scope is still enforced by p_business_id,
    // regardless of search content or length.
    const { data: returnRow } = await owner.client.from("sale_returns").select("return_number").eq("id", returnId as string).single();
    currentClient = other.client;
    const { rows: crossTenant } = await listReturns(other.businessId, { search: returnRow!.return_number as string });
    expect(crossTenant).toHaveLength(0);
  });
});

async function listReturnsAs(client: SupabaseClient<Database>, businessId: string, search: string) {
  const { data, error } = await client.rpc("list_returns_for_viewer", { p_business_id: businessId, p_search: search });
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as { id: string }[] };
}
