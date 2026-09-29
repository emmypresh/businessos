import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getAssuranceLevel } from "@/lib/auth/dal";
import { PLATFORM_PERMISSION, type PlatformPermissionKey, type PlatformRole } from "./constants";

// Every route under /internal/admin — the gated console AND the MFA
// challenge page itself — must reach this route tree only as an active
// platform admin. This is the ordering primitive requirePlatformPermission
// builds on: it deliberately says nothing about AAL, so
// app/internal/admin/mfa/page.tsx can reuse it (via the layout) without
// looping — a tenant user hitting /internal/admin/mfa gets exactly the
// same notFound() a non-admin gets anywhere else under this tree, never a
// glimpse of an MFA challenge form (see the phase brief's no-enumeration
// requirement).

// The platform authorization boundary. Every check here ultimately reaches
// public.has_platform_permission / public.get_my_platform_role (see
// supabase/migrations/20260928080000_platform_admin_security_foundation.sql),
// which derive identity from the server-verified JWT (private.current_uid())
// inside a SECURITY DEFINER function — never from this module accepting or
// forwarding a user id, and never from any tenant business_members/roles
// state. requireUser() itself uses getUser() (a live Auth-server round
// trip), matching lib/auth/dal.ts's own authoritative-check convention, not
// the proxy's optimistic getClaims() check.

// Cached per-request: the internal admin layout and page both need the
// current role, and this ensures a single round trip regardless of how many
// call sites ask.
export const getPlatformRole = cache(async (): Promise<PlatformRole | null> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_my_platform_role");
  if (error) {
    throw new Error(`Failed to resolve platform role: ${error.message}`);
  }

  return (data as PlatformRole | null) ?? null;
});

// Not cached by permission key (unlike getPermissions' single bulk query on
// the tenant side): 1O-A's platform-permission surface is small enough that
// one has_platform_permission RPC call per distinct permission checked in a
// render is an acceptable tradeoff against a bespoke bulk-fetch RPC. A
// future phase with heavier platform UI can add one if this becomes a real
// cost.
export async function hasPlatformPermission(
  permission: PlatformPermissionKey
): Promise<boolean> {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("has_platform_permission", {
    p_permission_key: permission,
  });
  if (error) {
    throw new Error(`Failed to resolve platform permission: ${error.message}`);
  }

  return Boolean(data);
}

// Display-only, for the internal admin overview screen: which of the
// current, fixed 1O-A permission keys the caller actually holds. Never
// used as an authorization decision itself — every page/layout gate calls
// requirePlatformPermission directly, independent of this list.
export const getMyPlatformPermissions = cache(
  async (): Promise<PlatformPermissionKey[]> => {
    const allKeys = Object.values(PLATFORM_PERMISSION);
    const results = await Promise.all(
      allKeys.map(async (key) => [key, await hasPlatformPermission(key)] as const)
    );
    return results.filter(([, allowed]) => allowed).map(([key]) => key);
  }
);

// The "is this caller a platform admin at all" gate, independent of AAL
// and of any specific permission — role/is_active only, via the same
// SECURITY DEFINER get_my_platform_role() every other check here already
// uses. Applied by app/internal/admin/layout.tsx to the whole route tree
// (console pages and the MFA challenge page alike), so a tenant user never
// reaches either surface.
export async function requirePlatformAdmin(): Promise<void> {
  const role = await getPlatformRole();
  if (!role) {
    notFound();
  }
}

// The reusable platform authorization guard. Order matters and is
// deliberate:
//
//   1. identity  (getPlatformRole -> requireUser(): redirect to /login if
//      signed out)
//   2. is this caller a platform admin at all (requirePlatformAdmin):
//      false denies as a generic 404 — same as any nonexistent route —
//      before AAL is even considered, so a tenant user is never sent
//      through the internal-admin MFA flow merely for visiting this tree.
//   3. session assurance level: an active platform admin authenticated
//      only at AAL1 is redirected to the MFA challenge route rather than
//      denied outright — they ARE legitimate, they just haven't elevated
//      yet. An admin with no enrolled MFA factor lands on the same
//      redirect; the challenge page itself decides whether to show a
//      challenge or an enrollment prompt, and never renders privileged
//      content at AAL1 either way (fail closed — see that page).
//   4. the specific platform permission requested, via
//      has_platform_permission — which independently re-verifies AAL2 at
//      the database layer (see the migration), so this check is not the
//      only place AAL2 is enforced.
//
// A missing permission — "not a platform admin", "platform admin but
// is_active = false", or "active admin lacking this specific permission" —
// all collapse to the same notFound(), matching
// requirePermissionOrNotFound's own fail-closed convention on the tenant
// side. This deliberately never reveals that /internal/admin exists to a
// caller who lacks access, and never renders privileged content to a
// caller who hasn't proven AAL2, regardless of role.
export async function requirePlatformPermission(
  permission: PlatformPermissionKey
): Promise<void> {
  await requirePlatformAdmin();

  const aal = await getAssuranceLevel();
  if (aal !== "aal2") {
    redirect("/internal/admin/mfa");
  }

  const allowed = await hasPlatformPermission(permission);
  if (!allowed) {
    notFound();
  }
}

// Phase 1O-D remediation — the OR-permission variant of
// requirePlatformPermission above, for a route that must admit a caller
// holding ANY ONE of several permissions rather than one specific
// permission. Introduced because BILLING holds
// platform.subscriptions.extend_trial but not platform.businesses.view,
// and the only pre-existing Platform Actions surface lived behind a page
// shell gated on the latter — BILLING had no route that would ever admit
// it despite holding a permission it should be able to exercise. This
// helper is the single centralized fix (never duplicated per-route): same
// ordering as requirePlatformPermission (admin -> AAL2 -> permission), same
// fail-closed default (notFound() unless at least one permission matches),
// and no tenant-role fallback of any kind. Route ADMISSION here is
// deliberately not a substitute for per-mutation authorization — each
// mutation RPC (platform_suspend_business/platform_reactivate_business/
// platform_extend_trial) independently re-checks its own single, exact
// permission regardless of how the caller reached the page.
export async function requireAnyPlatformPermission(
  permissions: PlatformPermissionKey[]
): Promise<void> {
  await requirePlatformAdmin();

  const aal = await getAssuranceLevel();
  if (aal !== "aal2") {
    redirect("/internal/admin/mfa");
  }

  const results = await Promise.all(permissions.map((permission) => hasPlatformPermission(permission)));
  if (!results.some(Boolean)) {
    notFound();
  }
}
