import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct } from "./helpers/sales";
import { createBranch, getBranchLocationId, assignMemberToBranch, getMemberId, getDefaultBranchId } from "./helpers/staff";
import { PERMISSION } from "@/lib/business/constants";

// Phase 1G application layer — exercises the REAL Server Actions and DAL
// functions this round added (lib/branches/dal.ts's getOperationalBranchOptions,
// lib/inventory/dal.ts's getBranchCanonicalLocation, and every action that
// now resolves/sends a branch) against a real database, using realistic
// role/branch fixtures — never a mocked RPC. Same hybrid technique as
// customer-sale-action-auth.test.ts: redirect() throws a real
// NEXT_REDIRECT-digest error even outside a request, caught here as proof
// of success.
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

const { createSale, getSaleProductAvailabilityAction } = await import("@/lib/sales/actions");
const { createProduct } = await import("@/lib/products/actions");
const { adjustStock } = await import("@/lib/inventory/actions");
const { createExpense } = await import("@/lib/expenses/actions");
const {
  getOperationalBranchOptions,
  listExpenseBranchOptions,
  listReportBranchOptions,
  listSalesFilterBranchOptions,
  listInventoryFilterBranchOptions,
} = await import("@/lib/branches/dal");
const { getBranchCanonicalLocation, getLocationsForBranch, getInventoryOverview } = await import("@/lib/inventory/dal");
const { searchProductsForSale, listSales } = await import("@/lib/sales/dal");
const { getFinancialSummary } = await import("@/lib/reports/dal");

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

describe("getOperationalBranchOptions — the shared branch-option DAL", () => {
  it("a Branch-B-only member sees ONLY Branch B, marked primary — never the business default they have no access to", async () => {
    const owner = await createOwnerAndBusiness("app-branch-options");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    // branches.view deliberately OMITTED — getOperationalBranchOptions now
    // resolves through public.get_business_branch_options' "operations"
    // scope (supabase/migrations/20260830080000_branch_option_rpc.sql),
    // authorized on sales.create/products.manage/inventory.adjust alone,
    // never branches.view. See the next test for the direct proof.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-branch-options", [
      PERMISSION.SALES_CREATE,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    currentClient = worker.client;
    const { options, primaryBranchId } = await getOperationalBranchOptions(owner.businessId);

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe(branchB);
    expect(options[0].isPrimary).toBe(true);
    expect(primaryBranchId).toBe(branchB);
  });

  // Codex adversarial review, application-layer round 3 — this test
  // FORMERLY documented a confirmed, open database-contract gap
  // ([KNOWN DB-CONTRACT GAP], Blocker 1 of round 2): business_branches'
  // own SELECT RLS policy is gated on branches.view alone, so reading
  // branch names through an embedded business_member_branches ->
  // business_branches join (the OLD implementation of
  // getOperationalBranchOptions) silently returned zero usable options
  // for a sales.create-only member with a REAL branch assignment but no
  // branches.view. That gap is now closed: getOperationalBranchOptions
  // resolves through public.get_business_branch_options' "operations"
  // scope (supabase/migrations/20260830080000_branch_option_rpc.sql),
  // which is SECURITY DEFINER and authorizes directly on
  // sales.create/products.manage/inventory.adjust — never branches.view —
  // so this is now a normal, PASSING contract test rather than a
  // documented gap.
  it("a sales.create member WITHOUT branches.view still resolves real branch names for a real branch assignment", async () => {
    const owner = await createOwnerAndBusiness("app-branch-options-no-view");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-branch-options-no-view", [
      PERMISSION.SALES_CREATE,
      // branches.view is deliberately OMITTED — no real seeded role is
      // ever configured this way, but a hand-built custom role could be,
      // and the fix must not depend on it.
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    currentClient = worker.client;
    const { options, primaryBranchId } = await getOperationalBranchOptions(owner.businessId);

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe(branchB);
    expect(options[0].name).toBe("Branch B");
    expect(options[0].isPrimary).toBe(true);
    expect(primaryBranchId).toBe(branchB);
  });

  it("a member with no active branch assignment at all gets zero options and no primary — the controlled blocked state, not a broken empty dropdown", async () => {
    const owner = await createOwnerAndBusiness("app-branch-options-none");
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-branch-options-none", [
      PERMISSION.SALES_CREATE,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, []).catch(() => {
      // replace_member_branches rejects an empty assignment outright
      // (INVALID_BRANCH_ASSIGNMENT) — this fixture instead removes the
      // assignment directly, the same reconstructed state
      // branch-aware-sales.test.ts's own "no primary branch" test uses.
    });
    const { createTestDbClient } = await import("./helpers/db-client");
    const sql = createTestDbClient();
    try {
      await sql`delete from public.business_member_branches where member_id = ${workerMemberId}`;
    } finally {
      await sql.end();
    }

    currentClient = worker.client;
    const { options, primaryBranchId } = await getOperationalBranchOptions(owner.businessId);
    expect(options).toHaveLength(0);
    expect(primaryBranchId).toBeNull();
  });

  it("an inactive branch the member is still assigned to is excluded — assignment alone is never enough for new operational activity", async () => {
    const owner = await createOwnerAndBusiness("app-branch-options-inactive");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Deactivating Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-branch-options-inactive", [
      PERMISSION.SALES_CREATE,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    currentClient = worker.client;
    const { options } = await getOperationalBranchOptions(owner.businessId);
    expect(options).toHaveLength(0);
  });
});

describe("createSale — application layer branch handling", () => {
  it("a Branch-B-only SALES member's explicit branch selection reaches the RPC and is recorded", async () => {
    const owner = await createOwnerAndBusiness("app-sale-branchb");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "app-sale-branchb", [
      PERMISSION.SALES_CREATE,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchB]);

    currentClient = seller.client;
    let caught: unknown;
    try {
      await createSale(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          branchId: branchB,
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
          paymentStatus: "UNPAID",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: sale } = await owner.client
      .from("sales")
      .select("branch_id, branch_name_snapshot")
      .eq("business_id", owner.businessId)
      .single();
    expect(sale!.branch_id).toBe(branchB);
    expect(sale!.branch_name_snapshot).toBe("Branch B");
  });

  it("an explicit, inaccessible branch is denied with a safe, generic message — never a raw insufficient_privilege/SQL code", async () => {
    const owner = await createOwnerAndBusiness("app-sale-inaccessible");
    cleanupUserIds.push(owner.userId);
    const branchC = await createBranch(owner.client, owner.businessId, { name: "No Access Branch" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "app-sale-inaccessible", [
      PERMISSION.SALES_CREATE,
    ]);
    cleanupUserIds.push(seller.userId);
    // seller keeps only their default-branch assignment — never Branch C.

    currentClient = seller.client;
    const result = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        branchId: branchC,
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
    expect(result?.error).not.toMatch(/insufficient_privilege|42501|sqlstate/i);
  });

  it("a cross-tenant branch id (real branch, different business) is denied, never leaking its existence via a distinct message", async () => {
    const owner = await createOwnerAndBusiness("app-sale-cross-a");
    const stranger = await createOwnerAndBusiness("app-sale-cross-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });

    currentClient = owner.client;
    const result = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        branchId: strangerBranchId,
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(result?.error).toBe("This branch is not available.");
  });

  it("a malformed branchId never reaches the RPC — a controlled field error instead", async () => {
    const owner = await createOwnerAndBusiness("app-sale-malformed-branch");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });

    currentClient = owner.client;
    const rpcSpy = vi.spyOn(owner.client, "rpc");
    const result = await createSale(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        branchId: "not-a-uuid",
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        paymentStatus: "UNPAID",
      })
    );
    expect(result?.fieldErrors?.branchId).toBeDefined();
    expect(rpcSpy).not.toHaveBeenCalledWith("create_sale", expect.anything());
    rpcSpy.mockRestore();
  });
});

// Codex adversarial review, application-layer round 2, Blocker 2:
// searchProductsForSale's availability figure must reflect the SELECTED
// branch's own canonical location — the exact location create_sale
// itself deducts from — never a business-wide sum across every location.
describe("searchProductsForSale — branch-specific stock availability (Blocker 2)", () => {
  it("Branch A stock 5, Branch B stock 0 — selecting Branch B shows availability 0, never Branch A's 5", async () => {
    const owner = await createOwnerAndBusiness("app-sale-stock-branch");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchALocationId = await getBranchLocationId(owner.businessId, branchA);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    // Opening stock always lands at the DEFAULT branch's own canonical
    // location (create_product's own unchanged omitted-location
    // behavior) — Branch B genuinely has zero balance rows at all, not
    // merely a zero-quantity row.
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    currentClient = owner.client;
    const branchAResults = await searchProductsForSale(owner.businessId, { locationId: branchALocationId });
    const branchBResults = await searchProductsForSale(owner.businessId, { locationId: branchBLocationId });

    const branchAProduct = branchAResults.find((p) => p.id === product.id);
    const branchBProduct = branchBResults.find((p) => p.id === product.id);
    expect(branchAProduct?.quantity).toBe(5);
    // The product must still APPEAR (a left embed, not an inner join) —
    // just with zero availability at Branch B, never omitted from the
    // picker entirely and never showing Branch A's own figure.
    expect(branchBProduct).toBeDefined();
    expect(branchBProduct?.quantity).toBe(0);
  });

  it("omitting locationId falls back to the business-wide sum (pre-branch-selection display only)", async () => {
    const owner = await createOwnerAndBusiness("app-sale-stock-no-branch");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    currentClient = owner.client;
    const results = await searchProductsForSale(owner.businessId);
    expect(results.find((p) => p.id === product.id)?.quantity).toBe(5);
  });
});

// Codex adversarial review, application-layer round 3, Medium 1: a sale
// line already added to the cart captured its availableQuantity at ADD
// time and never refreshed it when the selected branch later changed.
// getSaleProductAvailabilityAction (lib/sales/actions.ts) is the batched
// re-fetch the sale form now calls on every branch change — these tests
// exercise it directly, independent of the browser-level reproduction in
// tests/e2e/branch-aware-workflows.spec.ts.
describe("getSaleProductAvailabilityAction — batched re-fetch after a branch change (Blocker: stale sale-line stock)", () => {
  it("Branch A stock 5, Branch B stock 0 — a batch re-fetch for the SAME product id returns each branch's own figure", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-refresh");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Refresh Branch B" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    currentClient = owner.client;
    const atBranchA = await getSaleProductAvailabilityAction(owner.businessId, [product.id], branchA);
    expect(atBranchA.find((p) => p.id === product.id)?.quantity).toBe(5);

    const atBranchB = await getSaleProductAvailabilityAction(owner.businessId, [product.id], branchB);
    // Branch B never received any stock at all — this must never echo
    // back Branch A's own 5.
    expect(atBranchB.find((p) => p.id === product.id)?.quantity).toBe(0);
  });

  it("batches multiple product ids in one call — every line's own figure is returned, not just the first", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-batch");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const productX = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 3 });
    const productY = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 7 });

    currentClient = owner.client;
    const results = await getSaleProductAvailabilityAction(owner.businessId, [productX.id, productY.id], branchA);
    expect(results.find((p) => p.id === productX.id)?.quantity).toBe(3);
    expect(results.find((p) => p.id === productY.id)?.quantity).toBe(7);
  });

  it("a caller without sales.create gets an empty result, never another business's/branch's stock", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-denied");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-sale-avail-denied", [
      PERMISSION.SALES_VIEW,
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const results = await getSaleProductAvailabilityAction(owner.businessId, [product.id], branchA);
    expect(results).toHaveLength(0);
  });

  it("an empty productIds array short-circuits to an empty result without querying", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-empty");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = owner.client;
    const results = await getSaleProductAvailabilityAction(owner.businessId, [], branchA);
    expect(results).toHaveLength(0);
  });

  // Codex adversarial review, application-layer round 3, Low 1:
  // productIds is client-controlled and previously reached
  // searchProductsForSale's raw `.in("id", productIds)` uuid-column query
  // completely unvalidated. SaleProductIdsSchema (lib/validation/sales.ts)
  // is what now stands between it and Postgres — these tests prove a
  // malformed id never reaches the database at all (never a thrown
  // Postgres uuid-syntax error), and that duplicates are handled safely.
  it("a malformed product id is rejected before ever reaching Postgres — resolves to an empty result, never a thrown DB error", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-malformed");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);

    currentClient = owner.client;
    // "not-a-real-uuid" would surface as a raw 22P02 invalid-input-syntax
    // error if it ever reached a uuid-column `.in()` filter directly —
    // asserting the call resolves (never rejects) is the proof it didn't.
    await expect(
      getSaleProductAvailabilityAction(owner.businessId, ["not-a-real-uuid"], branchA)
    ).resolves.toEqual([]);
  });

  it("a mixed array of one valid and one malformed product id is rejected WHOLESALE — never silently narrowed to just the valid one", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-mixed");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    currentClient = owner.client;
    const results = await getSaleProductAvailabilityAction(
      owner.businessId,
      [product.id, "still-not-a-real-uuid"],
      branchA
    );
    // Not "the valid product's own row, with the bad one dropped" — the
    // whole batch is treated as invalid input, exactly like the
    // all-malformed case above.
    expect(results).toHaveLength(0);
  });

  it("duplicate valid product ids are deduplicated before querying — the product still appears exactly once", async () => {
    const owner = await createOwnerAndBusiness("app-sale-avail-duplicate");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 5 });

    currentClient = owner.client;
    const results = await getSaleProductAvailabilityAction(
      owner.businessId,
      [product.id, product.id, product.id],
      branchA
    );
    expect(results.filter((r) => r.id === product.id)).toHaveLength(1);
    expect(results.find((r) => r.id === product.id)?.quantity).toBe(5);
  });
});

describe("createProduct — opening-stock branch resolution", () => {
  it("zero/absent opening stock requires no branch at all", async () => {
    const owner = await createOwnerAndBusiness("app-product-no-stock");
    cleanupUserIds.push(owner.userId);

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createProduct(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          name: "No Opening Stock",
          sku: `sku-${randomUuid()}`,
          sellingPrice: "100",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
  });

  it("a Branch-B-only member's positive opening stock resolves to Branch B's own canonical location", async () => {
    const owner = await createOwnerAndBusiness("app-product-branchb");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-product-branchb", [
      PERMISSION.PRODUCTS_MANAGE,
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    currentClient = worker.client;
    let caught: unknown;
    try {
      const result = await createProduct(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          name: "Branch B Stock Product",
          sku: `sku-${randomUuid()}`,
          sellingPrice: "100",
          trackInventory: "on",
          openingQuantity: "5",
          branchId: branchB,
        })
      );
      caught = result;
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught), JSON.stringify(caught)).toBe(true);

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity, inventory_location_id")
      .eq("business_id", owner.businessId)
      .single();
    expect(balance!.inventory_location_id).toBe(branchBLocationId);
    expect(Number(balance!.quantity)).toBe(5);
  });

  it("an inaccessible explicit branch for opening stock is denied", async () => {
    const owner = await createOwnerAndBusiness("app-product-inaccessible");
    cleanupUserIds.push(owner.userId);
    const branchC = await createBranch(owner.client, owner.businessId, { name: "No Access Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-product-inaccessible", [
      PERMISSION.PRODUCTS_MANAGE,
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
    ]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    const result = await createProduct(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        name: "Should Not Get Stock",
        sku: `sku-${randomUuid()}`,
        sellingPrice: "100",
        openingQuantity: "5",
        branchId: branchC,
      })
    );
    expect(result?.error).toBe("You don't have permission to do this.");
  });
});

describe("adjustStock — application layer branch resolution", () => {
  it("a Branch-B-only INVENTORY member's adjustment lands on Branch B's own canonical location", async () => {
    const owner = await createOwnerAndBusiness("app-adjust-branchb");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-adjust-branchb", [
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    currentClient = worker.client;
    let caught: unknown;
    try {
      await adjustStock(
        undefined,
        formData({
          businessId: owner.businessId,
          idempotencyKey: randomUuid(),
          productId: product.id,
          branchId: branchB,
          direction: "increase",
          quantity: "3",
          reason: "Branch B stock count",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("inventory_location_id", branchBLocationId)
      .single();
    expect(Number(balance!.quantity)).toBe(3);
  });

  it("getBranchCanonicalLocation resolves the exact canonical location for a real branch, and null for a foreign/nonexistent one", async () => {
    const owner = await createOwnerAndBusiness("app-canonical-location");
    const stranger = await createOwnerAndBusiness("app-canonical-location-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

    currentClient = owner.client;
    const resolved = await getBranchCanonicalLocation(owner.businessId, branchB);
    expect(resolved?.id).toBe(branchBLocationId);

    const foreign = await getBranchCanonicalLocation(owner.businessId, strangerBranchId);
    expect(foreign).toBeNull();

    const nonexistent = await getBranchCanonicalLocation(owner.businessId, crypto.randomUUID());
    expect(nonexistent).toBeNull();
  });
});

describe("createExpense — company-wide vs branch-attributed", () => {
  it("omitting branchId records a genuinely company-wide expense (branch_id and branch_name_snapshot both null)", async () => {
    const owner = await createOwnerAndBusiness("app-expense-company-wide");
    cleanupUserIds.push(owner.userId);
    const sql = await import("./helpers/db-client").then((m) => m.createTestDbClient());
    let categoryId: string;
    try {
      const [category] = await sql<{ id: string }[]>`
        select id from public.expense_categories where business_id = ${owner.businessId} limit 1
      `;
      categoryId = category.id;
    } finally {
      await sql.end();
    }

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "500",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: expense } = await owner.client
      .from("expenses")
      .select("branch_id, branch_name_snapshot")
      .eq("business_id", owner.businessId)
      .single();
    expect(expense!.branch_id).toBeNull();
    expect(expense!.branch_name_snapshot).toBeNull();
  });

  it("an explicit branch, even one the caller has no operational access to, is accepted — expenses.manage alone is the gate, never has_branch_access", async () => {
    const owner = await createOwnerAndBusiness("app-expense-any-branch");
    cleanupUserIds.push(owner.userId);
    const branchC = await createBranch(owner.client, owner.businessId, { name: "Accounting-Only Branch" });
    const sql = await import("./helpers/db-client").then((m) => m.createTestDbClient());
    let categoryId: string;
    try {
      const [category] = await sql<{ id: string }[]>`
        select id from public.expense_categories where business_id = ${owner.businessId} limit 1
      `;
      categoryId = category.id;
    } finally {
      await sql.end();
    }

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "750",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
          branchId: branchC,
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: expense } = await owner.client
      .from("expenses")
      .select("branch_id, branch_name_snapshot")
      .eq("business_id", owner.businessId)
      .single();
    expect(expense!.branch_id).toBe(branchC);
    expect(expense!.branch_name_snapshot).toBe("Accounting-Only Branch");
  });

  it("a cross-tenant branch id is denied with the same safe, non-disclosing message", async () => {
    const owner = await createOwnerAndBusiness("app-expense-cross-a");
    const stranger = await createOwnerAndBusiness("app-expense-cross-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);
    const sql = await import("./helpers/db-client").then((m) => m.createTestDbClient());
    let categoryId: string;
    try {
      const [category] = await sql<{ id: string }[]>`
        select id from public.expense_categories where business_id = ${owner.businessId} limit 1
      `;
      categoryId = category.id;
    } finally {
      await sql.end();
    }

    currentClient = owner.client;
    const result = await createExpense(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        categoryId,
        amount: "100",
        paymentMethod: "CASH",
        incurredAt: new Date().toISOString(),
        branchId: strangerBranchId,
      })
    );
    expect(result?.error).toBe("This branch is not available.");
  });
});

describe("getFinancialSummary — branch filter", () => {
  it("omitting branchId returns the company-wide aggregate (unchanged default)", async () => {
    const owner = await createOwnerAndBusiness("app-report-company-wide");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const summary = await getFinancialSummary(owner.businessId, from, to);
    expect(summary.salesCount).toBe(0);
    expect(summary.expenseCount).toBe(0);
  });

  it("an explicit branch filters sales/expenses to that branch alone, excluding a company-wide expense", async () => {
    const owner = await createOwnerAndBusiness("app-report-branch-filter");
    cleanupUserIds.push(owner.userId);
    // The OWNER's own accessible branch — an OWNER can never self-assign
    // to a second branch (CANNOT_MANAGE_SELF, a frozen Phase 1F rule), so
    // this proves the filter using the one branch they genuinely operate
    // at, rather than a Branch B they'd have no real access to sell from.
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    const sql = await import("./helpers/db-client").then((m) => m.createTestDbClient());
    let categoryId: string;
    try {
      const [category] = await sql<{ id: string }[]>`
        select id from public.expense_categories where business_id = ${owner.businessId} limit 1
      `;
      categoryId = category.id;
    } finally {
      await sql.end();
    }

    currentClient = owner.client;
    // A sale explicitly at the owner's own default branch.
    const { error: saleError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 1 }],
      p_branch_id: defaultBranchId,
    });
    expect(saleError).toBeNull();
    // A company-wide (no branch) expense — must be EXCLUDED from a
    // single-branch report.
    let expenseCaught: unknown;
    try {
      await createExpense(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          categoryId,
          amount: "999",
          paymentMethod: "CASH",
          incurredAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      expenseCaught = e;
    }
    expect(isRedirect(expenseCaught)).toBe(true);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const branchSummary = await getFinancialSummary(owner.businessId, from, to, defaultBranchId);
    expect(branchSummary.salesCount).toBe(1);
    expect(branchSummary.expenseCount).toBe(0);

    const companyWideSummary = await getFinancialSummary(owner.businessId, from, to);
    expect(companyWideSummary.salesCount).toBe(1);
    expect(companyWideSummary.expenseCount).toBe(1);
  });

  it("a cross-tenant branch id is rejected with a safe, mapped error, never a raw BRANCH_NOT_FOUND", async () => {
    const owner = await createOwnerAndBusiness("app-report-cross-a");
    const stranger = await createOwnerAndBusiness("app-report-cross-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);

    currentClient = owner.client;
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await expect(getFinancialSummary(owner.businessId, from, to, strangerBranchId)).rejects.toThrow(
      "This branch is not available."
    );
  });

  it("reports.view alone (no branch access at all) still resolves a branch-filtered summary — never gated on has_branch_access", async () => {
    const owner = await createOwnerAndBusiness("app-report-view-only");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    // A reports.view-only caller with NO access to Branch B at all.
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "app-report-view-only", [
      PERMISSION.REPORTS_VIEW,
    ]);
    cleanupUserIds.push(accountant.userId);

    currentClient = accountant.client;
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const summary = await getFinancialSummary(owner.businessId, from, to, branchB);
    expect(summary.salesCount).toBe(0);
    expect(summary.expenseCount).toBe(0);
  });
});

// Codex adversarial review, application-layer round 2, Blocker 5: the
// approved Phase 1G DB contract deliberately preserved every pre-Phase-1G
// calling shape (create_sale/create_product/record_inventory_movement all
// still work when the NEW branch fields are omitted entirely). These
// prove the application's OWN validation/action layer never structurally
// blocks that fallback — a legacy caller (an older client build, a
// script, a differently-shaped form) that never sends branchId at all
// must still succeed via the DB's own compatibility resolution, exactly
// as it did before this UI existed.
describe("legacy (no-branchId) action payloads remain backward compatible", () => {
  it("createSale without branchId resolves via the caller's active primary branch (create_sale's own omitted-branch fallback)", async () => {
    const owner = await createOwnerAndBusiness("legacy-sale-no-branch");
    cleanupUserIds.push(owner.userId);
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });

    currentClient = owner.client;
    let caught: unknown;
    try {
      // The exact old, pre-Phase-1G calling shape: no branchId key at all.
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

    const { data: sale } = await owner.client
      .from("sales")
      .select("branch_id")
      .eq("business_id", owner.businessId)
      .single();
    expect(sale!.branch_id).toBe(defaultBranchId);
  });

  it("createProduct with positive opening stock and no branchId resolves via the caller's active primary branch (Medium 2B's own fallback)", async () => {
    const owner = await createOwnerAndBusiness("legacy-product-no-branch");
    cleanupUserIds.push(owner.userId);
    const defaultBranchId = await getDefaultBranchId(owner.client, owner.businessId);
    const defaultLocationId = await getBranchLocationId(owner.businessId, defaultBranchId);

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createProduct(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          name: "Legacy Opening Stock Product",
          sku: `sku-${randomUuid()}`,
          sellingPrice: "100",
          trackInventory: "on",
          openingQuantity: "5",
          // No branchId at all — the exact old calling shape.
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity, inventory_location_id")
      .eq("business_id", owner.businessId)
      .single();
    expect(balance!.inventory_location_id).toBe(defaultLocationId);
    expect(Number(balance!.quantity)).toBe(5);
  });

  it("adjustStock without branchId reproduces the exact legacy default-location payload, still succeeding via Medium 2C's own compatibility alias for a Branch-B-only caller", async () => {
    const owner = await createOwnerAndBusiness("legacy-adjust-no-branch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "legacy-adjust-no-branch", [
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(worker.userId);
    const workerMemberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, workerMemberId, [branchB]);

    currentClient = worker.client;
    let caught: unknown;
    try {
      // The exact old, pre-Phase-1G calling shape: no branchId key at all
      // — the legacy app always sent the business-wide default location,
      // which this worker has no direct access to.
      await adjustStock(
        undefined,
        formData({
          businessId: owner.businessId,
          idempotencyKey: randomUuid(),
          productId: product.id,
          direction: "increase",
          quantity: "4",
          reason: "Legacy adjustment shape",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: balance } = await owner.client
      .from("inventory_balances")
      .select("quantity")
      .eq("business_id", owner.businessId)
      .eq("inventory_location_id", branchBLocationId)
      .single();
    expect(Number(balance!.quantity)).toBe(4);
  });

  it("createSale still accepts an explicit branchId alongside the legacy call shape — new and old paths coexist", async () => {
    const owner = await createOwnerAndBusiness("legacy-sale-explicit-still-works");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Branch B" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    const seller = await createMemberWithCustomPermissions(owner.businessId, "legacy-sale-explicit-still-works", [
      PERMISSION.SALES_CREATE,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchB]);

    currentClient = seller.client;
    let caught: unknown;
    try {
      await createSale(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          branchId: branchB,
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
          paymentStatus: "UNPAID",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: sale } = await owner.client
      .from("sales")
      .select("branch_id")
      .eq("business_id", owner.businessId)
      .single();
    expect(sale!.branch_id).toBe(branchB);
  });
});

// Codex adversarial review, application-layer round 2, Blocker 4: sales.view
// is business-wide — the filter's own options (and what it can actually
// filter to) must cover every branch of the business, never just the
// caller's own operational assignment.
describe("sales list — Blocker 4: business-wide filter semantics", () => {
  it("listSales's branch filter includes a branch the caller is NOT operationally assigned to — sales.view is business-wide, never narrowed to assignment", async () => {
    const owner = await createOwnerAndBusiness("app-sales-filter-wide");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Branch B" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    // branches.view deliberately OMITTED — listSalesFilterBranchOptions
    // resolves through the "sales_filter" RPC scope, authorized on
    // sales.view alone (supabase/migrations/20260830080000_branch_option_rpc.sql).
    const accountant = await createMemberWithCustomPermissions(owner.businessId, "app-sales-filter-wide", [
      PERMISSION.SALES_VIEW,
    ]);
    cleanupUserIds.push(accountant.userId);
    // The accountant is never assigned to branchB at all.

    // A real sale at branchB, created by the owner acting through a
    // second, branch-B-assigned staff member — mirrors the "who can
    // create where" rules exactly; this test only cares whether an
    // UNASSIGNED sales.view holder can FILTER to it afterward.
    const seller = await createMemberWithCustomPermissions(owner.businessId, "app-sales-filter-wide-seller", [
      PERMISSION.SALES_CREATE,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(seller.userId);
    const sellerMemberId = await getMemberId(owner.businessId, seller.userId);
    await assignMemberToBranch(owner.client, owner.businessId, sellerMemberId, [branchB]);
    currentClient = seller.client;
    await createSale(
      undefined,
      (() => {
        const fd = new FormData();
        fd.set("businessId", owner.businessId);
        fd.set("creationKey", randomUuid());
        fd.set("branchId", branchB);
        fd.set("items", JSON.stringify([{ productId: product.id, quantity: "1" }]));
        fd.set("paymentStatus", "UNPAID");
        return fd;
      })()
    ).catch(() => {});

    // The business-wide branch list (what the sales filter's OWN options
    // come from) includes branchB even though the accountant — who holds
    // no branches.view — has no operational assignment to it at all.
    currentClient = accountant.client;
    const allBranches = await listSalesFilterBranchOptions(owner.businessId);
    expect(allBranches.some((b) => b.id === branchB)).toBe(true);

    // And the accountant can actually filter TO it — sales.view is
    // business-wide, so this never widens visibility, only narrows an
    // already-fully-visible result set.
    const { rows } = await listSales(owner.businessId, { branchId: branchB });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.branch_id === branchB)).toBe(true);
  });
});

// Codex adversarial review, application-layer round 3 — the four
// business-wide branch-option scopes (expenses, reports, sales_filter,
// inventory_filter) all resolve through public.get_business_branch_options
// (supabase/migrations/20260830080000_branch_option_rpc.sql), each
// authorized on exactly the one permission that already gates the real
// workflow it backs — never branches.view. sales_filter's own equivalent
// proof already lives in the "sales list — Blocker 4" describe block
// above (it exercises listSalesFilterBranchOptions directly against a
// branches.view-free accountant fixture); the three tests below cover the
// remaining scopes the same way.
describe("business-wide branch-option scopes — no branches.view dependency", () => {
  it("expenses.manage without branches.view resolves every ACTIVE branch of the business, including one the caller has no operational assignment to", async () => {
    const owner = await createOwnerAndBusiness("app-expense-branch-scope");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Expense Branch" });
    const clerk = await createMemberWithCustomPermissions(owner.businessId, "app-expense-branch-scope", [
      PERMISSION.EXPENSES_MANAGE,
    ]);
    cleanupUserIds.push(clerk.userId);

    currentClient = clerk.client;
    const { options } = await listExpenseBranchOptions(owner.businessId);
    expect(options.some((b) => b.id === branchB && b.name === "Unassigned Expense Branch")).toBe(true);
  });

  it("reports.view without branches.view resolves every branch of the business, ACTIVE and INACTIVE alike", async () => {
    const owner = await createOwnerAndBusiness("app-report-branch-scope");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Historical Report Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    const analyst = await createMemberWithCustomPermissions(owner.businessId, "app-report-branch-scope", [
      PERMISSION.REPORTS_VIEW,
    ]);
    cleanupUserIds.push(analyst.userId);

    currentClient = analyst.client;
    const branches = await listReportBranchOptions(owner.businessId);
    const row = branches.find((b) => b.id === branchB);
    expect(row?.name).toBe("Historical Report Branch");
    expect(row?.status).toBe("INACTIVE");
  });

  it("inventory.view without branches.view resolves every ACTIVE branch of the business, with no staff-assignment restriction", async () => {
    const owner = await createOwnerAndBusiness("app-inventory-filter-branch-scope");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Inventory Filter Branch" });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inventory-filter-branch-scope", [
      PERMISSION.INVENTORY_VIEW,
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const branches = await listInventoryFilterBranchOptions(owner.businessId);
    expect(branches.some((b) => b.id === branchB)).toBe(true);
  });
});

// Codex adversarial review, application-layer round 2, Blocker 3: inventory.view
// is business-wide — branch awareness is a filter/context enhancement,
// never a new authorization boundary.
describe("inventory overview — Blocker 3: business-wide semantics, multi-location, aggregation labeling", () => {
  it("the unfiltered ('All branches') overview includes stock from a branch the caller is NOT operationally assigned to", async () => {
    const owner = await createOwnerAndBusiness("app-inv-overview-wide");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Inventory Branch" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });

    // The OWNER themselves has no operational access to branchB either
    // (CANNOT_MANAGE_SELF — they can never self-assign beyond their own
    // default branch), so seeding branchB's stock needs its own
    // branch-B-assigned adjuster, mirroring every other branch-specific
    // inventory fixture in this file.
    const adjuster = await createMemberWithCustomPermissions(owner.businessId, "app-inv-overview-wide-adjuster", [
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(adjuster.userId);
    const adjusterMemberId = await getMemberId(owner.businessId, adjuster.userId);
    await assignMemberToBranch(owner.client, owner.businessId, adjusterMemberId, [branchB]);
    const { error: mvError } = await adjuster.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: branchBLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 9,
      p_idempotency_key: randomUuid(),
      p_reason: "Unassigned branch stock",
    });
    expect(mvError).toBeNull();

    // A viewer with inventory.view, never assigned to branchB.
    // products.view is ALSO required — public.products' own SELECT RLS
    // policy is gated on products.view specifically, not inventory.view
    // (see create_products.sql) — getInventoryOverview reads FROM
    // products with an inventory_balances embed, so both are genuinely
    // needed, exactly matching the real seeded INVENTORY role's own
    // bundle (products.view + inventory.view together).
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-overview-wide", [
      PERMISSION.INVENTORY_VIEW,
      PERMISSION.PRODUCTS_VIEW,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const { rows } = await getInventoryOverview(owner.businessId, { scopeLabel: "All branches" });
    const row = rows.find((r) => r.productId === product.id);
    // Business-wide: the unassigned branch's stock is still visible —
    // never hidden merely because this caller's own operational
    // assignment is elsewhere (or nowhere at all).
    expect(row?.quantity).toBe(9);
  });

  it("a selected branch's overview includes stock from EVERY physical location in that branch, not only its canonical one", async () => {
    const owner = await createOwnerAndBusiness("app-inv-multi-location");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Multi-Location Branch" });
    const canonicalLocationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });

    // A SECOND, non-canonical physical location for the SAME branch —
    // structurally possible (business_branches/inventory_locations are
    // deliberately separate concepts; a branch may have more than one
    // location), inserted directly since no application UI creates
    // additional locations yet (out of this round's scope).
    const sql = await import("./helpers/db-client").then((m) => m.createTestDbClient());
    let secondLocationId: string;
    try {
      const [row] = await sql<{ id: string }[]>`
        insert into public.inventory_locations (business_id, branch_id, name, is_branch_default, status, created_by)
        values (${owner.businessId}, ${branchB}, 'Branch B Overflow Shelf', false, 'active', ${owner.userId})
        returning id
      `;
      secondLocationId = row.id;
    } finally {
      await sql.end();
    }

    const adjuster = await createMemberWithCustomPermissions(owner.businessId, "app-inv-multi-location-adjuster", [
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(adjuster.userId);
    const adjusterMemberId = await getMemberId(owner.businessId, adjuster.userId);
    await assignMemberToBranch(owner.client, owner.businessId, adjusterMemberId, [branchB]);

    const mv1 = await adjuster.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: canonicalLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 4,
      p_idempotency_key: randomUuid(),
      p_reason: "Canonical location stock",
    });
    expect(mv1.error).toBeNull();
    const mv2 = await adjuster.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: secondLocationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 6,
      p_idempotency_key: randomUuid(),
      p_reason: "Second location stock",
    });
    expect(mv2.error).toBeNull();

    currentClient = owner.client;
    const locations = await getLocationsForBranch(owner.businessId, branchB);
    expect(locations.map((l) => l.id).sort()).toEqual([canonicalLocationId, secondLocationId].sort());

    const { rows } = await getInventoryOverview(owner.businessId, {
      locationIds: locations.map((l) => l.id),
      scopeLabel: "Multi-Location Branch",
    });
    const row = rows.find((r) => r.productId === product.id);
    // Both locations' stock is summed — 4 + 6 = 10 — never just the
    // canonical location's own 4.
    expect(row?.quantity).toBe(10);
    // Codex adversarial review, application-layer round 2, Blocker 3C:
    // two matching locations must never be mislabeled with one arbitrary
    // location's own name — the current filter's own scope label is used
    // instead.
    expect(row?.locationName).toBe("Multi-Location Branch");
  });

  it("exactly one matching location still shows that location's own real name, not the generic scope label", async () => {
    const owner = await createOwnerAndBusiness("app-inv-single-location-label");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Single Location Branch" });
    const locationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });
    const adjuster = await createMemberWithCustomPermissions(owner.businessId, "app-inv-single-location-adjuster", [
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.INVENTORY_VIEW_COST,
      PERMISSION.BRANCHES_VIEW,
    ]);
    cleanupUserIds.push(adjuster.userId);
    const adjusterMemberId = await getMemberId(owner.businessId, adjuster.userId);
    await assignMemberToBranch(owner.client, owner.businessId, adjusterMemberId, [branchB]);
    const { error: mvError } = await adjuster.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 2,
      p_idempotency_key: randomUuid(),
      p_reason: "Single location stock",
    });
    expect(mvError).toBeNull();

    currentClient = owner.client;
    const { rows } = await getInventoryOverview(owner.businessId, {
      locationIds: [locationId],
      scopeLabel: "Single Location Branch",
    });
    const row = rows.find((r) => r.productId === product.id);
    // The canonical location's own real name (per
    // private.canonical_branch_location_name's naming convention), not
    // the generic scope label — a single, unambiguous location doesn't
    // need the fallback.
    expect(row?.locationName).toBe("Single Location Branch Store");
  });

  it("zero matching locations (no stock at all) falls back to the scope label, never an arbitrary/undefined name", async () => {
    const owner = await createOwnerAndBusiness("app-inv-zero-location-label");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Empty Branch" });
    const branchBLocationId = await getBranchLocationId(owner.businessId, branchB);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 0 });

    currentClient = owner.client;
    const { rows } = await getInventoryOverview(owner.businessId, {
      locationIds: [branchBLocationId],
      scopeLabel: "Empty Branch",
    });
    const row = rows.find((r) => r.productId === product.id);
    expect(row?.quantity).toBe(0);
    expect(row?.locationName).toBe("Empty Branch");
  });
});
