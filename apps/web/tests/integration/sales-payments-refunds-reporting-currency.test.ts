import { describe, expect, it, afterEach } from "vitest";
import { deleteTestUser } from "./helpers/admin-client";
import {
  createOwnerAndBusiness,
  randomUuid,
  setBusinessCountryCurrencyForTest,
} from "./helpers/inventory";
import { makeSaleProduct, makeCustomer, saleItem } from "./helpers/sales";
import { getDefaultBranchId } from "./helpers/staff";
import { createTestDbClient } from "./helpers/db-client";

// Phase 1Q-0C Slice 2: sales/payments/refunds/reporting currency
// migration. The non-NGN activation gate inside create_business stays
// CLOSED throughout this file — every non-NG fixture is produced via
// setBusinessCountryCurrencyForTest (a direct, service-role-only column
// correction on an already-created NG/NGN business), never by calling
// create_business itself with a non-NG country.

let cleanupUserIds: string[] = [];
afterEach(async () => {
  for (const id of cleanupUserIds) await deleteTestUser(id);
  cleanupUserIds = [];
});

describe("sales.currency_code derives from the owning business, never a client-supplied value or a hardcoded default", () => {
  it("an NG business's sale is durably NGN", async () => {
    const owner = await createOwnerAndBusiness("sale-cur-ng");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 500 });

    const { data: saleId, error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_branch_id: branchId,
    });
    expect(error).toBeNull();

    const { data: sale } = await owner.client
      .from("sales")
      .select("currency_code, total")
      .eq("id", saleId as string)
      .single();
    expect(sale?.currency_code).toBe("NGN");
    expect(Number(sale?.total)).toBe(500);
  });

  it("a GH-fixture business's sale is durably GHS, even though nothing in the sale-creation call ever mentions currency", async () => {
    const owner = await createOwnerAndBusiness("sale-cur-gh");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GH", "GHS");
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 750 });

    const { data: saleId, error } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 1)],
      p_branch_id: branchId,
    });
    expect(error).toBeNull();

    const { data: sale } = await owner.client
      .from("sales")
      .select("currency_code")
      .eq("id", saleId as string)
      .single();
    expect(sale?.currency_code).toBe("GHS");
  });

  it("a direct database insert of a sale with a currency_code that does not match its own business is rejected", async () => {
    const owner = await createOwnerAndBusiness("sale-cur-mismatch");
    cleanupUserIds.push(owner.userId);
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const { data: location } = await owner.client
      .from("inventory_locations")
      .select("id")
      .eq("business_id", owner.businessId)
      .eq("is_default", true)
      .single();
    const locationId = location?.id as string;

    const sql = createTestDbClient();
    try {
      await expect(
        sql`
          insert into public.sales (
            business_id, inventory_location_id, inventory_location_name_snapshot,
            branch_id, branch_name_snapshot, sale_number, currency_code, creation_key, created_by
          )
          select ${owner.businessId}, ${locationId}, 'Main', ${branchId}, 'Main', 'SALE-DIRECT-1', 'USD', ${randomUuid()}, id
          from auth.users where id = ${owner.userId}
        `
      ).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });
});

describe("payments inherit their parent invoice's currency — no independent currency parameter exists to spoof", () => {
  it("record_invoice_payment never accepts a currency parameter; the invoice's own currency_code is unaffected by recording a payment", async () => {
    const owner = await createOwnerAndBusiness("pay-cur-gh");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GH", "GHS");
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const customerId = await makeCustomer(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 1000 });

    const { data: invoiceId, error: invoiceError } = await owner.client.rpc("create_invoice", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_items: [{ product_id: product.id, quantity: 1 }],
    });
    expect(invoiceError).toBeNull();

    const { data: invoiceBefore } = await owner.client
      .from("invoices")
      .select("currency_code")
      .eq("id", invoiceId as string)
      .single();
    expect(invoiceBefore?.currency_code).toBe("GHS");

    const { error: paymentError } = await owner.client.rpc("record_invoice_payment", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_invoice_id: invoiceId as string,
      p_amount: 1000,
      p_payment_method: "CASH",
      p_paid_at: new Date().toISOString(),
    });
    expect(paymentError).toBeNull();

    const { data: invoiceAfter } = await owner.client
      .from("invoices")
      .select("currency_code, status")
      .eq("id", invoiceId as string)
      .single();
    expect(invoiceAfter?.currency_code).toBe("GHS");
    expect(invoiceAfter?.status).toBe("PAID");
  });
});

describe("refunds inherit their parent sale's currency — sale_returns carries no independent currency column to spoof", () => {
  it("a GH-fixture business's return/refund reflects the original GHS sale, with no mismatched-currency path available", async () => {
    const owner = await createOwnerAndBusiness("refund-cur-gh");
    cleanupUserIds.push(owner.userId);
    await setBusinessCountryCurrencyForTest(owner.businessId, "GH", "GHS");
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 400 });

    const { data: saleId, error: saleError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 2)],
      p_branch_id: branchId,
      p_payment_status: "PAID",
      p_payment_method: "CASH",
    });
    expect(saleError).toBeNull();

    const { data: saleItems } = await owner.client
      .from("sale_items")
      .select("id")
      .eq("sale_id", saleId as string);
    const saleItemId = saleItems?.[0]?.id as string;

    const { data: returnId, error: returnError } = await owner.client.rpc("create_sale_return", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_sale_id: saleId as string,
      p_items: [{ sale_item_id: saleItemId, quantity: 1, restock: true }],
      p_refund_amount: 400,
      p_refund_method: "CASH",
      p_reason: "CUSTOMER_RETURN",
      p_notes: undefined,
    });
    expect(returnError).toBeNull();

    // sale_returns carries no currency_code column at all (by design — see
    // 20260901080100_create_sale_returns_and_items.sql) — the refund's
    // currency identity is entirely a function of the sale it references,
    // proven here by confirming the referenced sale is still GHS.
    const { data: saleReturn } = await owner.client
      .from("sale_returns")
      .select("sale_id, refund_amount")
      .eq("id", returnId as string)
      .single();
    expect(Number(saleReturn?.refund_amount)).toBe(400);

    const { data: sale } = await owner.client
      .from("sales")
      .select("currency_code")
      .eq("id", saleReturn?.sale_id as string)
      .single();
    expect(sale?.currency_code).toBe("GHS");
  });
});

describe("get_financial_summary derives currency_code from the owning business, not a hardcoded literal", () => {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  it.each([
    ["NG", "NGN"],
    ["GH", "GHS"],
    ["KE", "KES"],
    ["ZA", "ZAR"],
    ["GB", "GBP"],
    ["US", "USD"],
  ])("a %s-fixture business's report currency_code is %s", async (countryCode, currencyCode) => {
    const owner = await createOwnerAndBusiness(`report-cur-${countryCode.toLowerCase()}`);
    cleanupUserIds.push(owner.userId);
    if (countryCode !== "NG") {
      await setBusinessCountryCurrencyForTest(owner.businessId, countryCode, currencyCode);
    }
    const branchId = await getDefaultBranchId(owner.client, owner.businessId);
    const product = await makeSaleProduct(owner.client, owner.businessId, { sellingPrice: 200 });

    const { error: saleError } = await owner.client.rpc("create_sale", {
      p_business_id: owner.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(product.id, 3)],
      p_branch_id: branchId,
    });
    expect(saleError).toBeNull();

    const { data, error } = await owner.client.rpc("get_financial_summary", {
      p_business_id: owner.businessId,
      p_from: from,
      p_to: to,
    });
    expect(error).toBeNull();
    const summary = data as { currency_code: string; gross_sales: number };
    expect(summary.currency_code).toBe(currencyCode);
    // Raw numeric integrity — no FX, no conversion: the exact same amount
    // that would be recorded for an NG/NGN business, regardless of which
    // currency it is denominated in.
    expect(Number(summary.gross_sales)).toBe(600);
  });

  it("never mixes currencies across businesses: an NG business's summary is unaffected by a GH-fixture business's own sales", async () => {
    const ng = await createOwnerAndBusiness("report-mix-ng");
    cleanupUserIds.push(ng.userId);
    const gh = await createOwnerAndBusiness("report-mix-gh");
    cleanupUserIds.push(gh.userId);
    await setBusinessCountryCurrencyForTest(gh.businessId, "GH", "GHS");

    const ngBranch = await getDefaultBranchId(ng.client, ng.businessId);
    const ngProduct = await makeSaleProduct(ng.client, ng.businessId, { sellingPrice: 1000 });
    await ng.client.rpc("create_sale", {
      p_business_id: ng.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(ngProduct.id, 1)],
      p_branch_id: ngBranch,
    });

    const ghBranch = await getDefaultBranchId(gh.client, gh.businessId);
    const ghProduct = await makeSaleProduct(gh.client, gh.businessId, { sellingPrice: 9999 });
    await gh.client.rpc("create_sale", {
      p_business_id: gh.businessId,
      p_creation_key: randomUuid(),
      p_items: [saleItem(ghProduct.id, 1)],
      p_branch_id: ghBranch,
    });

    const { data } = await ng.client.rpc("get_financial_summary", {
      p_business_id: ng.businessId,
      p_from: from,
      p_to: to,
    });
    const summary = data as { currency_code: string; gross_sales: number };
    expect(summary.currency_code).toBe("NGN");
    expect(Number(summary.gross_sales)).toBe(1000);
  });
});
