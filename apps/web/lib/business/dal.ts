import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { MEMBERSHIP_STATUS } from "./constants";

const MEMBERSHIP_SELECT =
  "id, business_id, status, role_id, roles(name), businesses(id, name, slug, status)";

export type MembershipRow = {
  id: string;
  business_id: string;
  status: string;
  role_id: string;
  roles: { name: string } | null;
  businesses: {
    id: string;
    name: string;
    slug: string;
    status: string;
  } | null;
};

// Ordered by created_at ascending so "which business does a multi-membership
// user land on" (root page routing) is a deterministic, documented rule —
// the earliest business the user joined — never an arbitrary unordered row
// from Postgres.
export const listMemberships = cache(async (): Promise<MembershipRow[]> => {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_members")
    .select(MEMBERSHIP_SELECT + ", created_at")
    .eq("user_id", user.id)
    .eq("status", MEMBERSHIP_STATUS.ACTIVE)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load business memberships: ${error.message}`);
  }

  return (data ?? []) as unknown as MembershipRow[];
});

// The full check, in one query: current user (requireUser -> getUser()),
// requested businessId (the parameter, taken from the route but never
// trusted on its own), a matching business_members row, and that row's
// status — all four conditions land here, not split across layers that
// could disagree.
export const getBusinessMembership = cache(
  async (businessId: string): Promise<MembershipRow> => {
    const user = await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("business_members")
      .select(MEMBERSHIP_SELECT)
      .eq("business_id", businessId)
      .eq("user_id", user.id)
      .eq("status", MEMBERSHIP_STATUS.ACTIVE)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to verify business membership: ${error.message}`);
    }

    if (!data) {
      notFound();
    }

    return data as unknown as MembershipRow;
  }
);
