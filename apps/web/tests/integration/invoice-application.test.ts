import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteTestUser } from "./helpers/admin-client";
import { createOwnerAndBusiness, createMemberWithCustomPermissions, randomUuid } from "./helpers/inventory";
import { makeSaleProduct, makeCustomer } from "./helpers/sales";
import { getDefaultBranchId, createBranch, assignMemberToBranch, getMemberId } from "./helpers/staff";

// Phase 1H application layer — exercises the REAL Server Actions
// (lib/invoices/actions.ts) against a real database, using the same
// hybrid technique as customer-sale-action-auth.test.ts: redirect()
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

const {
  createInvoice,
  recordInvoicePayment,
  voidInvoice,
  searchProductsForInvoiceAction,
  searchCustomersForInvoiceAction,
  searchPayableInvoicesAction,
} = await import("@/lib/invoices/actions");
const { listInvoiceFilterBranchOptions } = await import("@/lib/branches/dal");
const {
  getInvoice,
  invoiceBalance,
  getInvoiceBranchOptions,
  getInvoiceVoidEligibility,
  listInvoicePaymentsForViewer,
} = await import("@/lib/invoices/dal");

function isRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

// Mirrors nonstandard-permission-fixtures.test.ts's own redirectUrl exactly
// — decodes Next's own getURLFromRedirectError digest shape
// (`${REDIRECT_ERROR_CODE};${type};${url};${statusCode};`) rather than
// importing an internal API.
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

describe("createInvoice — application layer", () => {
  it("a well-formed request succeeds, redirects, and is readable afterward with the correct snapshot", async () => {
    const owner = await createOwnerAndBusiness("app-inv-create");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "App Layer Customer" });
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 });

    currentClient = owner.client;
    let caught: unknown;
    try {
      await createInvoice(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          customerId,
          branchId: branchA,
          items: JSON.stringify([{ productId: product.id, quantity: "2" }]),
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: invoices } = await owner.client.from("invoices").select("id, total_amount, customer_name_snapshot").eq("customer_id", customerId);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices![0].total_amount)).toBe(2000);
    expect(invoices![0].customer_name_snapshot).toBe("App Layer Customer");
  });

  it("a caller without invoices.manage is denied — no redirect, a controlled error instead", async () => {
    const owner = await createOwnerAndBusiness("app-inv-create-unauthorized");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-create-unauthorized", ["invoices.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const result = await createInvoice(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        customerId,
        branchId: branchA,
        items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
      })
    );
    expect(result?.error).toContain("permission");
  });

  // Codex adversarial review, remediation round 1, Low 2: a non-empty
  // but MALFORMED businessId — "not-a-uuid" specifically, per the
  // review's own exact vector — must be rejected BEFORE getPermissions()/
  // any Postgres call, never merely an empty-string check.
  it("a malformed (non-empty) businessId never reaches getPermissions or the RPC", async () => {
    const owner = await createOwnerAndBusiness("app-inv-create-malformed");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await createInvoice(
      undefined,
      formData({
        businessId: "not-a-uuid",
        creationKey: randomUuid(),
        customerId: randomUuid(),
        branchId: randomUuid(),
        items: JSON.stringify([]),
      })
    );
    expect(result?.error).toBeTruthy();
    expect(result?.fieldErrors).toBeUndefined();
  });

  it("a malformed items JSON blob fails as a controlled field error, never a thrown parse exception", async () => {
    const owner = await createOwnerAndBusiness("app-inv-create-bad-json");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    currentClient = owner.client;

    const result = await createInvoice(
      undefined,
      formData({
        businessId: owner.businessId,
        creationKey: randomUuid(),
        customerId,
        branchId: branchA,
        items: "{not valid json",
      })
    );
    expect(result?.fieldErrors?.items).toBeTruthy();
  });

  // Codex adversarial review, remediation round 1, Medium 2: getInvoiceBranchOptions
  // (unlike the frozen getOperationalBranchOptions, which requires
  // sales.create/products.manage/inventory.adjust) is authorized on
  // invoices.manage ALONE — a custom role holding invoices.manage and
  // NOTHING else must still resolve real branch names for its OWN
  // operational assignment.
  it("getInvoiceBranchOptions resolves real branch names for an invoices.manage-ONLY holder, no other permission required", async () => {
    const owner = await createOwnerAndBusiness("app-inv-branch-picker");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "App Layer Invoice Branch" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-branch-picker", [
      "invoices.manage",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchB]);

    currentClient = worker.client;
    const { options } = await getInvoiceBranchOptions(owner.businessId);
    expect(options.some((b) => b.id === branchB && b.name === "App Layer Invoice Branch")).toBe(true);
  });

  // Codex adversarial review, remediation round 1, Medium 2: the previous
  // implementation returned [] for an invoices.manage-only caller because
  // it wrapped searchProductsForSale/listCustomers, which independently
  // re-enforce products.view/customers.view via RLS. The fix must produce
  // REAL results for invoices.manage alone — not merely avoid throwing.
  it("searchProductsForInvoiceAction and searchCustomersForInvoiceAction return REAL results for invoices.manage ALONE (no products.view/customers.view)", async () => {
    const owner = await createOwnerAndBusiness("app-inv-search-manage-only");
    cleanupUserIds.push(owner.userId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { name: "Picker Product", sellingPrice: 500 });
    const customerId = await makeCustomer(owner.client, owner.businessId, { name: "Picker Customer" });
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-search-manage-only", [
      "invoices.manage",
    ]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    const products = await searchProductsForInvoiceAction(owner.businessId, "Picker Product");
    const customers = await searchCustomersForInvoiceAction(owner.businessId, "Picker Customer");
    expect(products.some((p) => p.id === product.id)).toBe(true);
    // No cost data is ever exposed to this picker.
    expect(products[0] && "costPrice" in products[0]).toBe(false);
    const customer = customers.find((c) => c.id === customerId);
    expect(customer).toBeTruthy();
    // Codex adversarial review, remediation round 2, Medium 1: the
    // application-layer type/DAL contract must also carry only id/name —
    // never phone/email, at the DB RPC boundary this action wraps.
    expect(Object.keys(customer!).sort()).toEqual(["id", "name"]);
  });

  // Codex adversarial review, remediation round 2, Low 3: all three
  // Phase 1H search actions used to call getPermissions(businessId)
  // BEFORE validating businessId's own shape. getPermissions itself
  // THROWS a real Error when Postgres rejects a malformed ::uuid
  // comparison (lib/business/dal.ts's own `if (error) throw ...`) — so,
  // before this fix, `searchProductsForInvoiceAction(owner.businessId ->
  // "not-a-uuid", ...)` would have REJECTED, not resolved to []. Proving
  // the promise now resolves cleanly (never rejects) is a real,
  // behavioral proof that businessId is rejected BEFORE getPermissions/
  // any Postgres call, not merely an assertion of the intended shape.
  it("all three search actions reject a malformed (non-empty) businessId before getPermissions/the DB — 'not-a-uuid'", async () => {
    const owner = await createOwnerAndBusiness("app-inv-search-malformed-business-id");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    await expect(searchProductsForInvoiceAction("not-a-uuid", "")).resolves.toEqual([]);
    await expect(searchCustomersForInvoiceAction("not-a-uuid", "")).resolves.toEqual([]);
    await expect(searchPayableInvoicesAction("not-a-uuid", "")).resolves.toEqual([]);
  });

  it("searchProductsForInvoiceAction and searchCustomersForInvoiceAction both return [] without invoices.manage, never throwing", async () => {
    const owner = await createOwnerAndBusiness("app-inv-search-denied");
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-search-denied", ["invoices.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const products = await searchProductsForInvoiceAction(owner.businessId, "");
    const customers = await searchCustomersForInvoiceAction(owner.businessId, "");
    expect(products).toEqual([]);
    expect(customers).toEqual([]);
  });

  // Codex adversarial review, remediation round 1, Medium 3: invoices.view
  // must resolve real branch filter data WITHOUT branches.view.
  it("listInvoiceFilterBranchOptions returns every business branch for an invoices.view-ONLY holder, without branches.view", async () => {
    const owner = await createOwnerAndBusiness("app-inv-filter-branches");
    cleanupUserIds.push(owner.userId);
    const branchB = await createBranch(owner.client, owner.businessId, { name: "Unassigned Invoice Filter Branch" });
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-filter-branches", [
      "invoices.view",
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const branches = await listInvoiceFilterBranchOptions(owner.businessId);
    expect(branches.some((b) => b.id === branchB)).toBe(true);
  });

  // Codex adversarial review, remediation round 1, Medium 2: a caller
  // with invoices.manage but WITHOUT invoices.view must never be
  // redirected to the (inaccessible) detail page.
  it("invoices.manage-without-invoices.view: on success, redirects to the accessible /invoices/new?created=1, never the detail page", async () => {
    const owner = await createOwnerAndBusiness("app-inv-manage-only-redirect");
    cleanupUserIds.push(owner.userId);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-manage-only-redirect", [
      "invoices.manage",
    ]);
    cleanupUserIds.push(worker.userId);
    const memberId = await getMemberId(owner.businessId, worker.userId);
    await assignMemberToBranch(owner.client, owner.businessId, memberId, [branchA]);

    currentClient = worker.client;
    let caught: unknown;
    try {
      await createInvoice(
        undefined,
        formData({
          businessId: owner.businessId,
          creationKey: randomUuid(),
          customerId,
          branchId: branchA,
          items: JSON.stringify([{ productId: product.id, quantity: "1" }]),
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(redirectUrl(caught)).toBe(`/${owner.businessId}/invoices/new?created=1`);
  });
});

describe("recordInvoicePayment / voidInvoice — application layer", () => {
  async function setupInvoice(prefix: string, total: number) {
    const owner = await createOwnerAndBusiness(prefix);
    const branchA = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const { data: invoiceId } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchA,
      p_items: [{ description: "Service", quantity: 1, unit_price: total }],
    });
    return { owner, invoiceId: invoiceId as string };
  }

  // Codex adversarial review, remediation round 1, Medium 5: proves the
  // ACTION -> RPC -> stored-column pipeline preserves the exact instant a
  // browser would have computed for a Lagos-local payment time, never
  // re-interpreting it against the server's own runtime timezone. The
  // browser's own local-to-UTC conversion itself (components/invoices/payment-form.tsx's
  // paidAtIso) cannot run inside this Node test process — what CAN be
  // proven here, and is the actual root-cause fix, is that
  // recordInvoicePayment no longer does its own SERVER-side
  // `new Date(value).toISOString()` re-parse of whatever string arrives:
  // it forwards the already-ISO `paidAt` value verbatim. A payment
  // "entered" at 14:30 Africa/Lagos (WAT, UTC+1, no DST) on 2026-08-31 —
  // i.e. the exact ISO instant a correct browser conversion would have
  // produced — must be stored as EXACTLY 13:30 UTC, regardless of which
  // timezone this test process itself runs in.
  it("Medium 5: a Lagos-local payment time (already converted to its ISO instant, as the browser does) is stored as the exact corresponding UTC instant", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-lagos-tz", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    // 14:30 Africa/Lagos (UTC+1) == 13:30:00.000Z — computed here exactly
    // as components/invoices/payment-form.tsx's own paidAtIso would from
    // a datetime-local value of "2026-08-31T14:30" typed by a Lagos user.
    const lagosLocalAsUtcIso = "2026-08-31T13:30:00.000Z";

    let caught: unknown;
    try {
      await recordInvoicePayment(
        undefined,
        formData({
          businessId: owner.businessId,
          invoiceId,
          creationKey: randomUuid(),
          amount: "5000",
          paymentMethod: "CASH",
          paidAt: lagosLocalAsUtcIso,
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: payment } = await owner.client
      .from("invoice_payments")
      .select("paid_at")
      .eq("invoice_id", invoiceId)
      .single();
    // Stored EXACTLY as submitted — never shifted by the server's own
    // runtime timezone.
    expect(new Date(payment!.paid_at).toISOString()).toBe(lagosLocalAsUtcIso);
  });

  // Codex adversarial review, remediation round 2, Medium 2: the Server
  // Action boundary must independently reject a timezone-less instant —
  // never merely trust that the browser always converts it first (a
  // hand-crafted submission, a direct action call, or a browser quirk
  // could all skip that conversion). "2026-08-31T15:30" is exactly the
  // kind of value Date.parse() accepts and silently interprets against
  // the SERVER's own runtime timezone — it must be rejected as a
  // controlled field error, with NO invoice_payments row ever created.
  it("Medium 2: recordInvoicePayment rejects a timezone-less paidAt ('2026-08-31T15:30') before it can reach the database", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-tzless-reject", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await recordInvoicePayment(
      undefined,
      formData({
        businessId: owner.businessId,
        invoiceId,
        creationKey: randomUuid(),
        amount: "5000",
        paymentMethod: "CASH",
        paidAt: "2026-08-31T15:30",
      })
    );
    expect(result?.fieldErrors?.paidAt).toBeTruthy();

    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId);
    expect(payments).toHaveLength(0);
  });

  // Codex adversarial review, remediation round 2, Finding 5.3: the exact
  // worked example from the review itself — a valid, explicit UTC
  // instant is accepted and stored byte-identically.
  it("Medium 2: recordInvoicePayment accepts an explicit UTC instant ('2026-08-31T14:30:00.000Z')", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-utc-accept", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    let caught: unknown;
    try {
      await recordInvoicePayment(
        undefined,
        formData({
          businessId: owner.businessId,
          invoiceId,
          creationKey: randomUuid(),
          amount: "5000",
          paymentMethod: "CASH",
          paidAt: "2026-08-31T14:30:00.000Z",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const { data: payment } = await owner.client
      .from("invoice_payments")
      .select("paid_at")
      .eq("invoice_id", invoiceId)
      .single();
    expect(new Date(payment!.paid_at).toISOString()).toBe("2026-08-31T14:30:00.000Z");
  });

  // Codex adversarial review, remediation round 3 ("Semantically Invalid
  // ISO Calendar Dates"): "2026-02-30T15:30:00Z" is shaped exactly like a
  // valid offset-bearing instant (passes the round-2 regex), but
  // February never has a 30th — `Date.parse`/`new Date(...)` would
  // silently NORMALIZE this to March 2nd rather than reject it, letting
  // it reach record_invoice_payment/PostgREST/PostgreSQL, which fails
  // late with a raw SQLSTATE 22008 instead of a controlled field error.
  // Proves BOTH that the Server Action rejects it as a safe validation
  // error AND — via a spy on the real Supabase client's own .rpc method
  // — that record_invoice_payment is never even called, not merely that
  // its eventual DB error happens to be caught somewhere downstream.
  it("Medium: recordInvoicePayment rejects a semantically impossible calendar date ('2026-02-30T15:30:00Z') before the RPC is ever called", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-impossible-date", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const rpcSpy = vi.spyOn(owner.client, "rpc");
    try {
      const result = await recordInvoicePayment(
        undefined,
        formData({
          businessId: owner.businessId,
          invoiceId,
          creationKey: randomUuid(),
          amount: "5000",
          paymentMethod: "CASH",
          paidAt: "2026-02-30T15:30:00Z",
        })
      );
      expect(result?.fieldErrors?.paidAt).toBeTruthy();
      // The RPC boundary was never even reached — this is a schema
      // rejection, not a caught database error.
      expect(rpcSpy).not.toHaveBeenCalled();
    } finally {
      rpcSpy.mockRestore();
    }

    const { data: payments } = await owner.client.from("invoice_payments").select("id").eq("invoice_id", invoiceId);
    expect(payments).toHaveLength(0);
  });

  it("a well-formed payment succeeds, redirects, and the invoice balance/status update correctly", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay", 50000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    let caught: unknown;
    try {
      await recordInvoicePayment(
        undefined,
        formData({
          businessId: owner.businessId,
          invoiceId,
          creationKey: randomUuid(),
          amount: "20000",
          paymentMethod: "CASH",
          // A full, explicit, offset-bearing ISO instant (with seconds and
        // a trailing Z) — exactly what components/invoices/payment-form.tsx's
        // own browser-side paidAtIso always produces, and what
        // PaymentPaidAtSchema now requires (Codex adversarial review,
        // remediation round 2, Medium 2). The bare .slice(0, 16) form
        // this used to submit ("2026-08-31T15:30", no seconds, no
        // offset) is now correctly rejected at the schema boundary.
        paidAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const invoice = await getInvoice(owner.businessId, invoiceId);
    expect(invoice.status).toBe("PARTIALLY_PAID");
    expect(invoiceBalance(invoice)).toBe(30000);
  });

  it("a caller without payments.record is denied", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-unauthorized", 10000);
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-pay-unauthorized", ["payments.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const result = await recordInvoicePayment(
      undefined,
      formData({
        businessId: owner.businessId,
        invoiceId,
        creationKey: randomUuid(),
        amount: "1000",
        paymentMethod: "CASH",
        // A full, explicit, offset-bearing ISO instant (with seconds and
        // a trailing Z) — exactly what components/invoices/payment-form.tsx's
        // own browser-side paidAtIso always produces, and what
        // PaymentPaidAtSchema now requires (Codex adversarial review,
        // remediation round 2, Medium 2). The bare .slice(0, 16) form
        // this used to submit ("2026-08-31T15:30", no seconds, no
        // offset) is now correctly rejected at the schema boundary.
        paidAt: new Date().toISOString(),
      })
    );
    expect(result?.error).toContain("permission");
  });

  it("an overpayment attempt surfaces the safe, mapped error, never a raw DB message", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-overpay", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await recordInvoicePayment(
      undefined,
      formData({
        businessId: owner.businessId,
        invoiceId,
        creationKey: randomUuid(),
        amount: "50000",
        paymentMethod: "CASH",
        // A full, explicit, offset-bearing ISO instant (with seconds and
        // a trailing Z) — exactly what components/invoices/payment-form.tsx's
        // own browser-side paidAtIso always produces, and what
        // PaymentPaidAtSchema now requires (Codex adversarial review,
        // remediation round 2, Medium 2). The bare .slice(0, 16) form
        // this used to submit ("2026-08-31T15:30", no seconds, no
        // offset) is now correctly rejected at the schema boundary.
        paidAt: new Date().toISOString(),
      })
    );
    expect(result?.fieldErrors?.amount?.[0]).toContain("outstanding balance");
  });

  it("a malformed invoiceId never reaches getPermissions or the RPC", async () => {
    const owner = await createOwnerAndBusiness("app-inv-pay-malformed");
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    const result = await recordInvoicePayment(
      undefined,
      formData({
        businessId: owner.businessId,
        invoiceId: "not-a-uuid",
        creationKey: randomUuid(),
        amount: "1000",
        paymentMethod: "CASH",
        // A full, explicit, offset-bearing ISO instant (with seconds and
        // a trailing Z) — exactly what components/invoices/payment-form.tsx's
        // own browser-side paidAtIso always produces, and what
        // PaymentPaidAtSchema now requires (Codex adversarial review,
        // remediation round 2, Medium 2). The bare .slice(0, 16) form
        // this used to submit ("2026-08-31T15:30", no seconds, no
        // offset) is now correctly rejected at the schema boundary.
        paidAt: new Date().toISOString(),
      })
    );
    expect(result?.error).toBeTruthy();
  });

  it("voidInvoice succeeds for an unpaid invoice and redirects", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-void", 10000);
    cleanupUserIds.push(owner.userId);
    currentClient = owner.client;

    let caught: unknown;
    try {
      await voidInvoice(undefined, formData({ businessId: owner.businessId, invoiceId }));
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);

    const invoice = await getInvoice(owner.businessId, invoiceId);
    expect(invoice.status).toBe("VOID");
  });

  it("voidInvoice is denied for a caller without invoices.manage", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-void-unauthorized", 10000);
    cleanupUserIds.push(owner.userId);
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-void-unauthorized", ["invoices.view"]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const result = await voidInvoice(undefined, formData({ businessId: owner.businessId, invoiceId }));
    expect(result?.error).toContain("permission");
  });

  // Codex adversarial review, remediation round 1, Medium 4: a
  // payments.record-only caller (no invoices.view) previously had no
  // usable surface at all. searchPayableInvoicesAction must return REAL
  // eligible invoices for payments.record alone, and a successful payment
  // must redirect to the accessible /payments/record?created=1, never the
  // (inaccessible) invoice detail page.
  it("payments.record-only: searchPayableInvoicesAction resolves the invoice, and a successful payment redirects to /payments/record?created=1", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-record-only", 10000);
    cleanupUserIds.push(owner.userId);
    const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-pay-record-only", [
      "payments.record",
    ]);
    cleanupUserIds.push(worker.userId);

    currentClient = worker.client;
    const payable = await searchPayableInvoicesAction(owner.businessId, "");
    expect(payable.some((i) => i.id === invoiceId)).toBe(true);

    let caught: unknown;
    try {
      await recordInvoicePayment(
        undefined,
        formData({
          businessId: owner.businessId,
          invoiceId,
          creationKey: randomUuid(),
          amount: "1000",
          paymentMethod: "CASH",
          paidAt: new Date().toISOString(),
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(redirectUrl(caught)).toBe(`/${owner.businessId}/payments/record?created=1`);
  });

  // Codex adversarial review, remediation round 1, Medium 4: a
  // payments.view-only caller (no invoices.view) previously had a real
  // RLS-readable payments table but no usable surface to read it through
  // — listInvoicePaymentsForViewer must resolve invoice_number/customer/
  // branch for payments.view alone.
  it("payments.view-only: listInvoicePaymentsForViewer resolves invoice/customer/branch details without invoices.view", async () => {
    const { owner, invoiceId } = await setupInvoice("app-inv-pay-view-only", 10000);
    cleanupUserIds.push(owner.userId);
    const { error: payErr } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId,
      p_amount: 4000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(payErr).toBeNull();
    const viewer = await createMemberWithCustomPermissions(owner.businessId, "app-inv-pay-view-only", [
      "payments.view",
    ]);
    cleanupUserIds.push(viewer.userId);

    currentClient = viewer.client;
    const payments = await listInvoicePaymentsForViewer(owner.businessId);
    const row = payments.find((p) => p.amount === 4000);
    expect(row).toBeTruthy();
    expect(row!.invoice_number).toBeTruthy();
    expect(row!.customer_name_snapshot).toBeTruthy();
    expect(row!.branch_name_snapshot).toBeTruthy();
  });

  // Codex adversarial review, remediation round 1, Low 6: void
  // eligibility must be the RPC's own server-authoritative answer, never
  // inferred from an empty (possibly permission-filtered) payments array
  // — checked here for an invoices.manage-ONLY caller with NO
  // payments.view at all, in both the eligible and ineligible cases.
  describe("getInvoiceVoidEligibility (Low 6)", () => {
    it("is true for an unpaid invoice, for an invoices.manage-only caller with no payments.view", async () => {
      const { owner, invoiceId } = await setupInvoice("app-inv-void-elig-true", 10000);
      cleanupUserIds.push(owner.userId);
      const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-void-elig-true", [
        "invoices.manage",
      ]);
      cleanupUserIds.push(worker.userId);

      currentClient = worker.client;
      expect(await getInvoiceVoidEligibility(owner.businessId, invoiceId)).toBe(true);
    });

    it("is false for an invoice with a payment recorded, for the SAME invoices.manage-only caller with no payments.view", async () => {
      const { owner, invoiceId } = await setupInvoice("app-inv-void-elig-false", 10000);
      cleanupUserIds.push(owner.userId);
      const { error: payErr } = await owner.client.rpc("record_invoice_payment", {
        p_business_id: owner.businessId,
        p_creation_key: randomUuid(),
        p_invoice_id: invoiceId,
        p_amount: 1000,
        p_payment_method: "CASH",
        p_paid_at: new Date().toISOString(),
      });
      expect(payErr).toBeNull();
      const worker = await createMemberWithCustomPermissions(owner.businessId, "app-inv-void-elig-false", [
        "invoices.manage",
      ]);
      cleanupUserIds.push(worker.userId);

      currentClient = worker.client;
      // Confirms the OLD, wrong inference (payments.length === 0 -> true)
      // would have said "eligible" here, since this caller has no
      // payments.view and would see an empty array — the RPC-backed
      // answer must correctly say false regardless.
      expect(await getInvoiceVoidEligibility(owner.businessId, invoiceId)).toBe(false);
    });
  });
});
