import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import {
  PLATFORM_BUSINESS_DEFAULT_PAGE_SIZE,
  PLATFORM_BUSINESS_MAX_PAGE_SIZE,
  type PlatformBusinessQuery,
} from "@/lib/validation/platform-businesses";

// Every field here is exactly what public.list_platform_businesses returns
// (supabase/migrations/20260929080000_platform_business_directory.sql) —
// never a broader shape. The RPC itself is the actual authorization
// boundary (platform.businesses.view + AAL2, re-verified at the database
// layer independent of this DAL or the route guard above it); this module
// only shapes the call and its result for the page/components.
export type PlatformBusinessRow = {
  business_id: string;
  business_name: string;
  slug: string;
  status: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  created_at: string;
  owner_email: string | null;
  plan_code: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  branch_count: number;
  active_branch_count: number;
  member_count: number;
  total_count: number;
};

export type PlatformBusinessDetail = {
  business_id: string;
  business_name: string;
  slug: string;
  status: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  created_at: string;
  owner_email: string | null;
  subscription: {
    plan_code: string;
    plan_name: string;
    status: string;
    trial_ends_at: string | null;
    current_period_ends_at: string | null;
    cancel_at_period_end: boolean;
  } | null;
  branch_count: number;
  active_branch_count: number;
  member_count: number;
  branches: Array<{
    branch_id: string;
    name: string;
    code: string | null;
    status: string;
    created_at: string;
  }>;
  members: Array<{
    email: string | null;
    role: string;
    status: string;
    primary_branch_name: string | null;
  }>;
};

/**
 * Lists platform businesses for the internal directory. Deliberately NOT
 * wrapped in React `cache()` on its own — the query's identity depends on
 * every filter/sort/page argument together, so the page passes the fully
 * resolved query object and this function is called at most once per
 * render with that exact shape (see app/internal/admin/businesses/page.tsx).
 */
export async function listPlatformBusinesses(
  query: PlatformBusinessQuery
): Promise<{ rows: PlatformBusinessRow[]; totalCount: number; pageSize: number }> {
  await requireUser();
  const supabase = await createClient();

  const pageSize = PLATFORM_BUSINESS_DEFAULT_PAGE_SIZE;
  const boundedPage = Math.min(query.page, Math.ceil(Number.MAX_SAFE_INTEGER / pageSize));

  const { data, error } = await supabase.rpc("list_platform_businesses", {
    p_search: query.q ?? undefined,
    p_country_code: query.country ?? undefined,
    p_currency_code: query.currency ?? undefined,
    p_plan_code: query.plan ?? undefined,
    p_subscription_status: query.status ?? undefined,
    p_sort: query.sort,
    p_dir: query.dir,
    p_page: boundedPage,
    p_page_size: Math.min(pageSize, PLATFORM_BUSINESS_MAX_PAGE_SIZE),
  });

  if (error) {
    throw new Error(`Failed to load platform business directory: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PlatformBusinessRow[];
  const totalCount = rows[0]?.total_count ?? 0;

  return { rows, totalCount, pageSize };
}

export const getPlatformBusinessDetail = cache(
  async (businessId: string): Promise<PlatformBusinessDetail> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_platform_business_detail", {
      p_business_id: businessId,
    });

    if (error) {
      throw new Error(`Failed to load business detail: ${error.message}`);
    }
    if (!data) {
      notFound();
    }

    return data as unknown as PlatformBusinessDetail;
  }
);
