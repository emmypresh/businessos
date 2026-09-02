import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";
import { makeExpenseCategory } from "./helpers/expenses";
import { createBranch, getDefaultBranchId, getBranchLocationId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1J — instrumentation proof. Every mutation instrumented by
// 20260902100000_instrument_core_audit_events.sql is exercised here
// through the REAL, authenticated RPC path (never service-role-created
// fixtures for the mutation itself — the auth path matters, per this
// round's own explicit instruction), proving: exactly one event, correct
// action/category/resource/branch/actor/business, minimal metadata, no
// event on a failed mutation, and no duplicate event on an exact replay
// where the underlying RPC supports one.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

async function eventsFor(businessId: string, action: string, resourceId?: string) {
  const sql = createTestDbClient();
  try {
    const rows = await sql<
      {
        id: string;
        business_id: string;
        branch_id: string | null;
        actor_type: string;
        actor_user_id: string | null;
        actor_email_snapshot: string | null;
        action: string;
        category: string;
        resource_type: string | null;
        resource_id: string | null;
        resource_label_snapshot: string | null;
        outcome: string;
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, business_id, branch_id, actor_type, actor_user_id, actor_email_snapshot,
             action, category, resource_type, resource_id, resource_label_snapshot, outcome, metadata
      from public.audit_events
      where business_id = ${businessId} and action = ${action}
        ${resourceId ? sql`and resource_id = ${resourceId}` : sql``}
    `;
    return rows;
  } finally {
    await sql.end();
  }
}

describe("Phase 1J instrumentation — sale.created", () => {
  it("records exactly one correct event; a failed sale creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-sale");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, openingQuantity: 5 });

    // Failed mutation: insufficient stock — must create zero events.
    const failed = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 999 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(failed.error).not.toBeNull();

    const creationKey = randomUuid();
    const { data: saleId, error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [{ product_id: product.id, quantity: 2 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(error).toBeNull();

    let events = await eventsFor(owner.businessId, "sale.created");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.resource_type).toBe("sale");
    expect(event.resource_id).toBe(saleId);
    expect(event.category).toBe("COMMERCE");
    expect(event.branch_id).toBe(branchA);
    expect(event.actor_type).toBe("USER");
    expect(event.actor_user_id).toBe(owner.userId);
    expect(event.actor_email_snapshot).toBe(owner.email);
    expect(event.outcome).toBe("SUCCESS");
    expect(Number(event.metadata.total_amount)).toBe(2000);
    expect(Number(event.metadata.amount_paid)).toBe(2000);
    expect(event.metadata.item_count).toBe(1);

    // Exact replay — same creation key, same payload.
    const replay = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_items: [{ product_id: product.id, quantity: 2 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(replay.data).toBe(saleId);
    events = await eventsFor(owner.businessId, "sale.created");
    expect(events).toHaveLength(1);
  });

  it("wrong-tenant/wrong-branch mutation attempt creates no event", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-sale-wrongbranch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Audit Instr Branch B" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "audit-instr-sale-wrongbranch", ["sales.create"]);
    cleanupUserIds.push(worker.userId);
    // worker is assigned only to the default branch, never branchB.
    const { error } = await worker.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 1 }],
      p_branch_id: branchB,
    });
    expect(error).not.toBeNull();
    const events = await eventsFor(owner.businessId, "sale.created");
    expect(events).toHaveLength(0);
  });
});

describe("Phase 1J instrumentation — return.created", () => {
  it("records exactly one correct event; a failed return creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-return");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000, openingQuantity: 5 });
    const { data: saleId } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [{ product_id: product.id, quantity: 3 }],
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    const { data: saleItems } = await owner.client.from("sale_items").select("id").eq("sale_id", saleId as string);
    const saleItemId = saleItems![0].id as string;

    // Failed mutation: over-return.
    const failed = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId as string,
      p_items: [{ sale_item_id: saleItemId, quantity: 999, restock: true }],
      p_refund_amount: 0,
    });
    expect(failed.error).not.toBeNull();

    const creationKey = randomUuid();
    const { data: returnId, error } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_sale_id: saleId as string,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: true }],
      p_refund_amount: 1000,
      p_refund_method: "CASH",
      p_reason: "DAMAGED",
    });
    expect(error).toBeNull();

    let events = await eventsFor(owner.businessId, "return.created");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.resource_type).toBe("sale_return");
    expect(event.resource_id).toBe(returnId);
    expect(event.category).toBe("COMMERCE");
    expect(event.branch_id).toBe(branchA);
    expect(event.actor_user_id).toBe(owner.userId);
    expect(Number(event.metadata.refund_amount)).toBe(1000);
    expect(event.metadata.reason).toBe("DAMAGED");
    expect(event.metadata.restocked_item_count).toBe(1);

    const replay = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_sale_id: saleId as string,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: true }],
      p_refund_amount: 1000,
      p_refund_method: "CASH",
      p_reason: "DAMAGED",
    });
    expect(replay.data).toBe(returnId);
    events = await eventsFor(owner.businessId, "return.created");
    expect(events).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — expense.posted", () => {
  it("records exactly one correct event; a failed expense creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-expense");
    cleanupUserIds.push(owner.userId);
    const categoryId = await makeExpenseCategory(owner.client, owner.businessId, { name: "Audit Category" });

    const failed = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_category_id: categoryId,
      p_amount: -5,
      p_payment_method: "CASH",
      p_incurred_at: new Date().toISOString(),
    });
    expect(failed.error).not.toBeNull();

    const creationKey = randomUuid();
    const incurredAt = new Date().toISOString();
    const { data: expenseId, error } = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_category_id: categoryId,
      p_amount: 750,
      p_payment_method: "CASH",
      p_incurred_at: incurredAt,
      p_payee: "Audit Payee",
    });
    expect(error).toBeNull();

    let events = await eventsFor(owner.businessId, "expense.posted");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.resource_type).toBe("expense");
    expect(event.resource_id).toBe(expenseId);
    expect(event.category).toBe("FINANCE");
    expect(event.branch_id).toBeNull();
    expect(event.resource_label_snapshot).toBe("Audit Payee");
    expect(Number(event.metadata.amount)).toBe(750);
    expect(event.metadata.category).toBe("Audit Category");

    const replay = await owner.client.rpc("create_expense", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_category_id: categoryId,
      p_amount: 750,
      p_payment_method: "CASH",
      p_incurred_at: incurredAt,
      p_payee: "Audit Payee",
    });
    void replay;
    events = await eventsFor(owner.businessId, "expense.posted");
    expect(events).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — invoice.created and payment.recorded", () => {
  it("records exactly one correct event each; failed mutations create none; exact replays create no duplicates", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-invoice");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Audit Invoice Customer" });

    const failedInvoice = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchA,
      p_items: [],
    });
    expect(failedInvoice.error).not.toBeNull();

    const invoiceKey = randomUuid();
    const { data: invoiceId, error: invoiceErr } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: invoiceKey,
      p_customer_id: customerId,
      p_branch_id: branchA,
      p_items: [{ description: "Audit service", quantity: 1, unit_price: 3000 }],
    });
    expect(invoiceErr).toBeNull();

    let invoiceEvents = await eventsFor(owner.businessId, "invoice.created");
    expect(invoiceEvents).toHaveLength(1);
    expect(invoiceEvents[0].resource_id).toBe(invoiceId);
    expect(invoiceEvents[0].category).toBe("FINANCE");
    expect(invoiceEvents[0].branch_id).toBe(branchA);
    expect(Number(invoiceEvents[0].metadata.total_amount)).toBe(3000);
    expect(invoiceEvents[0].metadata.item_count).toBe(1);

    const invoiceReplay = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: invoiceKey,
      p_customer_id: customerId,
      p_branch_id: branchA,
      p_items: [{ description: "Audit service", quantity: 1, unit_price: 3000 }],
    });
    expect(invoiceReplay.data).toBe(invoiceId);
    invoiceEvents = await eventsFor(owner.businessId, "invoice.created");
    expect(invoiceEvents).toHaveLength(1);

    // payment.recorded
    const failedPayment = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 999999,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(failedPayment.error).not.toBeNull();

    const paymentKey = randomUuid();
    const paidAt = new Date().toISOString();
    const { data: paymentId, error: paymentErr } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: paymentKey,
      p_invoice_id: invoiceId as string,
      p_amount: 1000,
      p_payment_method: "BANK_TRANSFER",
      p_paid_at: paidAt,
    });
    expect(paymentErr).toBeNull();

    let paymentEvents = await eventsFor(owner.businessId, "payment.recorded");
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].resource_id).toBe(paymentId);
    expect(paymentEvents[0].category).toBe("FINANCE");
    expect(paymentEvents[0].branch_id).toBe(branchA);
    expect(Number(paymentEvents[0].metadata.amount)).toBe(1000);
    expect(paymentEvents[0].metadata.method).toBe("BANK_TRANSFER");

    const paymentReplay = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: paymentKey,
      p_invoice_id: invoiceId as string,
      p_amount: 1000,
      p_payment_method: "BANK_TRANSFER",
      p_paid_at: paidAt,
    });
    void paymentReplay;
    paymentEvents = await eventsFor(owner.businessId, "payment.recorded");
    expect(paymentEvents).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — inventory.adjusted", () => {
  it("records exactly one event for a manual adjustment; a failed adjustment creates none; OPENING_STOCK never creates one", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-inventory");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, branchA);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });

    // product.created + the bundled OPENING_STOCK movement above must
    // never produce an inventory.adjusted event.
    let events = await eventsFor(owner.businessId, "inventory.adjusted");
    expect(events).toHaveLength(0);

    const failed = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_OUT",
      p_quantity: 999999,
      p_idempotency_key: randomUuid(),
      p_reason: "Too much",
    });
    expect(failed.error).not.toBeNull();
    events = await eventsFor(owner.businessId, "inventory.adjusted");
    expect(events).toHaveLength(0);

    const { error } = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 4,
      p_idempotency_key: randomUuid(),
      p_reason: "Stock count correction",
    });
    expect(error).toBeNull();

    events = await eventsFor(owner.businessId, "inventory.adjusted", product.id);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("INVENTORY");
    expect(events[0].branch_id).toBe(branchA);
    expect(Number(events[0].metadata.quantity_delta)).toBe(4);
    expect(events[0].metadata.movement_type).toBe("ADJUSTMENT_IN");
  });

  it("an exact idempotent replay of a manual adjustment creates no duplicate event", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-inventory-replay");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const locationId = await getBranchLocationId(owner.businessId, branchA);
    const product = await makeSaleProduct(owner.client, owner.businessId, { openingQuantity: 10 });
    const idempotencyKey = randomUuid();

    const first = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 3,
      p_idempotency_key: idempotencyKey,
      p_reason: "Replay test",
    });
    expect(first.error).toBeNull();

    const second = await owner.client.rpc("record_inventory_movement", {
      p_business_id: owner.businessId,
      p_product_id: product.id,
      p_inventory_location_id: locationId,
      p_movement_type: "ADJUSTMENT_IN",
      p_quantity: 3,
      p_idempotency_key: idempotencyKey,
      p_reason: "Replay test",
    });
    expect(second.error).toBeNull();

    const events = await eventsFor(owner.businessId, "inventory.adjusted", product.id);
    expect(events).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — customer.created", () => {
  it("records exactly one correct event; a failed customer creation creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-customer");
    cleanupUserIds.push(owner.userId);

    const failed = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "",
    });
    expect(failed.error).not.toBeNull();

    const creationKey = randomUuid();
    const { data: customerId, error } = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_name: "Audit Customer",
    });
    expect(error).toBeNull();

    let events = await eventsFor(owner.businessId, "customer.created");
    expect(events).toHaveLength(1);
    expect(events[0].resource_id).toBe(customerId);
    expect(events[0].category).toBe("CUSTOMER");
    expect(events[0].branch_id).toBeNull();
    expect(events[0].resource_label_snapshot).toBe("Audit Customer");

    const replay = await owner.client.rpc("create_customer", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_name: "Audit Customer",
    });
    expect(replay.data).toBe(customerId);
    events = await eventsFor(owner.businessId, "customer.created");
    expect(events).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — branch.created and branch.deactivated", () => {
  it("records exactly one event each; a failed deactivation creates none; a no-op re-deactivation creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-branch");
    cleanupUserIds.push(owner.userId);

    const { data: branchId, error: createErr } = await owner.client.rpc("create_business_branch", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "Audit Branch",
    });
    expect(createErr).toBeNull();

    const createdEvents = await eventsFor(owner.businessId, "branch.created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].resource_id).toBe(branchId);
    expect(createdEvents[0].branch_id).toBe(branchId);
    expect(createdEvents[0].category).toBe("ORGANIZATION");
    expect(createdEvents[0].resource_label_snapshot).toBe("Audit Branch");

    // Failed: the DEFAULT branch cannot be deactivated.
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);
    const failedDeactivate = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: defaultBranch,
    });
    expect(failedDeactivate.error).not.toBeNull();
    expect(await eventsFor(owner.businessId, "branch.deactivated")).toHaveLength(0);

    const { error: deactivateErr } = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchId as string,
    });
    expect(deactivateErr).toBeNull();

    let deactivatedEvents = await eventsFor(owner.businessId, "branch.deactivated");
    expect(deactivatedEvents).toHaveLength(1);
    expect(deactivatedEvents[0].resource_id).toBe(branchId);
    expect(deactivatedEvents[0].resource_label_snapshot).toBe("Audit Branch");

    // Deactivating an already-inactive branch is a documented no-op —
    // must create no duplicate event.
    const { data: noopResult, error: noopErr } = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchId as string,
    });
    expect(noopErr).toBeNull();
    expect(noopResult).toBe(branchId);
    deactivatedEvents = await eventsFor(owner.businessId, "branch.deactivated");
    expect(deactivatedEvents).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — staff.invited", () => {
  it("records exactly one correct event; a failed invitation creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-staff");
    cleanupUserIds.push(owner.userId);
    const defaultBranch = await getDefaultBranchId(owner.client, owner.businessId);

    const failed = await owner.client.rpc("create_business_invitation", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_email: "not-an-email",
      p_role: "MANAGER",
      p_branch_ids: [defaultBranch],
      p_primary_branch_id: defaultBranch,
    });
    expect(failed.error).not.toBeNull();

    const email = `audit-invitee-${randomUuid()}@example.test`;
    const creationKey = randomUuid();
    const { data: invitationId, error } = await owner.client.rpc("create_business_invitation", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_email: email,
      p_role: "MANAGER",
      p_branch_ids: [defaultBranch],
      p_primary_branch_id: defaultBranch,
    });
    expect(error).toBeNull();

    let events = await eventsFor(owner.businessId, "staff.invited");
    expect(events).toHaveLength(1);
    expect(events[0].resource_id).toBe(invitationId);
    expect(events[0].category).toBe("ORGANIZATION");
    expect(events[0].branch_id).toBe(defaultBranch);
    expect(events[0].resource_label_snapshot).toBe(email);
    expect(events[0].metadata.role).toBe("MANAGER");
    expect(events[0].metadata.branch_count).toBe(1);

    const replay = await owner.client.rpc("create_business_invitation", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_email: email,
      p_role: "MANAGER",
      p_branch_ids: [defaultBranch],
      p_primary_branch_id: defaultBranch,
    });
    expect(replay.data).toBe(invitationId);
    events = await eventsFor(owner.businessId, "staff.invited");
    expect(events).toHaveLength(1);
  });
});

describe("Phase 1J instrumentation — product.created", () => {
  it("records exactly one correct event; a failed product creation creates none; an exact replay creates no duplicate", async () => {
    const owner = await createOwnerAndBusiness("audit-instr-product");
    cleanupUserIds.push(owner.userId);

    const failed = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_name: "x", // too short
    });
    expect(failed.error).not.toBeNull();

    const creationKey = randomUuid();
    const { data: product, error } = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_name: "Audit Product",
      p_sku: `audit-${randomUuid()}`,
      p_selling_price: 500,
      p_cost_price: 250,
    });
    expect(error).toBeNull();
    if (!product) throw new Error("create_product returned no row");

    let events = await eventsFor(owner.businessId, "product.created");
    expect(events).toHaveLength(1);
    expect(events[0].resource_id).toBe(product.id);
    expect(events[0].category).toBe("INVENTORY");
    expect(events[0].branch_id).toBeNull();
    expect(events[0].resource_label_snapshot).toBe("Audit Product");
    // No cost anywhere in the metadata.
    expect(JSON.stringify(events[0].metadata)).not.toContain("250");
    expect(events[0].metadata).toEqual({});

    const replay = await owner.client.rpc("create_product", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_name: "Audit Product",
      p_sku: `audit-${randomUuid()}`, // irrelevant on replay — full payload comparison governs
      p_selling_price: 500,
      p_cost_price: 250,
    });
    void replay;
    events = await eventsFor(owner.businessId, "product.created");
    expect(events).toHaveLength(1);
  });
});
