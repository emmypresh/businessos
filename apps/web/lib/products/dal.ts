import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseCostValue } from "@/lib/inventory/cost";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE, type Cursor } from "@/lib/pagination";
import { buildImatchSearchValue } from "@/lib/search";
import type { ProductStatus } from "./constants";

// Explicit column list — NEVER select("*"). cost_price is deliberately
// absent: authenticated's SELECT grant on products excludes it entirely
// (see the committed migrations), so a select("*") here would either
// 42501 the whole query or silently start working/breaking depending on
// grant changes neither of which this file controls. Cost is read only
// through getProductCostIfAllowed below.
const PRODUCT_COLUMNS =
  "id, business_id, name, description, sku, barcode, category, unit, " +
  "selling_price, currency_code, track_inventory, low_stock_threshold, " +
  "status, created_at, updated_at";

export type ProductRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  unit: string;
  selling_price: number;
  currency_code: string;
  track_inventory: boolean;
  low_stock_threshold: number | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ProductListRow = ProductRow & {
  quantity: number;
};

export const listProducts = cache(
  async (
    businessId: string,
    options: { search?: string; status?: ProductStatus; cursor?: string } = {}
  ): Promise<{ rows: ProductListRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();

    let query = supabase
      .from("products")
      .select(PRODUCT_COLUMNS + ", inventory_balances(quantity)")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    if (options.status) {
      query = query.eq("status", options.status);
    }
    if (options.search) {
      // buildImatchSearchValue makes the term an opaque literal to
      // PostgREST's .or() grammar (never altering columns/operators/
      // grouping) AND to Postgres's regex wildcard semantics (every
      // regex metacharacter, including a bare *, is matched literally,
      // not as pattern syntax). PostgREST's `ilike`/`like` operators are
      // deliberately NOT used here: they unconditionally alias a literal
      // `*` in the value to `%` with no escape that survives it, so a
      // product name containing `*` could never be searched for
      // literally through them — see lib/search.ts for the full
      // escaping rationale, verified against the real local Data API.
      const value = buildImatchSearchValue(options.search);
      query = query.or(`name.imatch.${value},sku.imatch.${value}`);
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load products: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as (ProductRow & {
      inventory_balances: { quantity: number }[];
    })[];

    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const mapped: ProductListRow[] = page.map((row) => {
      const { inventory_balances, ...product } = row;
      const quantity = (inventory_balances ?? []).reduce((sum, b) => sum + Number(b.quantity), 0);
      return { ...product, quantity };
    });

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: mapped, nextCursor };
  }
);

export const getProduct = cache(async (businessId: string, productId: string): Promise<ProductRow> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", productId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load product: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return data as unknown as ProductRow;
});

// Independently verifies inventory.view_cost itself (does not trust a
// caller-supplied permission set) — the RPC is never even called when
// the permission is absent, not merely "called and its result discarded."
export async function getProductCostIfAllowed(
  businessId: string,
  productId: string
): Promise<number | null> {
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVENTORY_VIEW_COST)) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_product_cost", { p_product_id: productId });
  if (error) {
    throw new Error(`Failed to load product cost: ${error.message}`);
  }
  return parseCostValue(data);
}

export type { Cursor };
