"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import {
  CreateExpenseSchema,
  VoidExpenseSchema,
  CreateExpenseCategorySchema,
  UpdateExpenseCategorySchema,
  IdSchema,
} from "@/lib/validation/expenses";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

const MALFORMED_REQUEST: ActionState = {
  error: "Something went wrong. Please try again.",
};

// Extracts a required identifier field from FormData and validates it is
// a syntactically well-formed UUID — never merely "a non-empty string".
// Returns null for anything else (absent, non-string, malformed), which
// every call site below treats identically: a generic, controlled
// ActionState error, returned BEFORE any permission lookup or database
// call. A well-formed-but-foreign/nonexistent id is NOT rejected here —
// that is a separate, expected case handled by the ordinary
// tenant-scoped RLS/RPC checks further down each action.
function getValidId(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  return IdSchema.safeParse(value).success ? value : null;
}

// Every Server Action here is an independently callable mutation
// boundary — it authenticates and re-checks the specific permission it
// needs itself, on every call, regardless of what any page already
// rendered or hid. Mirrors lib/products/actions.ts/lib/sales/actions.ts
// exactly.

// Expense categories --------------------------------------------------
//
// Unlike expense creation/voiding, category create/rename/archive are
// ordinary RLS-governed writes — no RPC boundary exists for them (see
// create_expense_categories.sql's own header comment: a category has no
// bundled transactional side effect an RPC would need to protect). These
// three actions are the application's own re-derivation of that same
// authorization rule, not a substitute for it — expense_categories'
// INSERT/UPDATE policies independently re-check expenses.manage
// regardless of what happens here.

export async function createExpenseCategory(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  if (!businessId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.EXPENSES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = CreateExpenseCategorySchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // status is never included in this INSERT statement — every category
  // starts ACTIVE via its own column default, matching the INSERT grant,
  // which excludes the status column from what `authenticated` may even
  // set.
  const supabase = await createClient();
  const { error } = await supabase
    .from("expense_categories")
    .insert({ business_id: businessId, name: parsed.data.name });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  revalidatePath(`/${businessId}/expenses/categories`);
  redirect(`/${businessId}/expenses/categories`);
}

export async function updateExpenseCategory(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const categoryId = getValidId(formData, "categoryId");
  if (!businessId || !categoryId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.EXPENSES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = UpdateExpenseCategorySchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Rename only — status is never touched here (archiving is a separate,
  // dedicated action below). Scoped by BOTH id and business_id; a
  // scoped UPDATE matching zero rows is not a Postgres error, so the
  // affected rows must be counted explicitly (mirrors updateCustomer's
  // own treatment exactly) to tell "matched nothing" (forged/foreign
  // categoryId) apart from a genuine update.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("expense_categories")
    .update({ name: parsed.data.name })
    .eq("id", categoryId)
    .eq("business_id", businessId)
    .select("id");

  if (error) {
    return toActionState(mapDatabaseError(error));
  }
  if (data.length === 0) {
    return { error: "This category is unavailable. It may have been removed or you may not have access to it." };
  }

  revalidatePath(`/${businessId}/expenses/categories`);
  redirect(`/${businessId}/expenses/categories`);
}

export async function archiveExpenseCategory(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const categoryId = getValidId(formData, "categoryId");
  if (!businessId || !categoryId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.EXPENSES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  // Hardcoded target status — never accepts a caller-supplied status
  // value (there is no "un-archive" action; a category can only ever
  // move ACTIVE -> ARCHIVED through this action). Zero-row match (forged/
  // foreign/already-archived-but-nonexistent categoryId) is handled
  // exactly like updateExpenseCategory above.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("expense_categories")
    .update({ status: "ARCHIVED" })
    .eq("id", categoryId)
    .eq("business_id", businessId)
    .select("id");

  if (error) {
    return toActionState(mapDatabaseError(error));
  }
  if (data.length === 0) {
    return { error: "This category is unavailable. It may have been removed or you may not have access to it." };
  }

  revalidatePath(`/${businessId}/expenses/categories`);
  redirect(`/${businessId}/expenses/categories`);
}

// Expenses --------------------------------------------------------------

export async function createExpense(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  // Codex adversarial review, Finding 3 (2nd pass): BOTH mutation
  // identifiers this action needs — businessId AND categoryId — are
  // extracted and UUID-validated here, BEFORE getPermissions() and
  // before any database/RPC access. Previously categoryId was only
  // validated later, inside CreateExpenseSchema, which ran AFTER the
  // permission lookup — a malformed categoryId still never reached the
  // RPC, but it caused a permission lookup to happen for no reason.
  // Mirrors updateExpenseCategory/archiveExpenseCategory/voidExpense's
  // own ordering exactly (all four already validated every identifier
  // up front — this was the one action that didn't).
  const businessId = getValidId(formData, "businessId");
  const categoryId = getValidId(formData, "categoryId");
  if (!businessId || !categoryId) {
    return MALFORMED_REQUEST;
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.EXPENSES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  // categoryId is passed through already-validated, and re-checked here
  // too (CreateExpenseSchema's own z.uuid()) — belt and suspenders, never
  // weakened; every OTHER field (amount, paymentMethod, incurredAt,
  // payee, reference, notes) is validated here for the first time.
  const parsed = CreateExpenseSchema.safeParse({
    creationKey: formData.get("creationKey"),
    categoryId,
    amount: formData.get("amount"),
    paymentMethod: formData.get("paymentMethod"),
    incurredAt: formData.get("incurredAt"),
    payee: formData.get("payee") || undefined,
    reference: formData.get("reference") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Explicit RPC argument construction: ONLY the approved logical inputs
  // are ever sent — never expense_number, category_name_snapshot,
  // currency_code, status, created_by, or created_at. The database owns
  // every one of those; there is no field here for a forged value to even
  // populate.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_expense", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_category_id: parsed.data.categoryId,
    p_amount: parsed.data.amount,
    p_payment_method: parsed.data.paymentMethod,
    p_incurred_at: parsed.data.incurredAt,
    p_payee: parsed.data.payee,
    p_reference: parsed.data.reference,
    p_notes: parsed.data.notes,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // create_expense returns a bare uuid — `data` IS the expense id itself,
  // never a row/object to accidentally spread or forward.
  const expenseId = data;

  revalidatePath(`/${businessId}/expenses`);

  // expenses.manage does NOT imply expenses.view — a caller who can
  // record an expense but not view one must never be redirected to a
  // route that independently requires expenses.view (that route would
  // just 404 them). Checked against the SAME `permissions` set already
  // fetched above — never inferred from expenses.manage having
  // succeeded. Mirrors createSale's own manage-without-view redirect
  // exactly (Phase 1D correction this mirrors, per the approved plan).
  if (permissions.has(PERMISSION.EXPENSES_VIEW)) {
    redirect(`/${businessId}/expenses/${expenseId}`);
  }
  redirect(`/${businessId}/expenses/new?created=1`);
}

export async function voidExpense(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = getValidId(formData, "businessId");
  const expenseId = getValidId(formData, "expenseId");
  if (!businessId || !expenseId) {
    return MALFORMED_REQUEST;
  }

  // Independently re-checked here, regardless of whether the caller
  // reached this action through the detail page's void button (which
  // itself requires expenses.view to even be reachable) or called it
  // directly with a known expense id. A caller with expenses.view only —
  // no expenses.manage — must not be able to void via direct action
  // invocation either.
  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.EXPENSES_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = VoidExpenseSchema.safeParse({ reason: formData.get("reason") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("void_expense", {
    p_business_id: businessId,
    p_expense_id: expenseId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // void_expense returns a bare uuid — `data` IS the expense id itself.
  const voidedId = data;

  revalidatePath(`/${businessId}/expenses`);
  revalidatePath(`/${businessId}/expenses/${voidedId}`);

  if (permissions.has(PERMISSION.EXPENSES_VIEW)) {
    redirect(`/${businessId}/expenses/${voidedId}`);
  }
  // A manage-only caller (no expenses.view) cannot reach the detail page
  // at all — redirect to the same generic, accessible success surface
  // createExpense uses for that caller, never to a route that would just
  // 404 them.
  redirect(`/${businessId}/expenses/new?voided=1`);
}
