"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { CreateBusinessSchema, UpdateBusinessTimezoneSchema } from "@/lib/validation/business";
import { getDefaultCurrencyForCountry, isFullyOperationalCountry } from "@/lib/business/country-currency";
import { isTimezoneValidForCountry } from "@/lib/business/timezone-catalog";
import { hasPermission } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import type { ActionState } from "@/lib/auth/actions";

export async function createBusiness(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const parsed = CreateBusinessSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    countryCode: formData.get("countryCode"),
    timezone: formData.get("timezone"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Phase 1Q-0B non-NGN activation gate. This is the actual server
  // boundary — enforced here, before create_business is ever called, not
  // merely a disabled submit button in the form (which a client can
  // trivially bypass by posting the form data directly). Country
  // selection and its derived currency/timezone are still visible and
  // confirmed during onboarding (see CreateBusinessForm), but no
  // non-Nigerian tenant is created while expenses/invoices/reporting
  // remain NGN-oriented (see the phase brief's Non-NGN Activation Gate
  // section). No new "status" field/model is introduced for this — it is
  // a pure pre-creation rejection, never a partially-created business.
  if (!isFullyOperationalCountry(parsed.data.countryCode)) {
    return {
      error:
        "BusinessOS currently supports full accounting operations in Nigerian Naira. Support for other countries is being completed.",
    };
  }

  // Currency is never accepted from the client (see CreateBusinessSchema's
  // own header comment) — always derived server-side from the validated,
  // catalog-member countryCode. getDefaultCurrencyForCountry cannot
  // return undefined here: countryCode already passed
  // isSupportedCountryCode via the schema's own refine.
  const currencyCode = getDefaultCurrencyForCountry(parsed.data.countryCode);

  const supabase = await createClient();

  // The ONLY authorized write path into public.businesses — a direct
  // table insert against that table is never used by application code.
  // See the Existing Contract in the plan for why (no INSERT grant/policy
  // exists for `authenticated` on that table at all).
  const { data, error } = await supabase.rpc("create_business", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_country_code: parsed.data.countryCode,
    p_currency_code: currencyCode,
    p_timezone: parsed.data.timezone,
  });

  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { slug: ["This slug is already taken."] } };
    }
    return { error: "Could not create your business. Please try again." };
  }

  redirect(`/${data.id}`);
}

// Phase 1Q-0B. The one business field this phase makes editable post-
// creation (country/currency are read-only — see the phase brief's
// Country/Currency Editability sections). Re-checks business.manage
// itself (never trusts the Settings page's own conditional rendering as
// the security boundary), matches every other Server Action in this
// codebase's own established convention (lib/billing/actions.ts,
// lib/products/actions.ts).
export async function updateBusinessTimezone(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  // businessId is read from the form itself (a hidden field), matching
  // this codebase's own established convention for Server Actions used
  // with useActionState on a business-scoped settings page (see
  // components/whatsapp/whatsapp-connection-controls.tsx) — never trusted
  // from route context the client could otherwise spoof, since the
  // permission check and update below are both re-scoped to whatever
  // businessId is supplied here.
  const businessId = formData.get("businessId");
  if (typeof businessId !== "string" || businessId.length === 0) {
    return { error: "Missing business." };
  }

  if (!(await hasPermission(businessId, PERMISSION.BUSINESS_MANAGE))) {
    return { error: "You do not have permission to change this business's settings." };
  }

  const parsed = UpdateBusinessTimezoneSchema.safeParse({
    timezone: formData.get("timezone"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();

  // The business's own country_code is read from the database, never
  // trusted from any client-supplied value — a caller cannot smuggle in a
  // different country to unlock a wider timezone set than the business
  // actually has.
  const { data: business, error: readError } = await supabase
    .from("businesses")
    .select("country_code")
    .eq("id", businessId)
    .single();
  if (readError || !business) {
    return { error: "Could not load this business." };
  }

  if (!isTimezoneValidForCountry(business.country_code, parsed.data.timezone)) {
    return { fieldErrors: { timezone: ["Select a timezone supported for this business's country."] } };
  }

  // businesses_update RLS policy (business.manage) + the column-scoped
  // `grant update (timezone)` are the actual enforcement boundary —
  // see supabase/migrations/20260923090000_business_timezone.sql. This
  // update is scoped to businessId via .eq, matching every other
  // business-scoped mutation in this codebase.
  const { error: updateError } = await supabase
    .from("businesses")
    .update({ timezone: parsed.data.timezone })
    .eq("id", businessId);

  if (updateError) {
    return { error: "Could not update the timezone. Please try again." };
  }

  return { success: true };
}
