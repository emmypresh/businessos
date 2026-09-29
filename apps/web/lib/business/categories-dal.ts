import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";

export type BusinessCategory = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
};

const CATEGORY_SELECT = "id, code, name, description, is_active, sort_order";

// Phase 1Q-A. business_categories_select (RLS) grants `authenticated`
// read access to the FULL registry (active and inactive) — this function
// mirrors that and applies no additional filter, so callers rendering an
// existing business's (possibly since-deactivated) category can still
// resolve its label. Callers building a SELECTABLE picker for onboarding
// or Settings must filter to `is_active` themselves (see
// listActiveBusinessCategories below) — this separation matches phase
// instruction §31 ("inactive categories should not be selectable for new
// changes" vs. "existing business ... should retain its value").
export const listBusinessCategories = cache(async (): Promise<BusinessCategory[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_categories")
    .select(CATEGORY_SELECT)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(`Failed to load business categories: ${error.message}`);
  }

  return (data ?? []) as BusinessCategory[];
});

// The set a picker (onboarding, Settings) actually renders as choosable
// options — active rows only, in display order.
export const listActiveBusinessCategories = cache(async (): Promise<BusinessCategory[]> => {
  const categories = await listBusinessCategories();
  return categories.filter((category) => category.is_active);
});

// Fail-safe label resolution for checklist item 32 ("app must fail
// gracefully if a category code/record is unexpected ... never crash
// rendering"): an id with no matching row (a category the caller's
// deployed registry snapshot doesn't know about, or a future edge case)
// renders as "Unknown category" rather than throwing.
export async function getBusinessCategoryLabel(categoryId: string | null): Promise<string | null> {
  if (!categoryId) {
    return null;
  }
  const categories = await listBusinessCategories();
  const match = categories.find((category) => category.id === categoryId);
  return match?.name ?? "Unknown category";
}
