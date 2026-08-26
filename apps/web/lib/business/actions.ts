"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { CreateBusinessSchema } from "@/lib/validation/business";
import type { ActionState } from "@/lib/auth/actions";

export async function createBusiness(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireUser();

  const parsed = CreateBusinessSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();

  // The ONLY authorized write path into public.businesses — a direct
  // table insert against that table is never used by application code.
  // See the Existing Contract in the plan for why (no INSERT grant/policy
  // exists for `authenticated` on that table at all).
  const { data, error } = await supabase.rpc("create_business", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
  });

  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { slug: ["This slug is already taken."] } };
    }
    return { error: "Could not create your business. Please try again." };
  }

  redirect(`/${data.id}`);
}
