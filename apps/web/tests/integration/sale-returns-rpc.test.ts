import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  createMemberWithCustomPermissions,
  createMemberWithRole,
  createRoleWithPermissions,
  randomUuid,
} from "./helpers/inventory";
import { makeSaleProduct } from "./helpers/sales";
import { createBranch, getDefaultBranchId, getBranchLocationId, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1I — DATABASE FOUNDATION. Exercises create_sale_return directly
// against a real database, independent of the (not-yet-built) application
// layer — mirrors this project's own established pattern
// (invoice-payment-rpc.test.ts).

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  assertLocalSupabaseUrl(url);
  return createClient(url, key, { auth: { persistSession: false } });
}

function returnItem(saleItemId: string, quantity: number, restock: boolean) {
  return { sale_item_id: saleItemId, quantity, restock };
}

// Shared deterministic lock-observation barrier — mirrors
// invoice-payment-rpc.test.ts's own "25b"/SEC-03 technique: a bounded poll
// of pg_stat_activity confirms a connection is GENUINELY blocked on a row
// lock (never inferred from timing alone).
async function waitForLock(c1: ReturnType<typeof createTestDbClient>, pid: number) {
  for (let i = 0; i < 400; i++) {
    const rows = await c1<{ wait_event_type: string | null }[]>`
      select wait_event_type from pg_stat_activity where pid = ${pid}
    `;
    if (rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function createSale(
  client: ReturnType<typeof createAnonClient>,
  overrides: {
    businessId: string;
    items: { product_id: string; quantity: number }[];
    paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID";
    paymentMethod?: string;
    amountPaid?: number;
    branchId?: string;
  }
) {
  const paymentStatus = overrides.paymentStatus ?? "PAID";
  // UNPAID rejects a supplied payment_method entirely (create_sale's own
  // "amount and method are both structurally absent when unpaid"
  // invariant) — only default one in for the statuses that require it.
  const paymentMethod =
    overrides.paymentMethod ?? (paymentStatus === "UNPAID" ? undefined : "CASH");
  return client.rpc("create_sale", {
    p_business_id: overrides.businessId,
    p_creation_key: randomUuid(),
    p_items: overrides.items,
    p_payment_status: paymentStatus,
    p_payment_method: paymentMethod,
    p_amount_paid: overrides.amountPaid,
    p_branch_id: overrides.branchId,
  });
}

async function createReturn(
  client: ReturnType<typeof createAnonClient>,
  overrides: {
    businessId: string;
    saleId: string;
    items: unknown[];
    refundAmount?: number;
    refundMethod?: string;
    reason?: string;
    notes?: string;
    creationKey?: string;
  }
) {
  return client.rpc("create_sale_return", {
    p_business_id: overrides.businessId,
    p_creation_key: overrides.creationKey ?? randomUuid(),
    p_sale_id: overrides.saleId,
    p_items: overrides.items,
    p_refund_amount: overrides.refundAmount ?? 0,
    p_refund_method: overrides.refundMethod,
    p_reason: overrides.reason,
    p_notes: overrides.notes,
  });
}

// Common fixture: an owner, one tracked product (100 opening stock), and a
// PAID sale of 5 units at 1000 each (total 5000, fully paid).
async function setupPaidSale(prefix: string, quantity = 5, sellingPrice = 1000) {
  const owner = await createOwnerAndBusiness(prefix);
  const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice })).id;
  const { data: saleId, error } = await createSale(owner.client, {
    businessId: owner.businessId,
    items: [{ product_id: product, quantity }],
  });
  if (error || !saleId) throw new Error(`fixture sale creation failed: ${error?.message}`);
  const { data: saleItems } = await owner.client
    .from("sale_items")
    .select("id, quantity, unit_price")
    .eq("sale_id", saleId as string);
  const saleItemId = saleItems![0].id as string;
  return { owner, product, saleId: saleId as string, saleItemId };
}

describe("create_sale_return — authorization and validation", () => {
  it("1. an authorized member (returns.manage) creates a partial return successfully", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-create-partial");
    cleanupUserIds.push(owner.userId);

    const { data: returnId, error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 2, false)],
    });
    expect(error).toBeNull();
    expect(returnId).toBeTruthy();

    const { data: items } = await owner.client
      .from("sale_return_items")
      .select("quantity, restock, product_name_snapshot")
      .eq("sale_return_id", returnId as string);
    expect(items).toHaveLength(1);
    expect(Number(items![0].quantity)).toBe(2);
  });

  it("2. a full return (entire sold quantity in one transaction) succeeds", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-create-full", 5);
    cleanupUserIds.push(owner.userId);

    const { data: returnId, error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 5, false)],
    });
    expect(error).toBeNull();
    const { data: items } = await owner.client.from("sale_return_items").select("quantity").eq("sale_return_id", returnId as string);
    expect(Number(items![0].quantity)).toBe(5);
  });

  it("3. multiple separate returns against the same sale are each recorded independently", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-multi", 5);
    cleanupUserIds.push(owner.userId);

    const { data: r1 } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)] });
    const { data: r2 } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(r1).not.toBe(r2);

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(2);
  });

  it("4. returning the EXACT remaining quantity succeeds", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-exact-remaining", 5);
    cleanupUserIds.push(owner.userId);

    await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)] });
    const { error } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 3, false)] });
    expect(error).toBeNull();
  });

  it("5. an over-return (exceeding remaining quantity) is rejected", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-over", 5);
    cleanupUserIds.push(owner.userId);

    await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)] });
    const { error } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 4, false)] });
    expect(error?.message).toContain("RETURN_QUANTITY_EXCEEDED");
  });

  it("7. a return with zero refund succeeds, refund_method is null", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-no-refund");
    cleanupUserIds.push(owner.userId);

    const { data: returnId, error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: 0,
    });
    expect(error).toBeNull();
    const { data: row } = await owner.client.from("sale_returns").select("refund_amount, refund_method").eq("id", returnId as string).single();
    expect(Number(row?.refund_amount)).toBe(0);
    expect(row?.refund_method).toBeNull();
  });

  it("8. a partial refund succeeds", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-partial-refund");
    cleanupUserIds.push(owner.userId);

    const { data: returnId, error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 2, false)],
      refundAmount: 1000,
      refundMethod: "CASH",
    });
    expect(error).toBeNull();
    const { data: row } = await owner.client.from("sale_returns").select("refund_amount").eq("id", returnId as string).single();
    expect(Number(row?.refund_amount)).toBe(1000);
  });

  it("9. a full refundable-amount refund (exact returned-value basis) succeeds", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-full-refund");
    cleanupUserIds.push(owner.userId);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 2, false)],
      refundAmount: 2000, // exactly 2 * 1000
      refundMethod: "CASH",
    });
    expect(error).toBeNull();
  });

  it("10. a refund exceeding the returned-line value is rejected", async () => {
    // Sale of 2 units @ 1000, fully paid (amount_paid=2000) — the
    // amount_paid ceiling is NOT the binding constraint here; only 1 unit
    // (basis=1000) is returned, but 1500 is requested.
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-exceeds-basis", 2);
    cleanupUserIds.push(owner.userId);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: 1500,
      refundMethod: "CASH",
    });
    expect(error?.message).toContain("RETURN_REFUND_EXCEEDED");
  });

  it("11. cumulative refund exceeding the sale's own amount_paid is rejected", async () => {
    const owner = await createOwnerAndBusiness("ret-exceeds-paid");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 })).id;
    const { data: saleId } = await createSale(owner.client, {
      businessId: owner.businessId,
      items: [{ product_id: product, quantity: 2 }],
      paymentStatus: "PARTIALLY_PAID",
      amountPaid: 500,
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const saleItemId = saleItems![0].id as string;

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(saleItemId, 2, false)],
      refundAmount: 600, // basis=2000 (not binding), but amount_paid=500
      refundMethod: "CASH",
    });
    expect(error?.message).toContain("RETURN_REFUND_EXCEEDED");
  });

  it("no refund is rejected for a sale with zero amount_paid attempting a refund > 0", async () => {
    const owner = await createOwnerAndBusiness("ret-unpaid-refund");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 })).id;
    const { data: saleId } = await createSale(owner.client, {
      businessId: owner.businessId,
      items: [{ product_id: product, quantity: 1 }],
      paymentStatus: "UNPAID",
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(saleItems![0].id as string, 1, false)],
      refundAmount: 500,
      refundMethod: "CASH",
    });
    expect(error?.message).toContain("RETURN_REFUND_EXCEEDED");
  });

  it("22. excess quantity precision is rejected (more than 3 decimal places)", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-qty-precision", 5);
    cleanupUserIds.push(owner.userId);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [{ sale_item_id: saleItemId, quantity: 1.2345, restock: false }],
    });
    expect(error?.message).toContain("MALFORMED_RETURN_ITEMS");
  });

  it.each([0.01, 1, 1.5, 1.5, 100.25])("23a. accepts refund amount %s", async (amount) => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-refund-precision-ok", 100, 1000000);
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: amount,
      refundMethod: amount > 0 ? "CASH" : undefined,
    });
    expect(error).toBeNull();
  });

  it.each([0.005, 1.999])("23. reject refund amounts with excess decimal precision: %s", async (amount) => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-refund-precision-bad", 100, 1000000);
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: amount,
      refundMethod: "CASH",
    });
    expect(error?.message).toContain("INVALID_REFUND_AMOUNT");
  });

  it("24. an invalid refund method is rejected", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-invalid-method");
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: 500,
      refundMethod: "CRYPTO",
    });
    expect(error?.message).toContain("INVALID_REFUND_METHOD");
  });

  it("25. refund method is required when refund_amount > 0", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-method-required");
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: 500,
    });
    expect(error?.message).toContain("INVALID_REFUND_METHOD");
  });

  it("26. refund method must be absent when refund_amount = 0", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-method-absent");
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      refundAmount: 0,
      refundMethod: "CASH",
    });
    expect(error?.message).toContain("INVALID_REFUND_METHOD");
  });

  it("21. zero or negative quantity is rejected", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-zero-qty", 5);
    cleanupUserIds.push(owner.userId);
    const zero = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 0, false)] });
    expect(zero.error?.message).toContain("MALFORMED_RETURN_ITEMS");
    const negative = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, -1, false)] });
    expect(negative.error?.message).toContain("MALFORMED_RETURN_ITEMS");
  });

  it("20. duplicate sale_item_id within the same return request is rejected", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-duplicate-item", 5);
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false), returnItem(saleItemId, 1, false)],
    });
    expect(error?.message).toContain("DUPLICATE_SALE_ITEM_LINE");
  });

  it("19. a foreign sale_item_id (belongs to a different sale) is denied", async () => {
    const { owner, saleId } = await setupPaidSale("ret-foreign-item-a", 5);
    cleanupUserIds.push(owner.userId);
    const other = await setupPaidSale("ret-foreign-item-b", 5);
    cleanupUserIds.push(other.owner.userId);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(other.saleItemId, 1, false)],
    });
    expect(error?.message).toContain("RETURN_ITEM_NOT_FOUND");
  });

  it("18. a sale that is not COMPLETED is not eligible for return", async () => {
    const owner = await createOwnerAndBusiness("ret-not-eligible");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 })).id;
    const { data: saleId } = await createSale(owner.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 1 }] });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);

    const sql = createTestDbClient();
    try {
      // The COMPLETED<->completed_at and CANCELLED<->cancelled_at
      // biconditionals are both enforced structurally — flipping status
      // must clear the other lifecycle timestamp too, or the row becomes
      // unrepresentable (sales_check2).
      await sql`update public.sales set status = 'CANCELLED', completed_at = null, cancelled_at = now() where id = ${saleId as string}`;
    } finally {
      await sql.end();
    }

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(saleItems![0].id as string, 1, false)],
    });
    expect(error?.message).toContain("RETURN_SALE_NOT_ELIGIBLE");
  });

  it("a nonexistent sale_id is denied with a generic error", async () => {
    const owner = await createOwnerAndBusiness("ret-sale-nonexistent");
    cleanupUserIds.push(owner.userId);
    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: randomUuid(),
      items: [returnItem(randomUuid(), 1, false)],
    });
    expect(error?.message).toContain("RETURN_SALE_NOT_FOUND");
  });

  it("17. a caller without returns.manage is denied", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-unauthorized");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "ret-unauthorized", ["returns.view"]);
    cleanupUserIds.push(viewer.userId);

    const { error } = await createReturn(viewer.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("returns.manage does NOT silently require sales.create, inventory.adjust, or branches.manage", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-no-hidden-deps");
    cleanupUserIds.push(owner.userId);
    // A custom role holding ONLY returns.manage — no other permission at
    // all — assigned to the sale's own (default) branch.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "ret-no-hidden-deps", ["returns.manage"]);
    cleanupUserIds.push(worker.userId);
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [defaultBranch]);

    const { error } = await createReturn(worker.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(error).toBeNull();
  });
});

describe("create_sale_return — branch authority (SEC-01 lesson applied proactively)", () => {
  it("16. returns.manage assigned ONLY to Branch A — a Branch B sale is denied (generic, non-disclosing)", async () => {
    const owner = await createOwnerAndBusiness("ret-branch-b-denied");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ret Branch B" });
    // Not tracking inventory: this test proves branch-authority denial,
    // never stock deduction (opening stock always lands at the DEFAULT
    // location, so a tracked product sold at Branch B would spuriously
    // fail with INSUFFICIENT_STOCK for a reason unrelated to what this
    // test is actually proving).
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, trackInventory: false })).id;

    // A creator assigned to Branch B makes the sale there.
    const creator = await createMemberWithCustomPermissions(owner.businessId, "ret-branch-b-denied-creator", ["sales.create"]);
    cleanupUserIds.push(creator.userId);
    const creatorMemberId = await getMemberId(owner.businessId, creator.userId);
    await assignMemberToBranch(owner.client, owner.businessId, creatorMemberId, [branchB]);
    const { data: saleId, error: saleErr } = await createSale(creator.client, {
      businessId: owner.businessId,
      items: [{ product_id: product, quantity: 3 }],
      branchId: branchB,
    });
    expect(saleErr).toBeNull();
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);

    // The attacker: returns.manage, assigned ONLY to the default branch (A).
    const attacker = await createMemberWithCustomPermissions(owner.businessId, "ret-branch-b-denied-attacker", ["returns.manage"]);
    cleanupUserIds.push(attacker.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const attackerMemberId = await getMemberId(owner.businessId, attacker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, attackerMemberId, [branchA]);

    const { error } = await createReturn(attacker.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(saleItems![0].id as string, 1, false)],
    });
    expect(error?.message).toContain("RETURN_SALE_NOT_FOUND");

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId as string);
    expect(returns).toHaveLength(0);
  });

  it("a caller assigned to BOTH branches can return a sale from either", async () => {
    const owner = await createOwnerAndBusiness("ret-both-branches");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ret Both Branch B" });
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    // Not tracking inventory: only branch-authority is under test here.
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, trackInventory: false })).id;

    const worker = await createMemberWithCustomPermissions(owner.businessId, "ret-both-branches", ["sales.create", "returns.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchA, branchB]);

    const { data: saleAId } = await createSale(worker.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 1 }], branchId: branchA });
    const { data: saleBId } = await createSale(worker.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 1 }], branchId: branchB });
    const { data: itemsA } = await owner.client.from("sale_items").select("id").eq("sale_id", saleAId as string);
    const { data: itemsB } = await owner.client.from("sale_items").select("id").eq("sale_id", saleBId as string);

    const retA = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleAId as string, items: [returnItem(itemsA![0].id as string, 1, false)] });
    const retB = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleBId as string, items: [returnItem(itemsB![0].id as string, 1, false)] });
    expect(retA.error).toBeNull();
    expect(retB.error).toBeNull();
  });

  it("restock only ever lands in the SALE'S OWN branch location, never a different one", async () => {
    const owner = await createOwnerAndBusiness("ret-restock-branch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ret Restock Branch B" });
    // Opening stock always lands at the business-wide DEFAULT location
    // (Branch A's own) — this test needs REAL stock at Branch B's own
    // canonical location to sell from there, so it's seeded directly via
    // the real record_inventory_movement RPC (an ADJUSTMENT_IN), never a
    // raw table write.
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, openingQuantity: 0 })).id;
    const branchBLocation = await getBranchLocationId(owner.businessId, branchB);
    // record_inventory_movement itself requires branch access to the
    // TARGET location's own branch. The OWNER is auto-assigned only to
    // the default branch (A) and — per this codebase's own locked
    // CANNOT_MANAGE_SELF invariant — can never assign themselves to a
    // different branch. A separate seeder member, assigned to Branch B by
    // the owner, does the seeding instead (branch access for the OWNER is
    // not what this seeding step is meant to exercise).
    // inventory.adjust => inventory.view_cost is a real, repo-wide RBAC
    // implication (see rbac-implication.test.ts) — any role granting the
    // former must also grant the latter, fixture roles included.
    const seeder = await createMemberWithCustomPermissions(owner.businessId, "ret-restock-branch-seeder", [
      "inventory.adjust",
      "inventory.view_cost",
    ]);
    cleanupUserIds.push(seeder.userId);
    const seederMemberId = await getMemberId(owner.businessId, seeder.userId);
    await assignMemberToBranch(owner.client, owner.businessId, seederMemberId, [branchB]);
    const { error: seedError } = await seeder.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product,
      p_inventory_location_id: branchBLocation,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 10,
      p_idempotency_key: randomUuid(),
      p_reason: "Seed Branch B stock for return-restock-branch test",
    });
    expect(seedError).toBeNull();

    const worker = await createMemberWithCustomPermissions(owner.businessId, "ret-restock-branch", ["sales.create", "returns.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data: saleId, error: saleErr } = await createSale(worker.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 3 }], branchId: branchB });
    expect(saleErr).toBeNull();
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);

    const branchALocation = await getBranchLocationId(owner.businessId, await getDefaultBranchId(owner.client, owner.businessId));
    const { data: beforeA } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", branchALocation).eq("product_id", product).maybeSingle();

    const { error } = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItems![0].id as string, 2, true)] });
    expect(error).toBeNull();

    const { data: afterB } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", branchBLocation).eq("product_id", product).single();
    const { data: afterA } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", branchALocation).eq("product_id", product).maybeSingle();
    // Seeded 10, sold 3 (7 remains), then 2 restocked back (9).
    expect(Number(afterB?.quantity)).toBe(9);
    // Branch A's own balance for this product is unaffected (either still
    // absent, or unchanged from before).
    expect(Number(afterA?.quantity ?? 0)).toBe(Number(beforeA?.quantity ?? 0));
  });
});

describe("create_sale_return — cross-tenant isolation", () => {
  it("a cross-tenant sale_id is denied identically to a nonexistent one", async () => {
    const { owner: ownerA, saleId } = await setupPaidSale("ret-cross-tenant-a");
    cleanupUserIds.push(ownerA.userId);
    const ownerB = await createOwnerAndBusiness("ret-cross-tenant-b");
    cleanupUserIds.push(ownerB.userId);

    const { error } = await createReturn(ownerB.client, {
      businessId: ownerB.businessId,
      saleId,
      items: [returnItem(randomUuid(), 1, false)],
    });
    expect(error?.message).toContain("RETURN_SALE_NOT_FOUND");

    const { data: returns } = await createAdminClient().from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(0);
  });
});

describe("create_sale_return — restock / inventory", () => {
  it("13. restock=true creates a correct positive SALE_RETURN inventory movement", async () => {
    const { owner, saleId, saleItemId, product } = await setupPaidSale("ret-restock-true", 5).then(async (r) => ({ ...r, product: r.product }));
    cleanupUserIds.push(owner.userId);

    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, defaultBranch);
    const { data: before } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();

    const { data: returnId, error } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, true)] });
    expect(error).toBeNull();

    const { data: after } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();
    expect(Number(after?.quantity)).toBe(Number(before?.quantity) + 2);

    const { data: ledger } = await owner.client
      .from("inventory_ledger")
      .select("movement_type, quantity_delta, reference_type, reference_id")
      .eq("reference_type", "sale_return")
      .eq("reference_id", returnId as string);
    expect(ledger).toHaveLength(1);
    expect(ledger![0].movement_type).toBe("SALE_RETURN");
    expect(Number(ledger![0].quantity_delta)).toBe(2);
  });

  it("14. restock=false creates NO inventory movement at all", async () => {
    const { owner, saleId, saleItemId, product } = await setupPaidSale("ret-restock-false", 5).then(async (r) => ({ ...r, product: r.product }));
    cleanupUserIds.push(owner.userId);
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, defaultBranch);
    const { data: before } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();

    const { data: returnId, error } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)] });
    expect(error).toBeNull();

    const { data: after } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();
    expect(Number(after?.quantity)).toBe(Number(before?.quantity));

    const { data: ledger } = await owner.client.from("inventory_ledger").select("id").eq("reference_type", "sale_return").eq("reference_id", returnId as string);
    expect(ledger).toHaveLength(0);
  });

  it("a return mixing restock=true and restock=false lines only moves stock for the restocked line", async () => {
    const owner = await createOwnerAndBusiness("ret-mixed-restock");
    cleanupUserIds.push(owner.userId);
    const productA = (await makeSaleProduct(owner.client, owner.businessId, { name: "Mixed A", sellingPrice: 500 })).id;
    const productB = (await makeSaleProduct(owner.client, owner.businessId, { name: "Mixed B", sellingPrice: 700 })).id;
    const { data: saleId } = await createSale(owner.client, {
      businessId: owner.businessId,
      items: [{ product_id: productA, quantity: 3 }, { product_id: productB, quantity: 3 }],
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id, product_id").eq("sale_id", saleId as string);
    const itemA = saleItems!.find((i) => i.product_id === productA)!;
    const itemB = saleItems!.find((i) => i.product_id === productB)!;

    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, defaultBranch);

    const { error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(itemA.id as string, 1, true), returnItem(itemB.id as string, 1, false)],
    });
    expect(error).toBeNull();

    const { data: ledgerA } = await owner.client.from("inventory_ledger").select("id").eq("product_id", productA).eq("movement_type", "SALE_RETURN");
    const { data: ledgerB } = await owner.client.from("inventory_ledger").select("id").eq("product_id", productB).eq("movement_type", "SALE_RETURN");
    expect(ledgerA).toHaveLength(1);
    expect(ledgerB).toHaveLength(0);
    void locationId;
  });

  it("40. replaying an exact return never duplicates its own inventory restock", async () => {
    const { owner, saleId, saleItemId, product } = await setupPaidSale("ret-replay-no-dup-stock", 5).then(async (r) => ({ ...r, product: r.product }));
    cleanupUserIds.push(owner.userId);
    const creationKey = randomUuid();
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, defaultBranch);

    const first = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, true)], creationKey });
    expect(first.error).toBeNull();
    const second = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, true)], creationKey });
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: after } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();
    // 100 opening - 5 sold + 2 restocked (ONCE, not twice) = 97.
    expect(Number(after?.quantity)).toBe(97);
    const { data: ledger } = await owner.client.from("inventory_ledger").select("id").eq("reference_type", "sale_return").eq("reference_id", first.data as string);
    expect(ledger).toHaveLength(1);
  });
});

describe("create_sale_return — idempotency", () => {
  it("29. an identical retry (same creation key, same payload) returns the ORIGINAL return, never a second one", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-idempotent-replay", 5);
    cleanupUserIds.push(owner.userId);
    const creationKey = randomUuid();

    const first = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)], refundAmount: 1000, refundMethod: "CASH", creationKey });
    const second = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)], refundAmount: 1000, refundMethod: "CASH", creationKey });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
  });

  it("30. the same creation key with a materially different payload is rejected", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-idempotent-mismatch", 5);
    cleanupUserIds.push(owner.userId);
    const creationKey = randomUuid();

    const first = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 2, false)], creationKey });
    expect(first.error).toBeNull();
    const second = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 3, false)], creationKey });
    expect(second.error?.message).toContain("RETURN_IDEMPOTENCY_KEY_REUSED");
  });

  it("31. exact replay after a later branch deactivation still safely replays the original result", async () => {
    const owner = await createOwnerAndBusiness("ret-replay-after-deactivation");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Ret Replay Branch B" });
    // Not tracking inventory: only replay/branch-lifecycle behavior is
    // under test here.
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, trackInventory: false })).id;
    const worker = await createMemberWithCustomPermissions(owner.businessId, "ret-replay-after-deactivation", ["sales.create", "returns.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data: saleId } = await createSale(worker.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 3 }], branchId: branchB });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const creationKey = randomUuid();

    const first = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItems![0].id as string, 1, false)], creationKey });
    expect(first.error).toBeNull();

    // The worker's own branch access is now revoked (deactivate the
    // branch) — a NEW return attempt would correctly be denied, but an
    // EXACT replay of the already-completed one must still resolve safely
    // (this mirrors create_invoice's own established replay-before-
    // lifecycle-revalidation precedent).
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });

    const replay = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItems![0].id as string, 1, false)], creationKey });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);
  });
});

describe("create_sale_return — return number", () => {
  it("27. return numbers are sequential and business-scoped, never colliding across businesses", async () => {
    const a = await setupPaidSale("ret-numbering-a", 10);
    const b = await setupPaidSale("ret-numbering-b", 10);
    cleanupUserIds.push(a.owner.userId, b.owner.userId);

    const { data: r1 } = await createReturn(a.owner.client, { businessId: a.owner.businessId, saleId: a.saleId, items: [returnItem(a.saleItemId, 1, false)] });
    const { data: r2 } = await createReturn(a.owner.client, { businessId: a.owner.businessId, saleId: a.saleId, items: [returnItem(a.saleItemId, 1, false)] });
    const { data: rOther } = await createReturn(b.owner.client, { businessId: b.owner.businessId, saleId: b.saleId, items: [returnItem(b.saleItemId, 1, false)] });

    const { data: row1 } = await a.owner.client.from("sale_returns").select("return_number").eq("id", r1 as string).single();
    const { data: row2 } = await a.owner.client.from("sale_returns").select("return_number").eq("id", r2 as string).single();
    const { data: rowOther } = await b.owner.client.from("sale_returns").select("return_number").eq("id", rOther as string).single();
    expect(row1?.return_number).toBe("RET-000001");
    expect(row2?.return_number).toBe("RET-000002");
    expect(rowOther?.return_number).toBe("RET-000001");
  });

  it("38. deterministic line order — three lines whose submission order, lexical order, and locking order all disagree", async () => {
    const owner = await createOwnerAndBusiness("ret-line-order");
    cleanupUserIds.push(owner.userId);
    // Three products named so their SKU/name would sort differently from
    // whatever order their sale_item_id UUIDs happen to fall in.
    const p1 = (await makeSaleProduct(owner.client, owner.businessId, { name: "Zebra", sellingPrice: 100 })).id;
    const p2 = (await makeSaleProduct(owner.client, owner.businessId, { name: "Apple", sellingPrice: 200 })).id;
    const p3 = (await makeSaleProduct(owner.client, owner.businessId, { name: "Mango", sellingPrice: 300 })).id;
    const { data: saleId } = await createSale(owner.client, {
      businessId: owner.businessId,
      items: [{ product_id: p1, quantity: 1 }, { product_id: p2, quantity: 1 }, { product_id: p3, quantity: 1 }],
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id, product_id").eq("sale_id", saleId as string);
    const item1 = saleItems!.find((i) => i.product_id === p1)!.id as string;
    const item2 = saleItems!.find((i) => i.product_id === p2)!.id as string;
    const item3 = saleItems!.find((i) => i.product_id === p3)!.id as string;

    // Submitted order: item3 (Mango), item1 (Zebra), item2 (Apple) —
    // deliberately neither ascending sale_item_id order nor alphabetical
    // product-name order.
    const { data: returnId, error } = await createReturn(owner.client, {
      businessId: owner.businessId,
      saleId: saleId as string,
      items: [returnItem(item3, 1, false), returnItem(item1, 1, false), returnItem(item2, 1, false)],
    });
    expect(error).toBeNull();

    const { data: items } = await owner.client
      .from("sale_return_items")
      .select("product_name_snapshot, position")
      .eq("sale_return_id", returnId as string)
      .order("position", { ascending: true });
    expect(items).toEqual([
      { product_name_snapshot: "Mango", position: 0 },
      { product_name_snapshot: "Zebra", position: 1 },
      { product_name_snapshot: "Apple", position: 2 },
    ]);
  });

  it("28. concurrent return-number allocation for the same business never collides", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-number-concurrency", 10);
    cleanupUserIds.push(owner.userId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] })
      )
    );
    expect(results.every((r) => !r.error)).toBe(true);
    const { data: returns } = await owner.client.from("sale_returns").select("return_number").eq("sale_id", saleId);
    const numbers = returns!.map((r) => r.return_number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("create_sale_return — historical snapshot preservation", () => {
  it("37. a product rename after the return does not alter the return line's own snapshot", async () => {
    const owner = await createOwnerAndBusiness("ret-product-rename");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { name: "Original Return Product" })).id;
    const { data: saleId } = await createSale(owner.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 2 }] });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);

    const { data: returnId } = await createReturn(owner.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItems![0].id as string, 1, false)] });

    await owner.client.from("products").update({ name: "Renamed Return Product" }).eq("id", product);

    const { data: items } = await owner.client.from("sale_return_items").select("product_name_snapshot").eq("sale_return_id", returnId as string);
    expect(items![0].product_name_snapshot).toBe("Original Return Product");
  });

  it("39. branch_name_snapshot is captured at return-creation time from the sale's own snapshot", async () => {
    const owner = await createOwnerAndBusiness("ret-branch-name-snapshot");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Original Branch Name" });
    // Not tracking inventory: only the branch_name_snapshot is under test.
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500, trackInventory: false })).id;
    const worker = await createMemberWithCustomPermissions(owner.businessId, "ret-branch-name-snapshot", ["sales.create", "returns.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data: saleId } = await createSale(worker.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 1 }], branchId: branchB });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const { data: returnId } = await createReturn(worker.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItems![0].id as string, 1, false)] });

    const { data: row } = await owner.client.from("sale_returns").select("branch_name_snapshot").eq("id", returnId as string).single();
    expect(row?.branch_name_snapshot).toBe("Original Branch Name");
  });
});

describe("Phase 1I — ACL / RLS", () => {
  it("32. direct table writes are denied for authenticated — sale_returns/sale_return_items are RPC-only", async () => {
    const { owner, saleId } = await setupPaidSale("ret-acl-direct-write");
    cleanupUserIds.push(owner.userId);
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);

    const insertReturn = await owner.client.from("sale_returns").insert({
      business_id: owner.businessId,
      return_number: "RET-FORGED",
      sale_id: saleId,
      branch_id: defaultBranch,
      branch_name_snapshot: "Forged",
      refund_amount: 0,
      creation_key: randomUuid(),
      created_by: owner.userId,
    } as never);
    expect(insertReturn.error).not.toBeNull();

    const updateReturn = await owner.client.from("sale_returns").update({ refund_amount: 999 }).eq("sale_id", saleId);
    expect(updateReturn.error).not.toBeNull();

    const insertItem = await owner.client.from("sale_return_items").insert({
      business_id: owner.businessId,
      sale_return_id: randomUuid(),
      sale_item_id: randomUuid(),
      product_id: randomUuid(),
      product_name_snapshot: "Forged",
      quantity: 1,
      unit_price_snapshot: 1,
      line_total: 1,
      restock: false,
      position: 0,
    } as never);
    expect(insertItem.error).not.toBeNull();
  });

  for (const rpc of ["create_sale_return"] as const) {
    it(`36. ${rpc}: PUBLIC is denied EXECUTE`, async () => {
      const sql = createTestDbClient();
      try {
        const rows = await sql<{ grantee: string }[]>`
          select case when acl.grantee = 0 then 'PUBLIC' else r.rolname end as grantee
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) as acl
          left join pg_roles r on r.oid = acl.grantee
          where n.nspname = 'public' and p.proname = ${rpc} and acl.privilege_type = 'EXECUTE'
        `;
        const grantees = rows.map((r) => r.grantee);
        expect(grantees).toContain("authenticated");
        expect(grantees).not.toContain("anon");
        expect(grantees).not.toContain("PUBLIC");
        expect(grantees).not.toContain("service_role");
      } finally {
        await sql.end();
      }
    });
  }

  it("anon cannot call create_sale_return", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-acl-anon");
    cleanupUserIds.push(owner.userId);
    const anon = createAnonClient();
    const { data, error } = await createReturn(anon, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("service_role cannot call create_sale_return", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-acl-service-role");
    cleanupUserIds.push(owner.userId);
    const admin = createAdminClient();
    const { data, error } = await createReturn(admin, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("35. private_sale_return_writer is NOLOGIN/NOINHERIT/BYPASSRLS, owning exactly its own RPC", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolname, rolcanlogin, rolinherit, rolbypassrls from pg_roles
        where rolname = 'private_sale_return_writer'
      `;
      expect(roles).toHaveLength(1);
      expect(roles[0].rolcanlogin).toBe(false);
      expect(roles[0].rolinherit).toBe(false);
      expect(roles[0].rolbypassrls).toBe(true);

      const owners = await sql<{ proname: string; owner: string }[]>`
        select p.proname, r.rolname as owner
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public' and r.rolname = 'private_sale_return_writer'
      `;
      expect(owners.map((o) => o.proname)).toEqual(["create_sale_return"]);
    } finally {
      await sql.end();
    }
  });

  it("33. RLS reads: returns.view alone can read sale_returns/sale_return_items", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-rls-read");
    cleanupUserIds.push(owner.userId);
    const { data: returnId } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });

    const viewer = await createMemberWithCustomPermissions(owner.businessId, "ret-rls-read", ["returns.view"]);
    cleanupUserIds.push(viewer.userId);
    const { data: returns, error } = await viewer.client.from("sale_returns").select("id").eq("id", returnId as string);
    expect(error).toBeNull();
    expect(returns).toHaveLength(1);

    const { data: items, error: itemsError } = await viewer.client.from("sale_return_items").select("id").eq("sale_return_id", returnId as string);
    expect(itemsError).toBeNull();
    expect(items).toHaveLength(1);
  });

  it("a caller without returns.view cannot read sale_returns at all", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-rls-denied");
    cleanupUserIds.push(owner.userId);
    const { data: returnId } = await createReturn(owner.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });

    const stranger = await createMemberWithCustomPermissions(owner.businessId, "ret-rls-denied", ["sales.view"]);
    cleanupUserIds.push(stranger.userId);
    const { data: returns } = await stranger.client.from("sale_returns").select("id").eq("id", returnId as string);
    expect(returns).toHaveLength(0);
  });
});

describe("Phase 1I — permission matrix", () => {
  it.each([
    ["OWNER", true, true],
    ["ADMIN", true, true],
    ["MANAGER", true, true],
    ["SALES", true, true],
    ["ACCOUNTANT", true, false],
    ["INVENTORY", true, false],
    ["VIEWER", true, false],
  ] as const)("34. %s: returns.view=%s, returns.manage=%s", async (roleName, expectView, expectManage) => {
    const owner = await createOwnerAndBusiness(`ret-matrix-${roleName.toLowerCase()}`);
    cleanupUserIds.push(owner.userId);
    const member = await createMemberWithRole(owner.businessId, `ret-matrix-${roleName.toLowerCase()}`, roleName);
    cleanupUserIds.push(member.userId);

    const view = await member.client.rpc("has_permission", { p_business_id: owner.businessId, p_permission_key: "returns.view" });
    const manage = await member.client.rpc("has_permission", { p_business_id: owner.businessId, p_permission_key: "returns.manage" });
    expect(view.data).toBe(expectView);
    expect(manage.data).toBe(expectManage);
  });

  it("returns.manage and returns.view are independent — a returns.view-only custom role cannot call create_sale_return", async () => {
    const { owner, saleId, saleItemId } = await setupPaidSale("ret-independent-perms");
    cleanupUserIds.push(owner.userId);
    const roleName = await createRoleWithPermissions(["returns.view"]);
    void roleName;
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "ret-independent-perms", ["returns.view"]);
    cleanupUserIds.push(viewer.userId);
    const { error } = await createReturn(viewer.client, { businessId: owner.businessId, saleId, items: [returnItem(saleItemId, 1, false)] });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

// Deterministic concurrency — real lock observation, never timing-based
// Promise.all alone. Mirrors invoice-payment-rpc.test.ts's own "25b"/SEC-03
// barrier technique exactly: two independent raw Postgres connections, tx1
// fully awaited and held open, tx2 dispatched unawaited with .catch()
// attached immediately, a bounded poll of pg_stat_activity confirms tx2 is
// GENUINELY blocked on a row lock (never inferred from timing), only THEN
// is tx1 committed, and tx2's outcome is asserted afterward.
describe("create_sale_return — deterministic concurrency (real lock observation)", () => {
  it("return-quantity race: sale item qty=5, two concurrent returns of 3 each — only one may succeed, final total never exceeds 5", async () => {
    const owner = await createOwnerAndBusiness("ret-qty-race");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 100 })).id;
    const { data: saleId } = await createSale(owner.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 5 }] });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const saleItemId = saleItems![0].id as string;

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Fully awaited: tx1's entire call — permission check, sale/item
      // locking, the return-quantity invariant check, header + line
      // inserts — is complete. The row locks it took (on `sales` and on
      // this `sale_items` row) remain held until explicitly committed
      // below.
      const r1 = await c1`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId as string}::uuid,
          ${c1.json([{ sale_item_id: saleItemId, quantity: 3, restock: false }])},
          0::numeric, null::text, null::text, null::text
        ) as return_id
      `;
      expect(r1[0]?.return_id).toBeTruthy();

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      const p2 = c2`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId as string}::uuid,
          ${c2.json([{ sale_item_id: saleItemId, quantity: 3, restock: false }])},
          0::numeric, null::text, null::text, null::text
        ) as return_id
      `;
      p2.catch(() => {});

      const blocked = await waitForLock(c1, c2pid);
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (create_sale_return) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
        );
      }

      await c1`commit`;

      let err2: { message: string } | null = null;
      try {
        await p2;
      } catch (e) {
        err2 = e as { message: string };
      }
      try {
        await c2`commit`;
      } catch {
        await c2`rollback`.catch(() => {});
      }

      expect(err2?.message).toContain("RETURN_QUANTITY_EXCEEDED");
    } finally {
      await c1.end();
      await c2.end();
    }

    const { data: returnItems } = await owner.client
      .from("sale_return_items")
      .select("quantity")
      .eq("sale_item_id", saleItemId);
    expect(returnItems).toHaveLength(1);
    const totalReturned = returnItems!.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(totalReturned).toBeLessThanOrEqual(5);
  });

  it("refund-amount race: sale amount_paid=100, two concurrent refund attempts of 70 and 50 — cumulative never reaches 120", async () => {
    const owner = await createOwnerAndBusiness("ret-refund-race");
    cleanupUserIds.push(owner.userId);
    // Selling price high enough that neither refund attempt is anywhere
    // near its OWN line's return-value basis — the only invariant this
    // test isolates is the cumulative refund-vs-amount_paid ceiling.
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 })).id;
    const { data: saleId } = await createSale(owner.client, {
      businessId: owner.businessId,
      items: [{ product_id: product, quantity: 2 }],
      paymentStatus: "PARTIALLY_PAID",
      paymentMethod: "CASH",
      amountPaid: 100,
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const saleItemId = saleItems![0].id as string;

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Fully awaited: tx1's own return of 1 unit with a 70 refund is
      // fully committed-pending — the `sales` row's FOR UPDATE lock (taken
      // to read/re-check amount_paid and the cumulative refund total)
      // remains held until explicitly committed below.
      const r1 = await c1`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId as string}::uuid,
          ${c1.json([{ sale_item_id: saleItemId, quantity: 1, restock: false }])},
          70::numeric, 'CASH'::text, null::text, null::text
        ) as return_id
      `;
      expect(r1[0]?.return_id).toBeTruthy();

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      const p2 = c2`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId as string}::uuid,
          ${c2.json([{ sale_item_id: saleItemId, quantity: 1, restock: false }])},
          50::numeric, 'CASH'::text, null::text, null::text
        ) as return_id
      `;
      p2.catch(() => {});

      const blocked = await waitForLock(c1, c2pid);
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (create_sale_return) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
        );
      }

      await c1`commit`;

      let err2: { message: string } | null = null;
      try {
        await p2;
      } catch (e) {
        err2 = e as { message: string };
      }
      try {
        await c2`commit`;
      } catch {
        await c2`rollback`.catch(() => {});
      }

      expect(err2?.message).toContain("RETURN_REFUND_EXCEEDED");
    } finally {
      await c1.end();
      await c2.end();
    }

    const { data: returns } = await owner.client.from("sale_returns").select("refund_amount").eq("sale_id", saleId as string);
    const cumulative = returns!.reduce((sum, row) => sum + Number(row.refund_amount), 0);
    expect(cumulative).toBe(70);
    expect(cumulative).toBeLessThan(120);
  });

  // Return-number allocation concurrency is already covered by real
  // concurrency (test 28, Promise.all) — the sequence table's own
  // INSERT...ON CONFLICT DO UPDATE...RETURNING pattern (identical to
  // sales'/invoices') serializes on that ONE row per business, so a
  // dedicated lock-observation test would only re-prove the same
  // mechanism test 28 already exercises under real concurrency.

  it("inventory restock concurrency: two concurrent restocking returns against the same product/location never lose an update (reuses apply_inventory_movement's own locked ledger)", async () => {
    const owner = await createOwnerAndBusiness("ret-inventory-race");
    cleanupUserIds.push(owner.userId);
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 100, openingQuantity: 100 })).id;
    const { data: saleId } = await createSale(owner.client, { businessId: owner.businessId, items: [{ product_id: product, quantity: 10 }] });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const saleItemId = saleItems![0].id as string;
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, defaultBranch);
    const { data: before } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();

    // Two SEPARATE returns (each returning a different slice of the same
    // sale_item's own remaining quantity), both with restock=true,
    // dispatched genuinely concurrently — apply_inventory_movement's own
    // FOR UPDATE balance lock (not a second, independent mutation path)
    // is what must serialize these two ledger writes safely.
    const results = await Promise.all([
      createReturn(owner.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItemId, 3, true)] }),
      createReturn(owner.client, { businessId: owner.businessId, saleId: saleId as string, items: [returnItem(saleItemId, 2, true)] }),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);

    const { data: after } = await owner.client.from("inventory_balances").select("quantity").eq("inventory_location_id", locationId).eq("product_id", product).single();
    // 100 opening - 10 sold + 3 + 2 restocked = 95, regardless of which
    // transaction's ledger write was serialized first.
    expect(Number(after?.quantity)).toBe(Number(before?.quantity) + 5);

    const { data: ledger } = await owner.client.from("inventory_ledger").select("id").eq("reference_type", "sale_return").eq("movement_type", "SALE_RETURN");
    expect(ledger!.length).toBeGreaterThanOrEqual(2);
  });
});

// Codex DB review remediation, SEC-01I ("Branch deactivation lifecycle
// race", MEDIUM) — permanent regression coverage. Mirrors
// invoice-payment-rpc.test.ts's own SEC-03 branch-deactivation-race tests
// exactly, adapted to create_sale_return.
describe("create_sale_return — SEC-01I: branch deactivation lifecycle race", () => {
  async function setupBranchBFixture(prefix: string) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchB = await createBranch(owner.client, owner.businessId, { name: `${prefix}-branch-b` });
    // Not tracking inventory: this suite proves branch-lifecycle
    // serialization, never stock deduction/restock mechanics (already
    // covered elsewhere).
    const product = (await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, trackInventory: false })).id;
    const worker = await createMemberWithCustomPermissions(owner.businessId, `${prefix}-worker`, ["sales.create", "returns.manage"]);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);
    const { data: saleId, error: saleErr } = await createSale(worker.client, {
      businessId: owner.businessId,
      items: [{ product_id: product, quantity: 3 }],
      branchId: branchB,
    });
    if (saleErr || !saleId) throw new Error(`fixture sale creation failed: ${saleErr?.message}`);
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    return { owner, worker, branchB, product, saleId: saleId as string, saleItemId: saleItems![0].id as string };
  }

  it("primary race: create_sale_return genuinely BLOCKS on a concurrent branch deactivation's row lock, then correctly rejects (generic, non-disclosing) once it commits", async () => {
    const { owner, worker, branchB, product, saleId, saleItemId } = await setupBranchBFixture("ret-sec01i-primary");
    cleanupUserIds.push(owner.userId, worker.userId);

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Fully awaited: deactivate_business_branch's own FOR UPDATE lock
      // acquisition, its status/is_default checks, and its UPDATE are all
      // complete. The row lock remains held until explicitly committed
      // below.
      const r1 = await c1`select deactivate_business_branch(${owner.businessId}::uuid, ${branchB}::uuid) as branch_id`;
      expect(r1[0]?.branch_id).toBe(branchB);

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${worker.userId}, true)`;
      // Dispatched but NOT awaited yet — .catch() attached immediately.
      const p2 = c2`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId}::uuid,
          ${c2.json([{ sale_item_id: saleItemId, quantity: 1, restock: false }])},
          0::numeric, null::text, null::text, null::text
        ) as return_id
      `;
      p2.catch(() => {});

      const blocked = await waitForLock(c1, c2pid);
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (create_sale_return) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
        );
      }

      await c1`commit`;

      let err2: { message: string } | null = null;
      try {
        await p2;
      } catch (e) {
        err2 = e as { message: string };
      }
      try {
        await c2`commit`;
      } catch {
        await c2`rollback`.catch(() => {});
      }

      // tx2 unblocked, re-read the NOW-COMMITTED (post-deactivation)
      // branch state — never a stale snapshot — and correctly rejected,
      // with the SAME generic code a nonexistent sale would produce
      // (never a distinguishable "branch became inactive" disclosure).
      expect(err2?.message).toContain("RETURN_SALE_NOT_FOUND");
    } finally {
      await c1.end();
      await c2.end();
    }

    // Whole-transaction atomicity: NOTHING from tx2 survives.
    const { data: branch } = await owner.client.from("business_branches").select("status").eq("id", branchB).single();
    expect(branch?.status).toBe("INACTIVE");
    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(0);
    const { data: items } = await owner.client.from("sale_return_items").select("id").eq("sale_item_id", saleItemId);
    expect(items).toHaveLength(0);
    const { data: ledger } = await owner.client.from("inventory_ledger").select("id").eq("movement_type", "SALE_RETURN").eq("product_id", product);
    expect(ledger).toHaveLength(0);
  });

  it("opposite-order smoke: a return that wins the branch's shared lock first forces a concurrent deactivation to wait, then both resolve coherently", async () => {
    const { owner, worker, branchB, saleId, saleItemId } = await setupBranchBFixture("ret-sec01i-opposite");
    cleanupUserIds.push(owner.userId, worker.userId);

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${worker.userId}, true)`;
      // Fully awaited: create_sale_return's entire call — including its
      // own FOR SHARE lock on business_branches, acquired while the
      // branch is still ACTIVE — is complete. That lock remains held
      // until explicitly committed below.
      const r1 = await c1`
        select create_sale_return(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${saleId}::uuid,
          ${c1.json([{ sale_item_id: saleItemId, quantity: 1, restock: false }])},
          0::numeric, null::text, null::text, null::text
        ) as return_id
      `;
      expect(r1[0]?.return_id).toBeTruthy();

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      const p2 = c2`select deactivate_business_branch(${owner.businessId}::uuid, ${branchB}::uuid) as branch_id`;
      p2.catch(() => {});

      // FOR SHARE (tx1) vs. FOR UPDATE (tx2's deactivation) genuinely
      // conflict — tx2 must wait, proving serialization holds in BOTH
      // directions, not merely the primary race's own direction.
      const blocked = await waitForLock(c1, c2pid);
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (deactivate_business_branch) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
        );
      }

      await c1`commit`;

      const r2 = await p2;
      expect(r2[0]?.branch_id).toBe(branchB);
      await c2`commit`;
    } finally {
      await c1.end();
      await c2.end();
    }

    // Coherent final state: the return exists (it legitimately won
    // serialization while the branch was still ACTIVE), and the branch is
    // now inactive — a later state change never retroactively invalidates
    // a return that already committed under the correct, prior state.
    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
    const { data: branch } = await owner.client.from("business_branches").select("status").eq("id", branchB).single();
    expect(branch?.status).toBe("INACTIVE");
  });

  it("authorization replay: an exact replay after the caller's own returns.manage is revoked is still DENIED — replay never bypasses current caller standing", async () => {
    const { owner, worker, saleId, saleItemId } = await setupBranchBFixture("ret-sec01i-authz-replay");
    cleanupUserIds.push(owner.userId, worker.userId);
    const creationKey = randomUuid();

    const first = await createReturn(worker.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      creationKey,
    });
    expect(first.error).toBeNull();

    // Revoke the worker's own returns.manage — a fresh, EMPTY custom role,
    // via the real replace_member_role-equivalent path (a direct role_id
    // swap is the only mechanism available; this is fixture setup, not an
    // assertion, matching this project's own established convention for
    // membership-state fixtures).
    const emptyRoleName = await createRoleWithPermissions([]);
    const sql = createTestDbClient();
    try {
      await sql`
        update public.business_members bm
        set role_id = r.id
        from public.roles r
        where r.name = ${emptyRoleName}
          and bm.business_id = ${owner.businessId}
          and bm.user_id = ${worker.userId}
      `;
    } finally {
      await sql.end();
    }

    const replay = await createReturn(worker.client, {
      businessId: owner.businessId,
      saleId,
      items: [returnItem(saleItemId, 1, false)],
      creationKey,
    });
    expect(replay.error?.message).toContain("insufficient_privilege");

    // The original return is untouched — authorization replay denial is a
    // pure "this call is denied", never a side effect on the prior result.
    const { data: returns } = await owner.client.from("sale_returns").select("id").eq("sale_id", saleId);
    expect(returns).toHaveLength(1);
    expect(returns![0].id).toBe(first.data);
  });
});
