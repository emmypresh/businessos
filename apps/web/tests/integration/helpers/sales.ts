// Shared fixtures for Phase 1D (customers + sales) integration tests.
// Mirrors tests/integration/helpers/inventory.ts's pattern exactly.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { randomUuid } from "./inventory";

type Client = SupabaseClient<Database>;

export async function makeSaleProduct(
  client: Client,
  businessId: string,
  overrides: {
    sellingPrice?: number;
    costPrice?: number;
    openingQuantity?: number;
    name?: string;
    // Phase 1G: opening stock always lands at the business-wide default
    // location (create_product's own unchanged behavior — see
    // branch_aware_inventory_movements.sql's own header comment for why
    // this is deliberately NOT reinterpreted per branch). A test that
    // needs to sell at a DIFFERENT branch — one with no stock of its own —
    // without that being a stock test in itself should set this false,
    // rather than the test silently getting INSUFFICIENT_STOCK for a
    // reason unrelated to what it's actually proving.
    trackInventory?: boolean;
  } = {}
) {
  const { data, error } = await client.rpc("create_product", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: overrides.name ?? "Sale Test Product",
    p_sku: `sale-test-${randomUuid()}`,
    p_selling_price: overrides.sellingPrice ?? 1000,
    p_cost_price: overrides.costPrice ?? 600,
    p_track_inventory: overrides.trackInventory ?? true,
    p_opening_quantity: overrides.trackInventory === false ? undefined : overrides.openingQuantity ?? 100,
  });
  if (error || !data) throw new Error(`create_product failed: ${error?.message}`);
  return data;
}

export async function makeCustomer(
  client: Client,
  businessId: string,
  overrides: { name?: string; phone?: string; email?: string; address?: string } = {}
) {
  const { data, error } = await client.rpc("create_customer", {
    p_business_id: businessId,
    p_creation_key: randomUuid(),
    p_name: overrides.name ?? "Test Customer",
    p_phone: overrides.phone,
    p_email: overrides.email,
    p_address: overrides.address,
  });
  if (error || !data) throw new Error(`create_customer failed: ${error?.message}`);
  return data as string;
}

export function saleItem(productId: string, quantity: number) {
  return { product_id: productId, quantity };
}
