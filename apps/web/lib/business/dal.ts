import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { MEMBERSHIP_STATUS, type PermissionKey } from "./constants";

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

type RolePermissionsEmbed = {
  role_permissions: { permissions: { key: string } | null }[] | null;
} | null;

// One round trip per request (React `cache()` dedupes repeated calls
// within the same render), via the same 3-hop PostgREST embed
// (business_members -> roles -> role_permissions -> permissions)
// getBusinessMembership already relies on for `roles(name)` — a
// SEPARATE cached call, not a modification of that function's existing
// shape, so nothing already shipped (dashboard shell, members page)
// is affected by this addition.
//
// An absent/inactive membership yields an empty Set, never a thrown
// error — every call site checks `.has(...)`, and an empty set simply
// means "no permissions," which is the correct, fail-closed answer for
// a business the caller doesn't actively belong to.
export const getPermissions = cache(
  async (businessId: string): Promise<Set<PermissionKey>> => {
    const user = await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("business_members")
      .select("roles(role_permissions(permissions(key)))")
      .eq("business_id", businessId)
      .eq("user_id", user.id)
      .eq("status", MEMBERSHIP_STATUS.ACTIVE)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load permissions: ${error.message}`);
    }

    const roles = (data as unknown as { roles: RolePermissionsEmbed })?.roles;
    const rolePermissions = roles?.role_permissions ?? [];
    const keys = rolePermissions
      .map((rp) => rp.permissions?.key)
      .filter((key): key is string => Boolean(key));

    return new Set(keys as PermissionKey[]);
  }
);

export async function hasPermission(
  businessId: string,
  permission: PermissionKey
): Promise<boolean> {
  const permissions = await getPermissions(businessId);
  return permissions.has(permission);
}

// For Server Components (pages): a missing `.view`-class permission
// renders identically to a nonexistent route — never a distinguishable
// "access denied" page, matching getBusinessMembership's own fail-closed
// convention. Server Actions must NOT use this (a thrown notFound()
// inside a Server Action is not the desired UX) — they call
// getPermissions()/hasPermission() directly and return a structured
// ActionState error instead (see lib/products/actions.ts, lib/inventory/actions.ts).
export async function requirePermissionOrNotFound(
  businessId: string,
  permission: PermissionKey
): Promise<Set<PermissionKey>> {
  const permissions = await getPermissions(businessId);
  if (!permissions.has(permission)) {
    notFound();
  }
  return permissions;
}
