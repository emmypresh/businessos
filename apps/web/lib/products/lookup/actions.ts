"use server";

// Phase 1Q-C — centralized lookup entry points (phase instruction §29):
// every UI surface that needs "identifier -> product info" calls THESE
// three functions, never `.rpc(...)` or `fetch(...)` directly — matching
// this file's own sibling lib/products/actions.ts's existing convention
// of Server Actions being the ONLY place a mutation/lookup boundary is
// defined.
//
// Called directly as async functions from a client component (Next.js
// Server Actions may be invoked this way, not only as a <form action>) —
// deliberately NOT wired through useActionState, since this lookup is
// read-only, fired on demand from a button click, and needs its result
// rendered inline without a page transition (phase instruction §23).

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { openFoodFactsProvider } from "./providers/open-food-facts";
import { withLookupCache } from "./cache";
import { ProductLookupProviderError } from "./provider";
import { PROVIDER_ERROR_CODE, type LookupResult } from "./types";

const provider = openFoodFactsProvider;

// The single GS1 barcode family this app recognizes today (phase
// instruction §9) — anything else normalizes to 'OTHER', which is
// eligible for LOCAL lookup only, never the external provider.
const GTIN_FAMILY = new Set(["GTIN", "UPC_A", "EAN_13", "EAN_8"]);

/**
 * Local-first, business-scoped lookup (phase instruction §1/§11). Never
 * throws for a "normal" miss/invalid case — every RPC error surfaces as
 * a controlled INVALID result instead, so a caller never needs a
 * try/catch to keep the calling form's state intact.
 */
export async function lookupLocalProductByIdentifier(
  businessId: string,
  rawValue: string
): Promise<LookupResult> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("lookup_product_identifier", {
    p_business_id: businessId,
    p_raw_value: rawValue,
  });

  if (error) {
    return { state: "INVALID", identifierType: "OTHER", normalizedValue: "" };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        status: string;
        identifier_type: string;
        normalized_value: string;
        product_id: string | null;
        product_name: string | null;
        product_sku: string | null;
        product_status: string | null;
        product_selling_price: number | string | null;
      }
    | undefined;

  if (!row) {
    return { state: "INVALID", identifierType: "OTHER", normalizedValue: "" };
  }

  if (row.status === "LOCAL_MATCH" && row.product_id && row.product_name && row.product_status) {
    return {
      state: "LOCAL_MATCH",
      identifierType: row.identifier_type,
      normalizedValue: row.normalized_value,
      product: {
        productId: row.product_id,
        name: row.product_name,
        sku: row.product_sku,
        status: row.product_status,
        sellingPrice: row.product_selling_price === null ? null : Number(row.product_selling_price),
      },
    };
  }

  if (row.status === "INVALID") {
    return { state: "INVALID", identifierType: row.identifier_type, normalizedValue: row.normalized_value };
  }

  return { state: "NOT_FOUND", identifierType: row.identifier_type, normalizedValue: row.normalized_value };
}

/**
 * External-provider lookup (phase instruction §3/§30) — the caller is
 * responsible for only invoking this for a check-digit-valid GS1 code
 * (see lookupProductByIdentifier below); this function itself does not
 * re-derive that eligibility, since it has no business-context to derive
 * it from and is deliberately kept provider-agnostic and stateless.
 */
export async function lookupExternalProductByIdentifier(
  identifierType: string,
  normalizedValue: string
): Promise<LookupResult> {
  try {
    const candidate = await withLookupCache(provider.name, normalizedValue, () => {
      const controller = new AbortController();
      return provider.lookupByIdentifier(normalizedValue, controller.signal);
    });

    if (!candidate) {
      return { state: "NOT_FOUND", identifierType, normalizedValue };
    }
    return { state: "EXTERNAL_MATCH", identifierType, normalizedValue, candidate };
  } catch (err) {
    const errorCode =
      err instanceof ProductLookupProviderError
        ? err.code
        : PROVIDER_ERROR_CODE.PRODUCT_LOOKUP_PROVIDER_UNAVAILABLE;
    return { state: "PROVIDER_ERROR", identifierType, normalizedValue, errorCode };
  }
}

/**
 * The single entry point the UI actually calls (phase instruction §1):
 * local catalog first; the external provider only when the local lookup
 * genuinely misses AND the caller holds create/edit authority AND the
 * code is a validated GS1 barcode. Re-checks products.view itself,
 * independent of the local RPC's own identical check (defense in depth,
 * matching every other Server Action in this codebase).
 */
export async function lookupProductByIdentifier(
  businessId: string,
  rawValue: string
): Promise<LookupResult> {
  await requireUser();

  if (!businessId) {
    return { state: "INVALID", identifierType: "OTHER", normalizedValue: "" };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.PRODUCTS_VIEW)) {
    return { state: "INVALID", identifierType: "OTHER", normalizedValue: "" };
  }

  const local = await lookupLocalProductByIdentifier(businessId, rawValue);
  if (local.state !== "NOT_FOUND") {
    return local;
  }

  if (!permissions.has(PERMISSION.PRODUCTS_MANAGE) || !GTIN_FAMILY.has(local.identifierType)) {
    return local;
  }

  return lookupExternalProductByIdentifier(local.identifierType, local.normalizedValue);
}
