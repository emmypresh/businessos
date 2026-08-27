// Shared fixtures for Phase 1E (expenses + financial overview) integration
// tests. Mirrors tests/integration/helpers/sales.ts's pattern exactly.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { randomUuid } from "./inventory";

type Client = SupabaseClient<Database>;

/** Fetches the id of one of the ten seeded default categories by name. */
export async function getDefaultCategoryId(client: Client, businessId: string, name = "Rent") {
  const { data, error } = await client
    .from("expense_categories")
    .select("id")
    .eq("business_id", businessId)
    .eq("name", name)
    .single();
  if (error || !data) throw new Error(`default category "${name}" not found: ${error?.message}`);
  return data.id as string;
}

export async function makeExpenseCategory(
  client: Client,
  businessId: string,
  overrides: { name?: string; status?: "ACTIVE" | "ARCHIVED" } = {}
) {
  const { data, error } = await client
    .from("expense_categories")
    .insert({ business_id: businessId, name: overrides.name ?? `Category ${randomUuid()}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`expense_categories insert failed: ${error?.message}`);
  if (overrides.status && overrides.status !== "ACTIVE") {
    const { error: updateErr } = await client
      .from("expense_categories")
      .update({ status: overrides.status })
      .eq("id", data.id);
    if (updateErr) throw new Error(`expense_categories status update failed: ${updateErr.message}`);
  }
  return data.id as string;
}

export function expensePayload(
  businessId: string,
  categoryId: string,
  overrides: {
    creationKey?: string;
    amount?: number;
    paymentMethod?: string;
    incurredAt?: string;
    payee?: string;
    reference?: string;
    notes?: string;
  } = {}
) {
  return {
    p_business_id: businessId,
    p_creation_key: overrides.creationKey ?? randomUuid(),
    p_category_id: categoryId,
    p_amount: overrides.amount ?? 1000,
    p_payment_method: overrides.paymentMethod ?? "CASH",
    p_incurred_at: overrides.incurredAt ?? new Date().toISOString(),
    p_payee: overrides.payee,
    p_reference: overrides.reference,
    p_notes: overrides.notes,
  };
}

export async function makeExpense(
  client: Client,
  businessId: string,
  categoryId: string,
  overrides: Parameters<typeof expensePayload>[2] = {}
) {
  const { data, error } = await client.rpc("create_expense", expensePayload(businessId, categoryId, overrides));
  if (error || !data) throw new Error(`create_expense failed: ${error?.message}`);
  return data as string;
}
