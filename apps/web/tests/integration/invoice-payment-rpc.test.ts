import { describe, expect, it, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient, deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";
import { createBranch, getDefaultBranchId, assignMemberToBranch, getMemberId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";
import { assertLocalSupabaseUrl } from "./helpers/url-safety";

// Phase 1H — DATABASE FOUNDATION. Exercises create_invoice,
// record_invoice_payment, and void_invoice directly against a real
// database, independent of the application layer — mirrors this
// project's own established pattern (branch-option-rpc.test.ts,
// invitation-branch-options.test.ts).

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

function invoiceItem(productId: string, quantity: number) {
  return { product_id: productId, quantity };
}

async function createInvoice(
  client: ReturnType<typeof createAnonClient>,
  overrides: {
    businessId: string;
    customerId: string;
    branchId: string;
    items: unknown[];
    dueDate?: string;
    notes?: string;
    creationKey?: string;
  }
) {
  return client.rpc("create_invoice", {
    p_business_id: overrides.businessId,
    p_creation_key: overrides.creationKey ?? randomUuid(),
    p_customer_id: overrides.customerId,
    p_branch_id: overrides.branchId,
    p_items: overrides.items,
    p_due_date: overrides.dueDate ?? null,
    p_notes: overrides.notes ?? null,
  });
}

describe("create_invoice — authorization and validation", () => {
  it("1. an authorized member (invoices.manage) creates an invoice successfully", async () => {
    const owner = await createOwnerAndBusiness("inv-create-authorized");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500 });

    const { data, error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 2)],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: invoice } = await owner.client
      .from("invoices")
      .select("total_amount, status, invoice_number")
      .eq("id", data as string)
      .single();
    expect(Number(invoice?.total_amount)).toBe(1000);
    expect(invoice?.status).toBe("ISSUED");
    expect(invoice?.invoice_number).toMatch(/^INV-\d{6}$/);
  });

  it("2. a caller without invoices.manage is denied", async () => {
    const owner = await createOwnerAndBusiness("inv-create-unauthorized");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "inv-create-unauthorized", ["invoices.view"]);
    cleanupUserIds.push(viewer.userId);

    const { error } = await createInvoice(viewer.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("3. a cross-tenant customer id is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-cross-customer-a");
    const stranger = await createOwnerAndBusiness("inv-create-cross-customer-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const strangerCustomerId = await makeCustomer(stranger.client, stranger.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId: strangerCustomerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("CUSTOMER_NOT_FOUND");
  });

  it("4. a cross-tenant branch id is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-cross-branch-a");
    const stranger = await createOwnerAndBusiness("inv-create-cross-branch-b");
    cleanupUserIds.push(owner.userId, stranger.userId);
    const strangerBranchId = await getDefaultBranchId(stranger.client, stranger.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: strangerBranchId,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("BRANCH_NOT_FOUND");
  });

  it("5. a real branch the caller has no operational access to is denied — invoices.manage alone is not enough", async () => {
    const owner = await createOwnerAndBusiness("inv-create-inaccessible-branch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Inaccessible Branch" });
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    // A SALES member (has invoices.manage + sales.create) never assigned
    // to branchB.
    const seller = await createMemberWithCustomPermissions(owner.businessId, "inv-create-inaccessible-branch", [
      "invoices.manage",
      "sales.create",
    ]);
    cleanupUserIds.push(seller.userId);

    const { error } = await createInvoice(seller.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchB,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("6. an inactive branch is rejected the same way as a nonexistent one", async () => {
    const owner = await createOwnerAndBusiness("inv-create-inactive-branch");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Deactivated Invoice Branch" });
    await owner.client.rpc("deactivate_business_branch", { p_business_id: owner.businessId, p_branch_id: branchB });
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchB,
      items: [invoiceItem(product.id, 1)],
    });
    // The OWNER's own has_branch_access is revoked the instant the branch
    // deactivates (Phase 1F's own live-derived access design) — same
    // generic insufficient_privilege as Test 5, not a distinct message.
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("7. duplicate product lines in the same invoice are rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-duplicate-lines");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1), invoiceItem(product.id, 2)],
    });
    expect(error?.message).toContain("DUPLICATE_PRODUCT_LINE");
  });

  it("8. unit price is server-authoritative (current selling_price) — a forged unit_price on a product line is ignored", async () => {
    const owner = await createOwnerAndBusiness("inv-create-authoritative-price");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 750 });

    const { data } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      // unit_price is not even part of a product-linked line's accepted
      // shape — this proves a forged value here has no effect at all.
      items: [{ product_id: product.id, quantity: 3, unit_price: 1 }],
    });
    const { data: items } = await owner.client
      .from("invoice_items")
      .select("unit_price, line_total")
      .eq("invoice_id", data as string);
    expect(Number(items?.[0].unit_price)).toBe(750);
    expect(Number(items?.[0].line_total)).toBe(2250);
  });

  it("9. an archived product is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-archived-product");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { trackInventory: false });
    await owner.client.from("products").update({ status: "archived" }).eq("id", product.id);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("PRODUCT_ARCHIVED");
  });

  it("10. an archived customer is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-archived-customer");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    await owner.client.from("customers").update({ status: "archived" }).eq("id", customerId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(error?.message).toContain("CUSTOMER_ARCHIVED");
  });

  it("11. a custom (no product_id) line requires its own description and unit_price, and is priced exactly as given", async () => {
    const owner = await createOwnerAndBusiness("inv-create-custom-line");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const { data, error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Delivery fee", quantity: 1, unit_price: 2500 }],
    });
    expect(error).toBeNull();
    const { data: items } = await owner.client
      .from("invoice_items")
      .select("product_id, description, unit_price, line_total")
      .eq("invoice_id", data as string);
    expect(items?.[0].product_id).toBeNull();
    expect(items?.[0].description).toBe("Delivery fee");
    expect(Number(items?.[0].unit_price)).toBe(2500);
  });

  // Codex adversarial review, remediation round 1, Medium 1: a custom
  // line's unit_price must be REJECTED at the DB boundary independently
  // of app-layer validation — 1.999 must never be silently coerced to
  // 2.00. Exact vectors from the review itself.
  describe("custom line unit_price precision (Medium 1, DB boundary)", () => {
    it.each([0.01, 1, 1.5, 1.99])("accepts unit_price %s", async (unitPrice) => {
      const owner = await createOwnerAndBusiness("inv-price-precision-ok");
      cleanupUserIds.push(owner.userId);
      const branchA = await getDefaultBranchId(owner.client, owner.businessId);
      const customerId = await makeCustomer(owner.client, owner.businessId);

      const { error } = await createInvoice(owner.client, {
        businessId: owner.businessId,
        customerId,
        branchId: branchA,
        items: [{ description: "Custom line", quantity: 1, unit_price: unitPrice }],
      });
      expect(error).toBeNull();
    });

    it.each([1.999, 0.005, 100.001])("rejects unit_price %s — never silently rounded", async (unitPrice) => {
      const owner = await createOwnerAndBusiness("inv-price-precision-bad");
      cleanupUserIds.push(owner.userId);
      const branchA = await getDefaultBranchId(owner.client, owner.businessId);
      const customerId = await makeCustomer(owner.client, owner.businessId);

      const { error } = await createInvoice(owner.client, {
        businessId: owner.businessId,
        customerId,
        branchId: branchA,
        items: [{ description: "Custom line", quantity: 1, unit_price: unitPrice }],
      });
      expect(error?.message).toContain("MALFORMED_INVOICE_ITEMS");
    });
  });

  // Codex adversarial review, remediation round 2, Finding 5.6: the
  // caller's OWN submitted item order must survive storage — persisted
  // via the `position` column, assigned 0-based from submission order.
  // Strengthened to THREE lines whose submitted order, lexical
  // (description-alphabetical) order, and insertion timestamps cannot
  // accidentally agree with each other:
  //   - submitted order:  Zebra, Apple, Mango   (0, 1, 2)
  //   - lexical order:    Apple, Mango, Zebra   (a completely different
  //                       permutation — if position were ever derived
  //                       from a `order by description` sort instead of
  //                       submission order, this test would catch it)
  //   - timestamp order:  all three rows are inserted inside the SAME
  //                       create_invoice transaction/statement, so their
  //                       created_at values are identical (or differ by
  //                       less than clock resolution) — asserted below —
  //                       meaning created_at could never have been a
  //                       reliable ordering key even by accident.
  it("Low 5: invoice item position (3 lines) reflects the caller's own submitted order, never lexical or timestamp order", async () => {
    const owner = await createOwnerAndBusiness("inv-item-position-3");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const { data: invoiceId, error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [
        { description: "Zebra Item", quantity: 1, unit_price: 300 },
        { description: "Apple Item", quantity: 1, unit_price: 100 },
        { description: "Mango Item", quantity: 1, unit_price: 200 },
      ],
    });
    expect(error).toBeNull();

    const { data: items } = await owner.client
      .from("invoice_items")
      .select("description, position, created_at")
      .eq("invoice_id", invoiceId as string)
      .order("position", { ascending: true });

    // Exact submitted order, exact positions — never re-sorted
    // alphabetically ("Apple Item" would sort first) and never by
    // insertion sequence coincidence.
    expect(items).toEqual([
      { description: "Zebra Item", position: 0, created_at: items![0].created_at },
      { description: "Apple Item", position: 1, created_at: items![1].created_at },
      { description: "Mango Item", position: 2, created_at: items![2].created_at },
    ]);

    // Proves WHY position (not created_at) is the real ordering
    // authority: all three lines share the identical created_at instant
    // — a plain `order by created_at` would be genuinely ambiguous
    // (a tied sort), never a safe substitute for the explicit column.
    const timestamps = new Set(items!.map((i) => i.created_at));
    expect(timestamps.size).toBe(1);

    // The application read path (lib/invoices/dal.ts's own
    // getInvoiceItems, which orders by position) reproduces the exact
    // same submitted order end-to-end.
    const { data: appOrderedItems } = await owner.client
      .from("invoice_items")
      .select("description")
      .eq("invoice_id", invoiceId as string)
      .order("position", { ascending: true });
    expect(appOrderedItems!.map((i) => i.description)).toEqual(["Zebra Item", "Apple Item", "Mango Item"]);
  });

  it("a custom line without a description is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-custom-no-desc");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ quantity: 1, unit_price: 100 }],
    });
    expect(error?.message).toContain("MALFORMED_INVOICE_ITEMS");
  });

  it("12. invoice numbers are sequential and business-scoped, never colliding across businesses", async () => {
    const owner = await createOwnerAndBusiness("inv-numbering-a");
    const other = await createOwnerAndBusiness("inv-numbering-b");
    cleanupUserIds.push(owner.userId, other.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchOther = await getDefaultBranchId(other.client, other.businessId);
    const customerA = await makeCustomer(owner.client, owner.businessId);
    const customerOther = await makeCustomer(other.client, other.businessId);
    const productA = await makeSaleProduct(owner.client, owner.businessId);
    const productOther = await makeSaleProduct(other.client, other.businessId);

    const { data: firstId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId: customerA,
      branchId: branchA,
      items: [invoiceItem(productA.id, 1)],
    });
    const { data: secondId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId: customerA,
      branchId: branchA,
      items: [invoiceItem(productA.id, 1)],
    });
    const { data: otherBusinessId } = await createInvoice(other.client, {
      businessId: other.businessId,
      customerId: customerOther,
      branchId: branchOther,
      items: [invoiceItem(productOther.id, 1)],
    });

    const { data: first } = await owner.client.from("invoices").select("invoice_number").eq("id", firstId as string).single();
    const { data: second } = await owner.client.from("invoices").select("invoice_number").eq("id", secondId as string).single();
    const { data: otherBiz } = await other.client.from("invoices").select("invoice_number").eq("id", otherBusinessId as string).single();
    expect(first?.invoice_number).toBe("INV-000001");
    expect(second?.invoice_number).toBe("INV-000002");
    // A second, independent business starts its OWN sequence at 1 — never
    // continuing the first business's counter.
    expect(otherBiz?.invoice_number).toBe("INV-000001");
  });

  it("13. an identical retry (same creation key, same payload) returns the ORIGINAL invoice, never a second one", async () => {
    const owner = await createOwnerAndBusiness("inv-idempotent-retry");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const key = randomUuid();

    const first = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 2)],
      creationKey: key,
    });
    const second = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 2)],
      creationKey: key,
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data).toBe(second.data);

    const { data: rows } = await owner.client.from("invoices").select("id").eq("customer_id", customerId);
    expect(rows).toHaveLength(1);
  });

  it("14. the same creation key with a materially different payload is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-idempotent-mismatch");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const key = randomUuid();

    await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 2)],
      creationKey: key,
    });
    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 5)],
      creationKey: key,
    });
    expect(error?.message).toContain("INVOICE_IDEMPOTENCY_KEY_REUSED");
  });

  it("15. customer/branch snapshots are captured at creation and never re-derived from the live rows", async () => {
    const owner = await createOwnerAndBusiness("inv-snapshot-correctness");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Original Customer Name", phone: "0800000000" });
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });

    await owner.client.from("customers").update({ name: "Renamed Customer" }).eq("id", customerId);
    await owner.client.rpc("update_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchA,
      p_name: "Renamed Branch",
    });

    const { data: invoice } = await owner.client
      .from("invoices")
      .select("customer_name_snapshot, customer_phone_snapshot, branch_name_snapshot")
      .eq("id", invoiceId as string)
      .single();
    expect(invoice?.customer_name_snapshot).toBe("Original Customer Name");
    expect(invoice?.customer_phone_snapshot).toBe("0800000000");
    expect(invoice?.branch_name_snapshot).not.toBe("Renamed Branch");
  });

  // Codex adversarial review, remediation round 1, Low 7: an explicit,
  // permanent regression test for product-linked line snapshots —
  // product_name_snapshot/sku_snapshot must survive a later product
  // rename, mirroring sales.spec.ts's own identical e2e-level assertion
  // for sale_items, at the RPC/DB layer for invoices.
  it("Low 7: a product rename after invoice creation does not alter the invoice line's own name/sku snapshot", async () => {
    const owner = await createOwnerAndBusiness("inv-product-rename-snapshot");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { name: "Original Product Name" });

    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });

    // Product edits are a direct, RLS-gated (products.manage) table
    // UPDATE — no RPC — see lib/products/actions.ts's own updateProduct.
    const { error: renameErr } = await owner.client.from("products").update({ name: "Renamed Product" }).eq("id", product.id);
    expect(renameErr).toBeNull();

    const { data: items } = await owner.client
      .from("invoice_items")
      .select("product_name_snapshot, sku_snapshot")
      .eq("invoice_id", invoiceId as string);
    expect(items?.[0].product_name_snapshot).toBe("Original Product Name");
    expect(items?.[0].product_name_snapshot).not.toBe("Renamed Product");
  });

  it("a zero-total invoice (every line priced at 0) is rejected", async () => {
    const owner = await createOwnerAndBusiness("inv-create-zero-total");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const { error } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Free sample", quantity: 1, unit_price: 0 }],
    });
    expect(error?.message).toContain("INVOICE_AMOUNT_OUT_OF_RANGE");
  });
});

// Security audit remediation — SEC-03, "Branch Deactivation Race" ----------
//
// CONFIRMED RACE: create_invoice checked the target branch's active status
// and the caller's own branch access WITHOUT locking the branch row —
// a concurrent deactivate_business_branch could commit in the window
// between that check and create_invoice's own commit, leaving a
// newly-created invoice tied to a branch that is (from the moment its own
// deactivation committed) already inactive. Fixed by taking a `for share`
// lock on the branch row (and, for the identical reason, the customer row)
// BEFORE validating its current state — see create_invoice_rpc.sql's own
// header comment for the full deadlock-safety reasoning (every lock here
// is FOR SHARE; FOR SHARE never conflicts with FOR SHARE, so this can
// never participate in a deadlock cycle).
describe("Phase 1H security remediation — SEC-03: branch deactivation race", () => {
  it("SEC-03: create_invoice genuinely BLOCKS on a concurrent branch deactivation's row lock, then correctly rejects once it commits", async () => {
    const owner = await createOwnerAndBusiness("sec03-branch-race");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "SEC-03 Race Branch B" });
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const creator = await createMemberWithCustomPermissions(owner.businessId, "sec03-branch-race-creator", [
      "invoices.manage",
    ]);
    cleanupUserIds.push(creator.userId);
    const creatorMemberId = await getMemberId(owner.businessId, creator.userId);
    await assignMemberToBranch(owner.client, owner.businessId, creatorMemberId, [branchB]);

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Fully awaited: deactivate_business_branch's own `for update` lock
      // acquisition, its status/is_default checks, and its UPDATE are all
      // complete. The row lock remains held until explicitly committed
      // below.
      const r1 = await c1`select deactivate_business_branch(${owner.businessId}::uuid, ${branchB}::uuid) as branch_id`;
      expect(r1[0]?.branch_id).toBe(branchB);

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${creator.userId}, true)`;
      // Dispatched but NOT awaited yet — .catch() attached immediately to
      // flush it onto the wire (see the reference barrier's own comment,
      // test 25b above, on why an unconsumed promise can sit queued far
      // longer than this poll window tolerates).
      const p2 = c2`
        select create_invoice(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${customerId}::uuid, ${branchB}::uuid,
          ${c2.json([{ description: "Should never be created", quantity: 1, unit_price: 500 }])},
          null::date, null::text
        ) as invoice_id
      `;
      p2.catch(() => {});

      let blocked = false;
      for (let i = 0; i < 400; i++) {
        const rows = await c1<{ wait_event_type: string | null }[]>`
          select wait_event_type from pg_stat_activity where pid = ${c2pid}
        `;
        if (rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (create_invoice) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
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
      // branch state — never a stale snapshot — and correctly rejected.
      expect(err2?.message).toContain("insufficient_privilege");
    } finally {
      await c1.end();
      await c2.end();
    }

    const { data: branch } = await owner.client.from("business_branches").select("status").eq("id", branchB).single();
    expect(branch?.status).toBe("INACTIVE");
    const { data: invoices } = await owner.client.from("invoices").select("id").eq("branch_id", branchB);
    expect(invoices).toHaveLength(0);
  });

  // Codex security audit, SEC-03: the auditor's own explicit ask —
  // inspect whether customer status has the identical mutable
  // ACTIVE/ARCHIVED-for-invoice-creation rule, and if a concurrent
  // customer archive could reproduce the same defect, fix and test it
  // now. It does (CUSTOMER_ARCHIVED is rejected exactly like an inactive
  // branch is), customer status CAN change concurrently (a direct,
  // customers.manage-gated table UPDATE — lib/customers/actions.ts, no
  // RPC), and create_invoice's own customer lookup now takes the
  // identical `for share` lock for the identical reason.
  it("SEC-03: create_invoice genuinely BLOCKS on a concurrent customer archive's row lock, then correctly rejects once it commits", async () => {
    const owner = await createOwnerAndBusiness("sec03-customer-race");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "SEC-03 Race Customer" });

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      // A direct table UPDATE, exactly matching lib/customers/actions.ts's
      // own updateCustomer — customers.manage's own RLS UPDATE policy is
      // bypassed here (this raw connection is the postgres superuser),
      // but the row-lock behavior an ordinary authenticated UPDATE would
      // take is identical; only the fixture setup route differs.
      await c1`update public.customers set status = 'archived' where id = ${customerId}::uuid`;

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      const p2 = c2`
        select create_invoice(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${customerId}::uuid, ${branchA}::uuid,
          ${c2.json([{ description: "Should never be created", quantity: 1, unit_price: 500 }])},
          null::date, null::text
        ) as invoice_id
      `;
      p2.catch(() => {});

      let blocked = false;
      for (let i = 0; i < 400; i++) {
        const rows = await c1<{ wait_event_type: string | null }[]>`
          select wait_event_type from pg_stat_activity where pid = ${c2pid}
        `;
        if (rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 (create_invoice) never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
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

      expect(err2?.message).toContain("CUSTOMER_ARCHIVED");
    } finally {
      await c1.end();
      await c2.end();
    }

    const { data: invoices } = await owner.client.from("invoices").select("id").eq("customer_id", customerId);
    expect(invoices).toHaveLength(0);
  });
});

describe("record_invoice_payment — partial, full, and rejection semantics", () => {
  async function setupInvoice(prefix: string, total: number) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: total }],
    });
    return { owner, branchA, invoiceId: invoiceId as string };
  }

  it("16. a partial payment moves the invoice to PARTIALLY_PAID with the correct amount_paid", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-partial", 100000);
    cleanupUserIds.push(owner.userId);

    const { data: paymentId, error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 30000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    expect(paymentId).toBeTruthy();

    const { data: invoice } = await owner.client.from("invoices").select("status, amount_paid").eq("id", invoiceId).single();
    expect(invoice?.status).toBe("PARTIALLY_PAID");
    expect(Number(invoice?.amount_paid)).toBe(30000);
  });

  it("17. a full payment (after a partial one) moves the invoice to PAID with amount_paid = total_amount", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-full", 100000);
    cleanupUserIds.push(owner.userId);

    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 30000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    const { error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 70000,
      p_payment_method: "BANK_TRANSFER",
      p_paid_at: new Date().toISOString(),
    });
    expect(error).toBeNull();

    const { data: invoice } = await owner.client.from("invoices").select("status, amount_paid").eq("id", invoiceId).single();
    expect(invoice?.status).toBe("PAID");
    expect(Number(invoice?.amount_paid)).toBe(100000);

    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId);
    expect(payments).toHaveLength(2);
  });

  // Codex adversarial review, remediation round 1, Medium 1: a payment
  // amount must be REJECTED at the DB boundary independently of app-layer
  // validation — never silently rounded. Exact vectors from the review.
  describe("payment amount precision (Medium 1, DB boundary)", () => {
    it.each([0.01, 1, 1.5, 1.99])("accepts amount %s", async (amount) => {
      const { owner, invoiceId } = await setupInvoice("inv-pay-precision-ok", 100000);
      cleanupUserIds.push(owner.userId);
      const { error } = await owner.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId,
        p_amount: amount,
        p_payment_method: "CASH",
        p_paid_at: new Date().toISOString(),
      });
      expect(error).toBeNull();
    });

    it.each([1.999, 0.005, 100.001])("rejects amount %s — never silently rounded", async (amount) => {
      const { owner, invoiceId } = await setupInvoice("inv-pay-precision-bad", 100000);
      cleanupUserIds.push(owner.userId);
      const { error } = await owner.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId,
        p_amount: amount,
        p_payment_method: "CASH",
        p_paid_at: new Date().toISOString(),
      });
      expect(error?.message).toContain("INVALID_PAYMENT_AMOUNT");
    });
  });

  it("18. a payment exceeding the outstanding balance is rejected — no overpayment", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-overpay", 50000);
    cleanupUserIds.push(owner.userId);

    const { error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 50000.01,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error?.message).toContain("PAYMENT_EXCEEDS_BALANCE");

    const { data: invoice } = await owner.client.from("invoices").select("status, amount_paid").eq("id", invoiceId).single();
    expect(invoice?.status).toBe("ISSUED");
    expect(Number(invoice?.amount_paid)).toBe(0);
  });

  it("a payment against an already-PAID invoice is rejected", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-already-paid", 10000);
    cleanupUserIds.push(owner.userId);
    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 10000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });

    const { error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 1,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error?.message).toContain("INVOICE_ALREADY_PAID");
  });

  it("19. a payment against a VOID invoice is denied", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-void", 10000);
    cleanupUserIds.push(owner.userId);
    await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId });

    const { error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error?.message).toContain("INVOICE_VOID");
  });

  it("20. a caller without payments.record is denied", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-unauthorized", 10000);
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "inv-pay-unauthorized", ["payments.view"]);
    cleanupUserIds.push(viewer.userId);

    const { error } = await viewer.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error?.message).toContain("insufficient_privilege");
  });

  it("21. a cross-tenant invoice id is rejected", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-cross-tenant-a", 10000);
    const stranger = await createOwnerAndBusiness("inv-pay-cross-tenant-b");
    cleanupUserIds.push(owner.userId, stranger.userId);

    const { error } = await stranger.client.rpc("record_invoice_payment", {
      p_business_id: stranger.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(error?.message).toContain("INVOICE_NOT_FOUND");
  });

  it("22. an identical payment retry (same creation key) returns the ORIGINAL payment, never double-recording", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-idempotent", 100000);
    cleanupUserIds.push(owner.userId);
    const key = randomUuid();
    const paidAt = new Date().toISOString();

    const first = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_invoice_id: invoiceId,
      p_amount: 30000,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    });
    const second = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_invoice_id: invoiceId,
      p_amount: 30000,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data).toBe(second.data);

    const { data: invoice } = await owner.client.from("invoices").select("amount_paid").eq("id", invoiceId).single();
    // Applied exactly ONCE, never twice — 30000, not 60000.
    expect(Number(invoice?.amount_paid)).toBe(30000);
  });

  it("23. the same payment creation key with a different amount is rejected", async () => {
    const { owner, invoiceId } = await setupInvoice("inv-pay-mismatch", 100000);
    cleanupUserIds.push(owner.userId);
    const key = randomUuid();
    const paidAt = new Date().toISOString();

    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_invoice_id: invoiceId,
      p_amount: 30000,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    });
    const { error } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: key,
      p_invoice_id: invoiceId,
      p_amount: 99999,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    });
    expect(error?.message).toContain("PAYMENT_IDEMPOTENCY_KEY_REUSED");
  });

  it("24. the recorded payment's branch_id always equals the invoice's own branch_id", async () => {
    const owner = await createOwnerAndBusiness("inv-pay-branch-consistency");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Payment Branch B" });
    const customerId = await makeCustomer(owner.client, owner.businessId);
    // The OWNER can never self-assign operational access beyond their own
    // default branch (CANNOT_MANAGE_SELF, a frozen Phase 1F rule) — a
    // separately branch-assigned member is required to create (and pay)
    // an invoice at a NON-default branch.
    const worker = await createMemberWithCustomPermissions(owner.businessId, "inv-pay-branch-consistency", [
      "invoices.manage",
      "payments.record",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data: invoiceId, error: createError } = await createInvoice(worker.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchB,
      items: [{ description: "Service", quantity: 1, unit_price: 5000 }],
    });
    expect(createError).toBeNull();

    const { data: paymentId, error: payError } = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 5000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(payError).toBeNull();
    const { data: payment } = await owner.client.from("invoice_payments").select("branch_id").eq("id", paymentId as string).single();
    expect(payment?.branch_id).toBe(branchB);
  });
});

describe("record_invoice_payment — concurrency: competing payments cannot overpay", () => {
  it("25. invoice total 100 — two concurrent payments of 70 and 50 — exactly one succeeds, balance never negative", async () => {
    const owner = await createOwnerAndBusiness("inv-pay-concurrency");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Concurrency test service", quantity: 1, unit_price: 100 }],
    });

    // Real concurrent requests (Promise.all) against the SAME invoice —
    // determinism comes from record_invoice_payment's own SELECT ... FOR
    // UPDATE row lock (see that migration's own header comment), not from
    // controlling which JS promise the runtime happens to schedule first.
    const [a, b] = await Promise.all([
      owner.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId as string,
        p_amount: 70,
        p_payment_method: "CASH",
        p_paid_at: new Date().toISOString(),
      }),
      owner.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId as string,
        p_amount: 50,
        p_payment_method: "BANK_TRANSFER",
        p_paid_at: new Date().toISOString(),
      }),
    ]);

    const results = [a, b];
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain("PAYMENT_EXCEEDS_BALANCE");

    const { data: invoice } = await owner.client.from("invoices").select("amount_paid, status").eq("id", invoiceId as string).single();
    // Only the 70 (or only the 50, depending on lock-acquisition order —
    // either is a correct, safe outcome) is ever applied; the total NEVER
    // exceeds 100.
    expect([70, 50]).toContain(Number(invoice?.amount_paid));
    expect(Number(invoice?.amount_paid)).toBeLessThanOrEqual(100);
    expect(invoice?.status).toBe("PARTIALLY_PAID");
  });

  // Codex adversarial review, remediation round 1, Low 1: supplements
  // test 25's real-concurrency (Promise.all) proof with a DETERMINISTIC
  // lock-observation proof — two independent PG connections, one held
  // open mid-transaction until the other is OBSERVED genuinely blocked on
  // record_invoice_payment's own `for update` row lock (never timing
  // luck). Mirrors staff-hierarchy.test.ts's own
  // runDeterministicLastOwnerRace barrier technique exactly, adapted from
  // an advisory-lock wait (wait_event ~* 'advisory') to a row-lock wait
  // (wait_event_type = 'Lock').
  it("25b. deterministic: tx2's payment genuinely BLOCKS on tx1's row lock, then correctly fails PAYMENT_EXCEEDS_BALANCE once tx1 commits", async () => {
    const owner = await createOwnerAndBusiness("inv-pay-deterministic");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Deterministic concurrency service", quantity: 1, unit_price: 100 }],
    });

    const c1 = createTestDbClient();
    const c2 = createTestDbClient();
    try {
      await c1`begin`;
      await c1`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Fully awaited: tx1's entire call — permission check, the `for
      // update` lock acquisition, balance check, INSERT, and UPDATE — is
      // complete. Its transaction (and the row lock on this invoice)
      // remains open until explicitly committed below.
      const r1 = await c1`
        select record_invoice_payment(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${invoiceId as string}::uuid,
          70::numeric, 'CASH'::text, ${new Date().toISOString()}::text, null::text, null::text
        ) as payment_id
      `;
      expect(r1[0]?.payment_id).toBeTruthy();

      const [{ pid: c2pid }] = await c2<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await c2`begin`;
      await c2`select set_config('request.jwt.claim.sub', ${owner.userId}, true)`;
      // Dispatched but NOT awaited yet — .catch() attached immediately to
      // flush it onto the wire (see the reference barrier's own comment
      // on why an unconsumed promise can sit queued far longer than this
      // poll window tolerates).
      const p2 = c2`
        select record_invoice_payment(
          ${owner.businessId}::uuid, ${randomUuid()}::uuid, ${invoiceId as string}::uuid,
          50::numeric, 'BANK_TRANSFER'::text, ${new Date().toISOString()}::text, null::text, null::text
        ) as payment_id
      `;
      p2.catch(() => {});

      let blocked = false;
      for (let i = 0; i < 400; i++) {
        const rows = await c1<{ wait_event_type: string | null }[]>`
          select wait_event_type from pg_stat_activity where pid = ${c2pid}
        `;
        if (rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!blocked) {
        throw new Error(
          "test harness error: tx2 never reached the row-lock wait within the poll window — the barrier was not established, so this run cannot claim determinism"
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

      // tx2 unblocked, re-read the NOW-COMMITTED (post-tx1) balance —
      // never a stale snapshot — and correctly rejected the overpayment.
      expect(err2?.message).toContain("PAYMENT_EXCEEDS_BALANCE");
    } finally {
      await c1.end();
      await c2.end();
    }

    const { data: invoice } = await owner.client.from("invoices").select("amount_paid, status").eq("id", invoiceId as string).single();
    expect(Number(invoice?.amount_paid)).toBe(70);
    expect(invoice?.status).toBe("PARTIALLY_PAID");
    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId as string);
    expect(payments).toHaveLength(1);
  });

  // Codex adversarial review, remediation round 1, Low 1: "if practical"
  // deterministic-adjacent coverage for invoice-number allocation — real
  // concurrent creation requests against the SAME business, verifying the
  // underlying private.business_invoice_sequences UPSERT serializes them
  // (never two invoices claiming the same number).
  it("25c. concurrent invoice creation for the same business never allocates duplicate invoice numbers", async () => {
    const owner = await createOwnerAndBusiness("inv-number-concurrency");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createInvoice(owner.client, {
          businessId: owner.businessId,
          customerId,
          branchId: branchA,
          items: [invoiceItem(product.id, 1)],
        })
      )
    );
    expect(results.every((r) => !r.error)).toBe(true);

    const { data: invoices } = await owner.client
      .from("invoices")
      .select("invoice_number")
      .eq("business_id", owner.businessId);
    const numbers = invoices!.map((i) => i.invoice_number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("void_invoice", () => {
  it("26. an issued, unpaid invoice can be voided", async () => {
    const owner = await createOwnerAndBusiness("inv-void-unpaid");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });

    const { error } = await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });
    expect(error).toBeNull();

    const { data: invoice } = await owner.client.from("invoices").select("status, voided_at, voided_by").eq("id", invoiceId as string).single();
    expect(invoice?.status).toBe("VOID");
    expect(invoice?.voided_at).not.toBeNull();
    expect(invoice?.voided_by).toBe(owner.userId);
  });

  it("27. a fully paid invoice cannot be voided", async () => {
    const owner = await createOwnerAndBusiness("inv-void-paid");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });
    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });

    const { error } = await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });
    expect(error?.message).toContain("INVOICE_HAS_PAYMENTS");
  });

  it("28. a partially paid invoice cannot be voided", async () => {
    const owner = await createOwnerAndBusiness("inv-void-partial");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });
    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 200,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });

    const { error } = await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });
    expect(error?.message).toContain("INVOICE_HAS_PAYMENTS");
  });

  it("29. an already-void invoice returns a controlled, distinct error, not a silent success", async () => {
    const owner = await createOwnerAndBusiness("inv-void-already");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });
    await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });

    const { error } = await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });
    expect(error?.message).toContain("INVOICE_ALREADY_VOID");
  });

  it("30. a caller without invoices.manage cannot void", async () => {
    const owner = await createOwnerAndBusiness("inv-void-unauthorized");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "inv-void-unauthorized", ["invoices.view"]);
    cleanupUserIds.push(viewer.userId);

    const { error } = await viewer.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceId as string });
    expect(error?.message).toContain("insufficient_privilege");
  });
});

// Security audit remediation — SEC-01, "Cross-Branch Invoice Void IDOR" ----
//
// CONFIRMED EXPLOIT: a caller with invoices.manage, assigned ONLY to
// Branch A, could call get_invoice_void_eligibility (and then void_invoice)
// against a Branch B invoice and successfully void it — invoices.manage
// alone authorized every branch of the business, when invoice VOIDING is
// branch-operational, exactly like invoice CREATION already was. Both
// functions now derive the invoice's own AUTHORITATIVE branch_id from the
// LOCKED/read invoice row itself (never a caller-supplied parameter — the
// finding through direct RPC use, per the audit's own preference) and
// check private.has_branch_access against it, mirroring create_invoice's
// own identical check. Tested here through the ACTUAL authenticated
// public RPCs directly — never only through the UI.
describe("Phase 1H security remediation — SEC-01: cross-branch invoice void IDOR", () => {
  async function setupTwoBranchInvoices(prefix: string) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: `${prefix} Branch B` });
    const customerId = await makeCustomer(owner.client, owner.businessId);

    // The OWNER is never self-assignable beyond their own default branch
    // (CANNOT_MANAGE_SELF, a frozen Phase 1F rule) — a SEPARATE "creator"
    // member, assigned to BOTH branches, is what actually creates the two
    // fixture invoices (mirrors this file's own test 24 and the e2e
    // suite's createBranchAssignedMember precedent).
    const creator = await createMemberWithCustomPermissions(owner.businessId, `${prefix}-creator`, ["invoices.manage"]);
    const creatorMemberId = await getMemberId(owner.businessId, creator.userId);
    await assignMemberToBranch(owner.client, owner.businessId, creatorMemberId, [branchA, branchB]);

    const { data: invoiceInA, error: errorA } = await createInvoice(creator.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Branch A service", quantity: 1, unit_price: 1000 }],
    });
    const { data: invoiceInB, error: errorB } = await createInvoice(creator.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchB,
      items: [{ description: "Branch B service", quantity: 1, unit_price: 1000 }],
    });
    if (errorA || !invoiceInA) throw new Error(`fixture setup failed creating Branch A invoice: ${errorA?.message}`);
    if (errorB || !invoiceInB) throw new Error(`fixture setup failed creating Branch B invoice: ${errorB?.message}`);

    return {
      owner,
      creatorUserId: creator.userId,
      branchA,
      branchB,
      invoiceInA: invoiceInA as string,
      invoiceInB: invoiceInB as string,
    };
  }

  it("SEC-01: invoices.manage assigned ONLY to Branch A — eligible and can void the Branch A invoice", async () => {
    const { owner, creatorUserId, branchA, invoiceInA } = await setupTwoBranchInvoices("sec01-branch-a-ok");
    cleanupUserIds.push(owner.userId, creatorUserId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "sec01-branch-a-ok", ["invoices.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchA]);

    const eligibility = await worker.client.rpc("get_invoice_void_eligibility", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInA,
    });
    expect(eligibility.error).toBeNull();
    expect(eligibility.data).toBe(true);

    const voidResult = await worker.client.rpc("void_invoice", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInA,
    });
    expect(voidResult.error).toBeNull();

    const { data: invoice } = await owner.client.from("invoices").select("status").eq("id", invoiceInA).single();
    expect(invoice?.status).toBe("VOID");
  });

  it("SEC-01 (the confirmed exploit): invoices.manage assigned ONLY to Branch A — Branch B eligibility and void are BOTH denied, invoice unchanged", async () => {
    const { owner, creatorUserId, invoiceInB } = await setupTwoBranchInvoices("sec01-branch-b-denied");
    cleanupUserIds.push(owner.userId, creatorUserId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "sec01-branch-b-denied", ["invoices.manage"]);
    cleanupUserIds.push(worker.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchA]);

    // 1) get_invoice_void_eligibility must NOT return true for Branch B.
    const eligibility = await worker.client.rpc("get_invoice_void_eligibility", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInB,
    });
    // Generic, non-disclosing denial — the SAME code a genuinely
    // nonexistent invoice id would produce, never a distinguishable
    // "found but wrong branch" error (see void_invoice_rpc.sql's own
    // header comment on why).
    expect(eligibility.error?.message).toContain("INVOICE_NOT_FOUND");

    // 2) void_invoice — the actual confirmed exploit step — must ALSO be
    // denied, through the direct RPC, not merely hidden in the UI.
    const voidResult = await worker.client.rpc("void_invoice", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInB,
    });
    expect(voidResult.error?.message).toContain("INVOICE_NOT_FOUND");

    // 3) The Branch B invoice remains completely unchanged — ISSUED,
    // never voided.
    const { data: invoice } = await owner.client
      .from("invoices")
      .select("status, voided_at, voided_by")
      .eq("id", invoiceInB)
      .single();
    expect(invoice?.status).toBe("ISSUED");
    expect(invoice?.voided_at).toBeNull();
    expect(invoice?.voided_by).toBeNull();
  });

  it("SEC-01: a caller assigned to BOTH branches can void either", async () => {
    const { owner, creatorUserId, branchA, branchB, invoiceInA, invoiceInB } = await setupTwoBranchInvoices("sec01-both-branches");
    cleanupUserIds.push(owner.userId, creatorUserId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "sec01-both-branches", ["invoices.manage"]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchA, branchB]);

    const eligibleA = await worker.client.rpc("get_invoice_void_eligibility", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInA,
    });
    const eligibleB = await worker.client.rpc("get_invoice_void_eligibility", {
      p_business_id: owner.businessId,
      p_invoice_id: invoiceInB,
    });
    expect(eligibleA.data).toBe(true);
    expect(eligibleB.data).toBe(true);

    const voidA = await worker.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceInA });
    const voidB = await worker.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: invoiceInB });
    expect(voidA.error).toBeNull();
    expect(voidB.error).toBeNull();

    const { data: invoices } = await owner.client
      .from("invoices")
      .select("id, status")
      .in("id", [invoiceInA, invoiceInB]);
    expect(invoices?.every((i) => i.status === "VOID")).toBe(true);
  });

  it("SEC-01: a cross-tenant invoice id (foreign business) is denied identically to a nonexistent one", async () => {
    const ownerA = await createOwnerAndBusiness("sec01-cross-tenant-a");
    const ownerB = await createOwnerAndBusiness("sec01-cross-tenant-b");
    cleanupUserIds.push(ownerA.userId, ownerB.userId);
    const branchA = await getDefaultBranchId(ownerA.client, ownerA.businessId);
    const customerId = await makeCustomer(ownerA.client, ownerA.businessId);
    const { data: invoiceId } = await createInvoice(ownerA.client, {
      businessId: ownerA.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "Service", quantity: 1, unit_price: 1000 }],
    });

    const eligibility = await ownerB.client.rpc("get_invoice_void_eligibility", {
      p_business_id: ownerB.businessId,
      p_invoice_id: invoiceId as string,
    });
    expect(eligibility.error?.message).toContain("INVOICE_NOT_FOUND");

    const voidResult = await ownerB.client.rpc("void_invoice", {
      p_business_id: ownerB.businessId,
      p_invoice_id: invoiceId as string,
    });
    expect(voidResult.error?.message).toContain("INVOICE_NOT_FOUND");
  });
});

// Security audit remediation — SEC-02, "Public payment RPC bypasses
// explicit-instant validation" ---------------------------------------------
//
// CONFIRMED: record_invoice_payment's p_paid_at parameter used to be typed
// `timestamptz` — PostgREST/PostgreSQL parsed the caller's raw input into
// that type BEFORE this function's own body ever ran, so a direct
// authenticated RPC caller could submit a timezone-less or far-future
// timestamp and have Postgres's own liberal parser silently accept it,
// bypassing the browser's/Server Action's own correct validation entirely.
// p_paid_at is now `text`, independently validated by
// private.is_valid_offset_bearing_instant (lexical + calendar + clock +
// offset) and a database-side future-date grace check, BEFORE any cast to
// timestamptz. Tested here through the ACTUAL authenticated public RPC
// directly, using a payments.record-only caller (never the UI, never the
// Server Action).
describe("Phase 1H security remediation — SEC-02: payment RPC timestamp trust boundary", () => {
  async function setupPayableInvoice(prefix: string, total: number) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [{ description: "SEC-02 service", quantity: 1, unit_price: total }],
    });
    const worker = await createMemberWithCustomPermissions(owner.businessId, prefix, ["payments.record"]);
    return { owner, worker, invoiceId: invoiceId as string };
  }

  it.each([
    "2026-08-31T15:30", // timezone-less
    "2026-08-31T15:30:00", // seconds but still no offset
    "2026-02-30T15:30:00Z", // impossible date — February never has a 30th
    "2026-04-31T15:30:00Z", // impossible date — April has only 30 days
    "2026-13-01T15:30:00Z", // month 13 does not exist
    "2026-08-31T24:00:00Z", // hour 24 does not exist
    "2026-08-31T23:60:00Z", // minute 60 does not exist
    "2026-08-31T23:59:60Z", // no leap-second support
    "2026-08-31T15:30:00+24:00", // impossible offset
    "2026-08-31T15:30:00+12:60", // impossible offset
  ])("direct RPC rejects paidAt=%s — zero payment row, invoice unchanged", async (paidAt) => {
    const { owner, worker, invoiceId } = await setupPayableInvoice("sec02-reject", 10000);
    cleanupUserIds.push(owner.userId, worker.userId);

    const { error, data } = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      p_paid_at: paidAt,
    });
    expect(error).not.toBeNull();
    expect(data ?? null).toBeNull();
    expect(error?.message).toContain("INVALID_PAYMENT_DATE");

    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId);
    expect(payments).toHaveLength(0);
    const { data: invoice } = await owner.client.from("invoices").select("amount_paid, status").eq("id", invoiceId).single();
    expect(Number(invoice?.amount_paid)).toBe(0);
    expect(invoice?.status).toBe("ISSUED");
  });

  it("direct RPC rejects a far-future paidAt — zero payment row, invoice unchanged", async () => {
    const { owner, worker, invoiceId } = await setupPayableInvoice("sec02-future", 10000);
    cleanupUserIds.push(owner.userId, worker.userId);

    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      p_paid_at: farFuture,
    });
    expect(error?.message).toContain("PAYMENT_DATE_IN_FUTURE");

    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId);
    expect(payments).toHaveLength(0);
    const { data: invoice } = await owner.client.from("invoices").select("amount_paid, status").eq("id", invoiceId).single();
    expect(Number(invoice?.amount_paid)).toBe(0);
    expect(invoice?.status).toBe("ISSUED");
  });

  it.each(["2026-08-31T14:30:00.000Z", "2026-08-31T15:30:00+01:00", "2024-02-29T12:00:00Z"])(
    "direct RPC accepts paidAt=%s",
    async (paidAt) => {
      const { owner, worker, invoiceId } = await setupPayableInvoice("sec02-accept", 10000);
      cleanupUserIds.push(owner.userId, worker.userId);

      const { error, data } = await worker.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId,
        p_amount: 5000,
        p_payment_method: "CASH",
        p_paid_at: paidAt,
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    }
  );

  // Codex security audit, SEC-02: canonicalization/idempotency — two
  // DIFFERENT explicit representations of the EXACT SAME instant must
  // fingerprint identically (never a spurious PAYMENT_IDEMPOTENCY_KEY_REUSED
  // for what is, semantically, an exact replay), and the stored instant
  // must be the true parsed value regardless of which representation was
  // submitted.
  it("SEC-02: equivalent explicit instants (+01:00 vs Z) fingerprint identically under the same creation key — exact replay, not a conflict", async () => {
    const { owner, worker, invoiceId } = await setupPayableInvoice("sec02-canonical", 10000);
    cleanupUserIds.push(owner.userId, worker.userId);
    const creationKey = randomUuid();

    const first = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      // 15:30 +01:00 == 14:30 UTC — the exact same instant as the second
      // call's own "Z" spelling below.
      p_paid_at: "2026-08-31T15:30:00+01:00",
    });
    expect(first.error).toBeNull();

    const second = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      p_paid_at: "2026-08-31T14:30:00Z",
    });
    // Recognized as an EXACT replay (same instant, same everything else)
    // — never PAYMENT_IDEMPOTENCY_KEY_REUSED.
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: payments } = await owner.client.from("invoice_payments").select("id, paid_at").eq("invoice_id", invoiceId);
    // Applied exactly ONCE — the replay never double-recorded.
    expect(payments).toHaveLength(1);
    expect(new Date(payments![0].paid_at).toISOString()).toBe("2026-08-31T14:30:00.000Z");
  });

  it("SEC-02: a genuinely DIFFERENT instant under the same creation key is a real conflict, not a false replay", async () => {
    const { owner, worker, invoiceId } = await setupPayableInvoice("sec02-conflict", 10000);
    cleanupUserIds.push(owner.userId, worker.userId);
    const creationKey = randomUuid();

    const first = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      p_paid_at: "2026-08-31T14:30:00Z",
    });
    expect(first.error).toBeNull();

    const second = await worker.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: creationKey,
      p_invoice_id: invoiceId,
      p_amount: 5000,
      p_payment_method: "CASH",
      // A genuinely different instant — one second later.
      p_paid_at: "2026-08-31T14:30:01Z",
    });
    expect(second.error?.message).toContain("PAYMENT_IDEMPOTENCY_KEY_REUSED");
  });
});

describe("Phase 1H picker/reader RPCs (Medium 2/3/4, Low 6)", () => {
  it("get_invoice_product_options excludes archived products and never exposes cost data", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-product-options");
    cleanupUserIds.push(owner.userId);
    const active = await makeSaleProduct(owner.client, owner.businessId, { name: "Active Pickable", sellingPrice: 250 });
    // trackInventory: false — a product WITH stock cannot be archived
    // (CANNOT_ARCHIVE_WITH_STOCK), matching test 9's own identical
    // override in this same file.
    const archived = await makeSaleProduct(owner.client, owner.businessId, { name: "Archived Pickable", trackInventory: false });
    const { error: archiveErr } = await owner.client.from("products").update({ status: "archived" }).eq("id", archived.id);
    expect(archiveErr).toBeNull();

    const { data, error } = await owner.client.rpc("get_invoice_product_options", {
      p_business_id: owner.businessId,
      p_search: "Pickable",
    });
    expect(error).toBeNull();
    expect(data!.some((p) => p.id === active.id)).toBe(true);
    expect(data!.some((p) => p.id === archived.id)).toBe(false);
    expect(Object.keys(data![0])).toEqual(["id", "name", "sku", "selling_price"]);
  });

  it("get_invoice_customer_options excludes archived customers, and returns ONLY id/name — never phone/email", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-customer-options");
    cleanupUserIds.push(owner.userId);
    const active = await makeCustomer(owner.client, owner.businessId, {
      name: "Active Pickable Customer",
      phone: "08011112222",
      email: "active-pickable@example.test",
    });
    const archived = await makeCustomer(owner.client, owner.businessId, { name: "Archived Pickable Customer" });
    await owner.client.from("customers").update({ status: "archived" }).eq("id", archived);

    const { data, error } = await owner.client.rpc("get_invoice_customer_options", {
      p_business_id: owner.businessId,
      p_search: "Pickable Customer",
    });
    expect(error).toBeNull();
    expect(data!.some((c) => c.id === active)).toBe(true);
    expect(data!.some((c) => c.id === archived)).toBe(false);

    // Codex adversarial review, remediation round 2, Medium 1/Finding 5.1:
    // the exact returned key set must be strictly {id, name} — no
    // phone/email/status/business_id, regardless of what the caller
    // searched by.
    const row = data!.find((c) => c.id === active);
    expect(Object.keys(row!).sort()).toEqual(["id", "name"]);
    expect(row).not.toHaveProperty("phone");
    expect(row).not.toHaveProperty("email");
  });

  it("get_invoice_customer_options can still FIND a customer by phone/email internally, without ever returning either", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-customer-phone-search");
    cleanupUserIds.push(owner.userId);
    const customerId = await makeCustomer(owner.client, owner.businessId, {
      name: "Phone Searchable Customer",
      phone: "08033334444",
      email: "phone-searchable@example.test",
    });

    const byPhone = await owner.client.rpc("get_invoice_customer_options", {
      p_business_id: owner.businessId,
      p_search: "08033334444",
    });
    expect(byPhone.error).toBeNull();
    expect(byPhone.data!.some((c) => c.id === customerId)).toBe(true);
    expect(Object.keys(byPhone.data![0]).sort()).toEqual(["id", "name"]);

    const byEmail = await owner.client.rpc("get_invoice_customer_options", {
      p_business_id: owner.businessId,
      p_search: "phone-searchable@example.test",
    });
    expect(byEmail.error).toBeNull();
    expect(byEmail.data!.some((c) => c.id === customerId)).toBe(true);
    expect(Object.keys(byEmail.data![0]).sort()).toEqual(["id", "name"]);
  });

  it("get_invoice_filter_branch_options includes INACTIVE branches (historical filtering)", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-filter-branches");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Soon Inactive Branch" });
    // Branch status is RPC-only (no direct table UPDATE grant) — see
    // create_business_branches.sql's own header comment.
    const { error: deactivateErr } = await owner.client.rpc("deactivate_business_branch", {
      p_business_id: owner.businessId,
      p_branch_id: branchB,
    });
    expect(deactivateErr).toBeNull();

    const { data, error } = await owner.client.rpc("get_invoice_filter_branch_options", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();
    const row = data!.find((b) => b.id === branchB);
    expect(row?.status).toBe("INACTIVE");
  });

  it("get_payable_invoice_options excludes PAID and VOID invoices", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-payable-options");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const { data: issuedId } = await createInvoice(owner.client, {
      businessId: owner.businessId, customerId, branchId: branchA,
      items: [{ description: "Issued", quantity: 1, unit_price: 100 }],
    });
    const { data: paidId } = await createInvoice(owner.client, {
      businessId: owner.businessId, customerId, branchId: branchA,
      items: [{ description: "Paid", quantity: 1, unit_price: 100 }],
    });
    await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId, p_creation_key: randomUuid(), p_invoice_id: paidId as string,
      p_amount: 100, p_payment_method: "CASH", p_paid_at: new Date().toISOString(),
    });
    const { data: voidId } = await createInvoice(owner.client, {
      businessId: owner.businessId, customerId, branchId: branchA,
      items: [{ description: "Void", quantity: 1, unit_price: 100 }],
    });
    await owner.client.rpc("void_invoice", { p_business_id: owner.businessId, p_invoice_id: voidId as string });

    const { data, error } = await owner.client.rpc("get_payable_invoice_options", { p_business_id: owner.businessId });
    expect(error).toBeNull();
    const ids = data!.map((i) => i.id);
    expect(ids).toContain(issuedId);
    expect(ids).not.toContain(paidId);
    expect(ids).not.toContain(voidId);
  });

  it("get_invoice_void_eligibility: NOT_FOUND for a cross-tenant invoice id", async () => {
    const owner = await createOwnerAndBusiness("inv-rpc-void-elig-a");
    const other = await createOwnerAndBusiness("inv-rpc-void-elig-b");
    cleanupUserIds.push(owner.userId, other.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await createInvoice(owner.client, {
      businessId: owner.businessId, customerId, branchId: branchA,
      items: [{ description: "Svc", quantity: 1, unit_price: 100 }],
    });

    const { error } = await other.client.rpc("get_invoice_void_eligibility", {
      p_business_id: other.businessId,
      p_invoice_id: invoiceId as string,
    });
    expect(error?.message).toContain("INVOICE_NOT_FOUND");
  });
});

describe("Phase 1H — ACL / RLS", () => {
  it("31. direct table writes are denied for authenticated — invoices/invoice_items/invoice_payments are RPC-only", async () => {
    const owner = await createOwnerAndBusiness("inv-acl-direct-write");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);

    const insertInvoice = await owner.client.from("invoices").insert({
      business_id: owner.businessId,
      invoice_number: "INV-FORGED",
      customer_id: customerId,
      customer_name_snapshot: "Forged",
      branch_id: branchA,
      branch_name_snapshot: "Forged Branch",
      total_amount: 100,
      creation_key: randomUuid(),
      created_by: owner.userId,
    } as never);
    expect(insertInvoice.error).not.toBeNull();

    const updateInvoice = await owner.client.from("invoices").update({ status: "PAID" }).eq("business_id", owner.businessId);
    expect(updateInvoice.error).not.toBeNull();

    const insertPayment = await owner.client.from("invoice_payments").insert({
      business_id: owner.businessId,
      invoice_id: randomUuid(),
      branch_id: branchA,
      amount: 100,
      payment_method: "CASH",
      creation_key: randomUuid(),
      recorded_by: owner.userId,
    } as never);
    expect(insertPayment.error).not.toBeNull();
  });

  for (const rpc of [
    "create_invoice",
    "record_invoice_payment",
    "void_invoice",
    // Codex adversarial review, remediation round 1: the seven new
    // picker/reader RPCs (20260831080700_invoice_picker_rpcs.sql) must
    // carry the identical hardened ACL every Phase 1H RPC does.
    "get_invoice_branch_options",
    "get_invoice_customer_options",
    "get_invoice_product_options",
    "get_invoice_filter_branch_options",
    "get_payable_invoice_options",
    "list_invoice_payments_for_viewer",
    "get_invoice_void_eligibility",
  ] as const) {
    it(`32. ${rpc}: PUBLIC is denied EXECUTE`, async () => {
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

  it("33. anon cannot call create_invoice", async () => {
    const owner = await createOwnerAndBusiness("inv-acl-anon");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const anon = createAnonClient();

    const { data, error } = await createInvoice(anon, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("34. service_role cannot call create_invoice", async () => {
    const owner = await createOwnerAndBusiness("inv-acl-service-role");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const admin = createAdminClient();

    const { data, error } = await createInvoice(admin, {
      businessId: owner.businessId,
      customerId,
      branchId: branchA,
      items: [invoiceItem(product.id, 1)],
    });
    expect(data ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("35. every new private writer role is NOLOGIN/NOINHERIT/BYPASSRLS, owning exactly its own RPC", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolname, rolcanlogin, rolinherit, rolbypassrls from pg_roles
        where rolname in ('private_invoice_writer', 'private_invoice_payment_writer', 'private_invoice_voider')
      `;
      expect(roles).toHaveLength(3);
      for (const role of roles) {
        expect(role.rolcanlogin).toBe(false);
        expect(role.rolinherit).toBe(false);
        expect(role.rolbypassrls).toBe(true);
      }

      const owners = await sql<{ proname: string; owner: string }[]>`
        select p.proname, r.rolname as owner
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public' and p.proname in ('create_invoice', 'record_invoice_payment', 'void_invoice')
      `;
      const ownerByName = Object.fromEntries(owners.map((o) => [o.proname, o.owner]));
      expect(ownerByName.create_invoice).toBe("private_invoice_writer");
      expect(ownerByName.record_invoice_payment).toBe("private_invoice_payment_writer");
      expect(ownerByName.void_invoice).toBe("private_invoice_voider");
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review, remediation round 1: private_invoice_picker_reader
  // is a DELIBERATE, documented exception to the "one narrow role per RPC"
  // convention (see 20260831080700_invoice_picker_rpcs.sql's own header
  // comment) — still NOLOGIN/NOINHERIT/BYPASSRLS, and owns exactly the
  // seven read-only picker/reader RPCs, never any mutation RPC.
  it("35b. private_invoice_picker_reader is NOLOGIN/NOINHERIT/BYPASSRLS, owning exactly the seven picker/reader RPCs", async () => {
    const sql = createTestDbClient();
    try {
      const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
        select rolname, rolcanlogin, rolinherit, rolbypassrls from pg_roles
        where rolname = 'private_invoice_picker_reader'
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
        where n.nspname = 'public' and r.rolname = 'private_invoice_picker_reader'
      `;
      const names = owners.map((o) => o.proname).sort();
      expect(names).toEqual(
        [
          "get_invoice_branch_options",
          "get_invoice_customer_options",
          "get_invoice_filter_branch_options",
          "get_invoice_product_options",
          "get_invoice_void_eligibility",
          "get_payable_invoice_options",
          "list_invoice_payments_for_viewer",
        ].sort()
      );
    } finally {
      await sql.end();
    }
  });

  // Codex adversarial review, remediation round 2, Finding 5.5: this test
  // used to call the FROZEN Phase 1G get_business_branch_options'
  // 'operations' scope, and — to make that call succeed at all — granted
  // the worker `sales.create` ALONGSIDE `invoices.manage`. That was never
  // actually proving "no permission-split gap" for invoices.manage; it
  // was demonstrating the exact obsolete WORKAROUND (an unrelated
  // permission smuggled in to satisfy a scope invoices.manage was never
  // meant to need) that Phase 1H's own get_invoice_branch_options RPC
  // (20260831080700_invoice_picker_rpcs.sql) now exists specifically to
  // eliminate. Rewritten to exercise the REAL, current, capability-
  // specific contract directly at the RPC layer: invoices.manage ALONE
  // (no sales.create, no other permission) must resolve the caller's own
  // assigned branch through get_invoice_branch_options.
  it("36. get_invoice_branch_options resolves the caller's own assigned branch for invoices.manage ALONE — no sales.create, no frozen-scope workaround", async () => {
    const owner = await createOwnerAndBusiness("inv-branch-rpc-contract");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Invoice Contract Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "inv-branch-rpc-contract", [
      "invoices.manage",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    const { data, error } = await worker.client.rpc("get_invoice_branch_options", {
      p_business_id: owner.businessId,
    });
    expect(error).toBeNull();
    expect(data!.some((b) => b.id === branchB)).toBe(true);

    // The frozen Phase 1G scope remains genuinely inaccessible to this
    // caller — proving the fix isn't merely "also works", but that
    // invoices.manage no longer needs that unrelated scope at all.
    const legacy = await worker.client.rpc("get_business_branch_options", {
      p_business_id: owner.businessId,
      p_scope: "operations",
    });
    expect(legacy.error?.message).toContain("insufficient_privilege");
  });
});
