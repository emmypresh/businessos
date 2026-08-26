import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { parseCostValue } from "./cost";
import { encodeCursor, decodeCursor, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import type { MovementType } from "./constants";

export const getDefaultInventoryLocation = cache(
  async (businessId: string): Promise<{ id: string; name: string }> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("inventory_locations")
      .select("id, name")
      .eq("business_id", businessId)
      .eq("is_default", true)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load the default inventory location: ${error.message}`);
    }
    if (!data) {
      // Should never happen given the database's own backfill/trigger
      // guarantee (every business gets exactly one default location) —
      // a thrown error here is a genuine bug signal, not an expected
      // user-facing 404.
      throw new Error(`Business ${businessId} has no default inventory location.`);
    }

    return data;
  }
);

// Single-product stock lookup for the product detail page's stock-summary
// card — deliberately its own small query rather than reusing the
// (paginated, multi-product) getInventoryOverview for one row.
export const getProductStock = cache(
  async (
    businessId: string,
    productId: string
  ): Promise<{ quantity: number; locationName: string }> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("inventory_balances")
      .select("quantity, inventory_locations(name)")
      .eq("business_id", businessId)
      .eq("product_id", productId);

    if (error) {
      throw new Error(`Failed to load product stock: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as { quantity: number; inventory_locations: { name: string } | null }[];
    if (rows.length === 0) {
      const defaultLocation = await getDefaultInventoryLocation(businessId);
      return { quantity: 0, locationName: defaultLocation.name };
    }

    const quantity = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
    const locationName = rows[0].inventory_locations?.name ?? "—";
    return { quantity, locationName };
  }
);

export type InventoryOverviewRow = {
  productId: string;
  name: string;
  sku: string | null;
  trackInventory: boolean;
  lowStockThreshold: number | null;
  quantity: number;
  locationName: string;
};

export const getInventoryOverview = cache(
  async (
    businessId: string,
    options: { cursor?: string } = {}
  ): Promise<{ rows: InventoryOverviewRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();
    const defaultLocation = await getDefaultInventoryLocation(businessId);

    let query = supabase
      .from("products")
      .select(
        "id, name, sku, track_inventory, low_stock_threshold, created_at, " +
          "inventory_balances(quantity, inventory_location_id, inventory_locations(name))"
      )
      .eq("business_id", businessId)
      .eq("status", "active")
      .eq("track_inventory", true)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEFAULT_PAGE_SIZE + 1);

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load inventory overview: ${error.message}`);
    }

    type Row = {
      id: string;
      name: string;
      sku: string | null;
      track_inventory: boolean;
      low_stock_threshold: number | null;
      created_at: string;
      inventory_balances: { quantity: number; inventory_location_id: string; inventory_locations: { name: string } | null }[];
    };
    const rows = (data ?? []) as unknown as Row[];
    const hasMore = rows.length > DEFAULT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEFAULT_PAGE_SIZE) : rows;

    const mapped: InventoryOverviewRow[] = page.map((row) => {
      const balances = row.inventory_balances ?? [];
      // Phase 1C is effectively single-location; summing across whatever
      // balance rows exist keeps this correct if a second location is
      // ever introduced, and a product with zero balance rows (never
      // moved) correctly renders 0 at the business's default location.
      const quantity = balances.reduce((sum, b) => sum + Number(b.quantity), 0);
      const locationName = balances[0]?.inventory_locations?.name ?? defaultLocation.name;
      return {
        productId: row.id,
        name: row.name,
        sku: row.sku,
        trackInventory: row.track_inventory,
        lowStockThreshold: row.low_stock_threshold,
        quantity,
        locationName,
      };
    });

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

    return { rows: mapped, nextCursor };
  }
);

export type InventoryHistoryRow = {
  id: string;
  createdAt: string;
  productId: string;
  productName: string;
  productSku: string | null;
  movementType: MovementType;
  quantityDelta: number;
  balanceAfter: number;
  locationName: string;
  reason: string;
  note: string | null;
  createdBy: string;
};

export const getInventoryHistory = cache(
  async (
    businessId: string,
    options: { productId?: string; cursor?: string; limit?: number } = {}
  ): Promise<{ rows: InventoryHistoryRow[]; nextCursor: string | null }> => {
    await requireUser();
    const supabase = await createClient();
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;

    let query = supabase
      .from("inventory_ledger")
      .select(
        "id, created_at, product_id, movement_type, quantity_delta, balance_after, reason, note, created_by, " +
          "products(name, sku), inventory_locations(name)"
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);

    if (options.productId) {
      query = query.eq("product_id", options.productId);
    }

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load inventory history: ${error.message}`);
    }

    type Row = {
      id: string;
      created_at: string;
      product_id: string;
      movement_type: string;
      quantity_delta: number;
      balance_after: number;
      reason: string;
      note: string | null;
      created_by: string;
      products: { name: string; sku: string | null } | null;
      inventory_locations: { name: string } | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const mapped: InventoryHistoryRow[] = page.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      productId: row.product_id,
      productName: row.products?.name ?? "Unknown product",
      productSku: row.products?.sku ?? null,
      movementType: row.movement_type as MovementType,
      quantityDelta: Number(row.quantity_delta),
      balanceAfter: Number(row.balance_after),
      locationName: row.inventory_locations?.name ?? "Unknown location",
      reason: row.reason,
      note: row.note,
      createdBy: row.created_by,
    }));

    const lastRaw = page[page.length - 1];
    const nextCursor =
      hasMore && lastRaw ? encodeCursor({ createdAt: lastRaw.created_at, id: lastRaw.id }) : null;

    return { rows: mapped, nextCursor };
  }
);

// Independently verifies inventory.view_cost itself, exactly like
// getProductCostIfAllowed — the RPC is never called when the permission
// is absent.
export async function getMovementCostIfAllowed(
  businessId: string,
  ledgerId: string
): Promise<number | null> {
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.INVENTORY_VIEW_COST)) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_movement_unit_cost", { p_ledger_id: ledgerId });
  if (error) {
    throw new Error(`Failed to load movement cost: ${error.message}`);
  }
  return parseCostValue(data);
}
