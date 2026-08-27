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
const SALE_COLUMNS =
  "id, business_id, customer_id, " +
  "customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot, " +
  "inventory_location_id, inventory_location_name_snapshot, " +
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

export const searchProductsForSale = cache(
  async (businessId: string, search?: string): Promise<SaleProductOption[]> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("products")
      .select("id, name, sku, selling_price, currency_code, track_inventory, inventory_balances(quantity)")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("name", { ascending: true })
      .limit(DEFAULT_PAGE_SIZE);

    if (search) {
      const value = buildImatchSearchValue(search);
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
      inventory_balances: { quantity: number }[];
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
