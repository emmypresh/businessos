import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import type { PaymentStatus } from "./constants";

// Explicit column list — never select("*"). unit_cost_snapshot is
// deliberately absent from SALE_ITEM_COLUMNS below: authenticated's
// SELECT grant on sale_items excludes it entirely (see the committed
// migrations), so a select("*") would 42501 the whole query. Phase 1D has
// no cost/profit UI — cost is never read here, at all.
// Phase 1G: branch_id/branch_name_snapshot are both selected here (the
// latter for every historical-display use — see this file's own header
// comment on snapshots — the former only so callers can filter/group by
// it without a second query). Both are NOT NULL on this table (every sale
// belongs to exactly one branch, resolved authoritatively by create_sale
// — see 20260829080100_branch_aware_sales.sql), so neither is ever
// undefined on a real row.
const SALE_COLUMNS =
  "id, business_id, customer_id, " +
  "customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot, " +
  "inventory_location_id, inventory_location_name_snapshot, branch_id, branch_name_snapshot, " +
  "sale_number, status, payment_status, payment_method, " +
  "subtotal, discount, total, amount_paid, currency_code, notes, " +
  "created_by, created_at, updated_at, completed_at, cancelled_at";

const SALE_ITEM_COLUMNS =
  "id, business_id, sale_id, product_id, product_name_snapshot, sku_snapshot, " +
  "unit_price, quantity, line_total, created_at";

export type SaleRow = {
  id: string;
  business_id: string;
  customer_id: string | null;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
  customer_email_snapshot: string | null;
  customer_address_snapshot: string | null;
  inventory_location_id: string;
  inventory_location_name_snapshot: string;
  branch_id: string;
  branch_name_snapshot: string;
  sale_number: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  discount: number;
  total: number;
  amount_paid: number;
  currency_code: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
};

export type SaleItemRow = {
  id: string;
  business_id: string;
  sale_id: string;
  product_id: string;
  product_name_snapshot: string;
  sku_snapshot: string | null;
  unit_price: number;
  quantity: number;
  line_total: number;
  created_at: string;
};

export const listSales = cache(
  async (
    businessId: string,
    options: {
      search?: string;
      paymentStatus?: PaymentStatus;
      customerId?: string;
      branchId?: string;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
    } = {}
  ): Promise<{ rows: SaleRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("sales")
      .select(SALE_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    if (options.paymentStatus) {
      query = query.eq("payment_status", options.paymentStatus);
    }
    if (options.customerId) {
      query = query.eq("customer_id", options.customerId);
    }
    if (options.branchId) {
      // sales.view is business-wide (never gated on has_branch_access —
      // see branch_aware_sales.sql's own header comment), so this is a
      // plain equality filter over data the caller can already see in
      // full; it never widens visibility beyond what sales.view already
      // grants. The page layer only ever offers every branch the caller's
      // sales.view already covers as filter choices
      // (listSalesFilterBranchOptions — business-wide, including inactive
      // branches, never narrowed to the caller's own operational
      // assignment), but this DAL itself does not re-validate that — a
      // filter value outside that set simply narrows the
      // (already-fully-visible) result set to zero or more rows, never
      // discloses anything new.
      query = query.eq("branch_id", options.branchId);
    }
    if (options.dateFrom) {
      query = query.gte("created_at", options.dateFrom);
    }
    if (options.dateTo) {
      query = query.lte("created_at", options.dateTo);
    }
    if (options.search) {
      // Structured filters above use plain eq/gte/lte — never raw string
      // interpolation. Free-text sale-number search reuses the same
      // imatch encoder already proven safe for products/customers.
      const value = buildImatchSearchValue(options.search);
      query = query.or(`sale_number.imatch.${value}`);
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load sales: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as SaleRow[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: page, nextCursor };
  }
);

// Independent of listSales — used by the customer detail page's sale
// history section, which the caller must gate on sales.view itself (a
// caller can hold customers.view without sales.view; this function is
// never called unconditionally from a customer-facing page).
export const listSalesForCustomer = cache(
  async (
    businessId: string,
    customerId: string,
    options: { cursor?: string } = {}
  ): Promise<{ rows: SaleRow[]; nextCursor: string | null }> => {
    return listSales(businessId, { customerId, cursor: options.cursor });
  }
);

export const getSale = cache(async (businessId: string, saleId: string): Promise<SaleRow> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sales")
    .select(SALE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", saleId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load sale: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as SaleRow;
});

export const getSaleItems = cache(async (businessId: string, saleId: string): Promise<SaleItemRow[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sale_items")
    .select(SALE_ITEM_COLUMNS)
    .eq("business_id", businessId)
    .eq("sale_id", saleId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load sale items: ${error.message}`);
  }

  return (data ?? []) as unknown as SaleItemRow[];
});

// Product picker for the "new sale" flow — deliberately its own narrow
// query, not a reuse of lib/products/dal.ts's listProducts: only active
// products are ever sellable, selling_price and live stock are the only
// numbers a sale-creation UI needs, and cost_price/cost_price-adjacent
// data is never selected here at all (Phase 1D has no price-override /
// cost-visibility surface in the sale-creation UI, per the approved
// scope).
export type SaleProductOption = {
  id: string;
  name: string;
  sku: string | null;
  sellingPrice: number;
  currencyCode: string;
  trackInventory: boolean;
  quantity: number;
};

// Codex adversarial review, application-layer round 2, Blocker 2: this
// availability figure must reflect stock at the SAME location create_sale
// itself deducts from for the branch being sold at — its own resolution
// (20260829080100_branch_aware_sales.sql) is exactly the branch's single
// canonical (is_branch_default = true) location, never a sum across every
// location in the business. `locationId` is that already-resolved
// canonical location id (lib/branches/dal.ts's getBranchCanonicalLocation,
// resolved by the caller — lib/sales/actions.ts — from the form's own
// selected branch), never a raw client-supplied id trusted for anything
// beyond this read-only display figure; create_sale re-derives and
// re-validates its own location independently regardless of what this
// number ever showed. Omitting it (no branch selected yet) falls back to
// summing every balance the product has, purely so the picker has SOME
// number to show before a branch choice exists — this is display-only in
// both cases, never sent to the RPC.
export const searchProductsForSale = cache(
  async (
    businessId: string,
    // Codex adversarial review, application-layer round 3, Medium 1:
    // productIds is a BATCH re-fetch mode — given a fixed set of product
    // ids (the sale form's own already-added line items) and a branch's
    // resolved locationId, it returns each product's availability at
    // THAT branch alone, in one query, never one request per line
    // ("Avoid N+1 requests" per the review). Mutually exclusive with
    // `search` in practice (the sale form never combines them — see
    // getSaleProductAvailabilityAction), but nothing here forbids both
    // being applied together if a future caller needed to.
    options: { search?: string; locationId?: string; productIds?: string[] } = {}
  ): Promise<SaleProductOption[]> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("products")
      .select("id, name, sku, selling_price, currency_code, track_inventory, inventory_balances(quantity, inventory_location_id)")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("name", { ascending: true });

    // The DEFAULT_PAGE_SIZE cap only makes sense for a free-text search
    // (an unbounded, browsable result set) — a productIds batch re-fetch
    // is bounded by the sale's own line-item count instead, which a real
    // sale can legitimately exceed 25 of; capping it here would silently
    // drop some lines' availability refresh rather than a search result.
    if (!options.productIds || options.productIds.length === 0) {
      query = query.limit(DEFAULT_PAGE_SIZE);
    }

    if (options.locationId) {
      // Filters the EMBEDDED inventory_balances rows (a left embed) —
      // never the top-level products query — so a product with zero
      // balance at this specific location still appears, correctly
      // showing 0, rather than being dropped from the picker entirely.
      query = query.eq("inventory_balances.inventory_location_id", options.locationId);
    }

    if (options.productIds && options.productIds.length > 0) {
      query = query.in("id", options.productIds);
    }

    if (options.search) {
      const value = buildImatchSearchValue(options.search);
      query = query.or(`name.imatch.${value},sku.imatch.${value}`);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to search products: ${error.message}`);
    }

    type Row = {
      id: string;
      name: string;
      sku: string | null;
      selling_price: number;
      currency_code: string;
      track_inventory: boolean;
      inventory_balances: { quantity: number; inventory_location_id: string }[];
    };
    const rows = (data ?? []) as unknown as Row[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      sellingPrice: row.selling_price,
      currencyCode: row.currency_code,
      trackInventory: row.track_inventory,
      quantity: (row.inventory_balances ?? []).reduce((sum, b) => sum + Number(b.quantity), 0),
    }));
  }
);

export type { Cursor };
