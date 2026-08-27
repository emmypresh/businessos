"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { getPermissions } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { CreateCustomerSchema, UpdateCustomerSchema } from "@/lib/validation/customers";
import { mapDatabaseError, toActionState } from "@/lib/errors";
import type { ActionState } from "@/lib/auth/actions";

const PERMISSION_DENIED: ActionState = {
  error: "You don't have permission to do this.",
};

// Every Server Action here is an independently callable mutation
// boundary — it authenticates and re-checks the specific permission it
// needs itself, on every call, regardless of what any page already
// rendered or hid. Mirrors lib/products/actions.ts exactly.
export async function createCustomer(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || !businessId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.CUSTOMERS_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = CreateCustomerSchema.safeParse({
    creationKey: formData.get("creationKey"),
    name: formData.get("name"),
    phone: formData.get("phone") || undefined,
    email: formData.get("email") || undefined,
    address: formData.get("address") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_customer", {
    p_business_id: businessId,
    p_creation_key: parsed.data.creationKey,
    p_name: parsed.data.name,
    p_phone: parsed.data.phone,
    p_email: parsed.data.email,
    p_address: parsed.data.address,
    p_notes: parsed.data.notes,
  });

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // create_customer returns a bare uuid — `data` IS the customer id
  // itself, never a row/object to accidentally spread or forward.
  const customerId = data;

  revalidatePath(`/${businessId}/customers`);
  redirect(`/${businessId}/customers/${customerId}`);
}

export async function updateCustomer(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const businessId = formData.get("businessId");
  const customerId = formData.get("customerId");
  if (typeof businessId !== "string" || !businessId || typeof customerId !== "string" || !customerId) {
    return { error: "Something went wrong. Please try again." };
  }

  const permissions = await getPermissions(businessId);
  if (!permissions.has(PERMISSION.CUSTOMERS_MANAGE)) {
    return PERMISSION_DENIED;
  }

  const parsed = UpdateCustomerSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone") || undefined,
    email: formData.get("email") || undefined,
    address: formData.get("address") || undefined,
    notes: formData.get("notes") || undefined,
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Ordinary RLS-governed UPDATE — customer edits have no bundled
  // transactional side effect, matching the approved database contract
  // exactly. Scoped by BOTH id and business_id; only the explicit
  // mutable columns are ever included — never business_id, created_by,
  // created_at, or id.
  //
  // Supabase/PostgREST treats a zero-row UPDATE (forged/foreign/random
  // customerId, still correctly excluded by the .eq() scoping) as a
  // successful query — `error` stays null either way. `.select("id")`
  // (narrowest possible column — never the full row) turns the affected
  // rows into data we can actually count, so a zero-row match can be
  // told apart from a genuine one-row update instead of redirecting as
  // if it had succeeded.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .update({
      name: parsed.data.name,
      phone: parsed.data.phone ?? null,
      email: parsed.data.email ?? null,
      address: parsed.data.address ?? null,
      notes: parsed.data.notes ?? null,
      status: parsed.data.status,
    })
    .eq("id", customerId)
    .eq("business_id", businessId)
    .select("id");

  if (error) {
    return toActionState(mapDatabaseError(error));
  }

  // Zero rows means nothing in this business matched that id — never
  // distinguished from "exists in another business" or "never existed"
  // by the message, since either would leak cross-tenant information.
  if (data.length === 0) {
    return { error: "This customer is unavailable. It may have been removed or you may not have access to it." };
  }

  revalidatePath(`/${businessId}/customers`);
  revalidatePath(`/${businessId}/customers/${customerId}`);
  redirect(`/${businessId}/customers/${customerId}`);
}
