import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import type { IdentifierType } from "./identifiers";

// Explicit column list — NEVER select("*"). Mirrors lib/products/dal.ts's
// own PRODUCT_COLUMNS convention: created_by is deliberately absent
// (no caller-facing need for it, and it was never granted to
// `authenticated` on this table — see create_product_identifiers.sql).
const IDENTIFIER_COLUMNS =
  "id, business_id, product_id, identifier_type, identifier_value, is_primary, created_at, updated_at";

export type ProductIdentifierRow = {
  id: string;
  business_id: string;
  product_id: string;
  identifier_type: IdentifierType;
  identifier_value: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

export const listProductIdentifiers = cache(
  async (businessId: string, productId: string): Promise<ProductIdentifierRow[]> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("product_identifiers")
      .select(IDENTIFIER_COLUMNS)
      .eq("business_id", businessId)
      .eq("product_id", productId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to load product identifiers: ${error.message}`);
    }

    return (data ?? []) as unknown as ProductIdentifierRow[];
  }
);
