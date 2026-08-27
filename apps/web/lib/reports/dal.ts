import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { mapDatabaseError } from "@/lib/errors";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Mirrors get_financial_summary's exact returned field set
 * (supabase/migrations/20260827080600_get_financial_summary_rpc.sql) —
 * currency_code, gross_sales, cash_collected, outstanding_sales,
 * expenses, net_cash_flow, sales_count, expense_count. Deliberately has
 * no profit/margin/COGS field: none exists on the RPC's return shape, and
 * none is ever computed here from the fields that do.
 */
export type FinancialSummary = {
  currencyCode: string;
  grossSales: number;
  cashCollected: number;
  outstandingSales: number;
  expenses: number;
  netCashFlow: number;
  salesCount: number;
  expenseCount: number;
};

/**
 * Defensively narrows get_financial_summary's jsonb return shape —
 * mirrors lib/inventory/cost.ts's parseCostValue precedent: every field
 * is individually type-checked, never a bare cast. A malformed shape
 * (which should never happen against the frozen, approved RPC contract)
 * fails loudly rather than silently rendering a fabricated zero-value
 * summary that could be mistaken for a genuine "no activity" result.
 */
function parseFinancialSummary(value: Json): FinancialSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error("parseFinancialSummary: unexpected get_financial_summary return shape", value);
    throw new Error("Failed to load financial summary: unexpected response shape.");
  }
  const row = value as Record<string, Json>;

  function num(key: string): number {
    const v = row[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      console.error(`parseFinancialSummary: field "${key}" is not a finite number`, v);
      throw new Error("Failed to load financial summary: unexpected response shape.");
    }
    return v;
  }
  function str(key: string): string {
    const v = row[key];
    if (typeof v !== "string") {
      console.error(`parseFinancialSummary: field "${key}" is not a string`, v);
      throw new Error("Failed to load financial summary: unexpected response shape.");
    }
    return v;
  }

  return {
    currencyCode: str("currency_code"),
    grossSales: num("gross_sales"),
    cashCollected: num("cash_collected"),
    outstandingSales: num("outstanding_sales"),
    expenses: num("expenses"),
    netCashFlow: num("net_cash_flow"),
    salesCount: num("sales_count"),
    expenseCount: num("expense_count"),
  };
}

// Permission (reports.view) is checked at the page layer
// (requirePermissionOrNotFound), matching every other DAL function's own
// convention — this function itself does not gate on it, but the RPC it
// calls independently re-checks reports.view server-side regardless
// (defense in depth, not this function's job to duplicate).
//
// Deliberately the ONLY function the /reports route ever calls to render
// the overview — never listSales/listExpenses. get_financial_summary runs
// under its own BYPASSRLS reader role specifically so a caller holding
// reports.view without sales.view/expenses.view still gets the real
// aggregate; this DAL function preserves that by never falling back to a
// raw sales/expenses query.
export const getFinancialSummary = cache(
  async (businessId: string, from: string, to: string): Promise<FinancialSummary> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_financial_summary", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
    });

    if (error) {
      // Routed through the same safe error-mapping architecture every
      // Server Action already uses (lib/errors.ts) — INVALID_REPORT_RANGE
      // and REPORT_AMOUNT_OUT_OF_RANGE resolve to their stable, controlled
      // messages; anything else (including insufficient_privilege, which
      // should never occur here since the page independently requires
      // reports.view first) falls back to the generic message. The raw
      // Postgres `error.message` — SQLSTATE, constraint names, function
      // context — is never interpolated into what this function throws.
      throw new Error(mapDatabaseError(error).message);
    }

    return parseFinancialSummary(data);
  }
);
