import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { hasPermission } from "@/lib/business/dal";
import { PERMISSION, type MembershipStatus, type RoleName } from "@/lib/business/constants";

// Mirrors lib/branches/dal.ts's/lib/expenses/dal.ts's own UUID_PATTERN
// convention exactly — see getBranch's own comment for the full
// reasoning.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * IMPORTANT — no staff email/display name anywhere in this file, by
 * design, not oversight: public.business_members carries only `user_id`
 * (an opaque auth.users foreign key — see database.types.ts), and
 * auth.users itself is deliberately unreachable from ordinary
 * authenticated application code (every SECURITY DEFINER function that
 * needs identity, e.g. private.current_verified_email(), stays owned by
 * `postgres` specifically because `postgres` cannot extend auth-schema
 * access to any role it creates — see business_invitation_rpcs.sql's own
 * header comment). The ONE service-role admin client this codebase has
 * (lib/auth/recovery-grant-admin-client.ts) is explicitly documented as a
 * narrow, one-caller exception — "do not reach for this to replace an
 * ordinary authenticated query anywhere else" — so it is not used here
 * either, even though it technically could resolve an email. No Phase 1F
 * migration adds a safe view/RPC for this (out of scope for this
 * application-layer round — migrations are frozen), so the honest answer
 * for this pass is: staff identity is shown as "You" for the caller's own
 * row and a role/branch-derived label for everyone else — exactly what
 * components/dashboard/members-table.tsx (Phase 1A) already does for the
 * plain members list, for the identical reason.
 */

const BRANCH_ASSIGNMENT_EMBED =
  "business_member_branches(branch_id, is_primary, business_branches(id, name, status))";

export type BranchAssignment = { branch_id: string; is_primary: boolean; branch_name: string; branch_status: string };

export type StaffMemberRow = {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  role_id: string;
  role_name: string;
  is_self: boolean;
  branches: BranchAssignment[];
};

type RawMemberRow = {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  role_id: string;
  roles: { name: string } | null;
  business_member_branches: {
    branch_id: string;
    is_primary: boolean;
    business_branches: { id: string; name: string; status: string } | null;
  }[] | null;
};

function toStaffMemberRow(row: RawMemberRow, currentUserId: string): StaffMemberRow {
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    created_at: row.created_at,
    role_id: row.role_id,
    role_name: row.roles?.name ?? "—",
    is_self: row.user_id === currentUserId,
    branches: (row.business_member_branches ?? [])
      .filter((b) => b.business_branches !== null)
      .map((b) => ({
        branch_id: b.branch_id,
        is_primary: b.is_primary,
        branch_name: b.business_branches!.name,
        branch_status: b.business_branches!.status,
      })),
  };
}

// Codex adversarial review, application-layer round 2, Low 6: unlike
// expenses/branches (where the underlying table's OWN RLS policy is
// already gated on the matching .view permission, making it the real
// technical backstop), business_members' RLS policy allows ANY currently
// active business member to read the roster — a Phase 1A design (see
// business_membership_policies.sql's own "any active member sees the
// whole roster" precedent, cited by business_member_branches' identical
// policy) that predates staff.view entirely and is broader than it.
// Every Phase 1F PAGE already re-checks staff.view before calling these
// two functions, but that leaves the DAL's own authorization entirely
// dependent on every future caller remembering to do the same — this
// makes the roster-reading functions independently enforce staff.view
// themselves, exactly like requirePermissionOrNotFound already does for
// pages. Deliberately NOT applied to listInvitations/
// listInvitationBranchOptions below — those are staff.invite-gated by
// design (both by their own RLS/RPC authorization AND intentionally
// independent of staff.view), and must stay that way.
export const listStaffMembers = cache(
  async (
    businessId: string,
    options: { role?: RoleName; status?: MembershipStatus; branchId?: string } = {}
  ): Promise<StaffMemberRow[]> => {
    const user = await requireUser();
    if (!(await hasPermission(businessId, PERMISSION.STAFF_VIEW))) {
      return [];
    }
    const supabase = await createClient();

    let roleId: string | undefined;
    if (options.role) {
      const { data: role } = await supabase.from("roles").select("id").eq("name", options.role).maybeSingle();
      // An unrecognized role name (can't happen via the validated filter
      // parser in the normal page flow, but this DAL never trusts its own
      // caller's shape either) resolves to a filter that matches nothing,
      // rather than silently ignoring the filter and returning every role.
      roleId = role?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    // The branch-assignment embed is a LEFT embed by default — a member
    // with zero branch assignments (the pre-Phase-1F OWNER row created by
    // create_business, before branch assignment even existed) must still
    // appear in the roster with an empty branches array, never be
    // silently dropped. It is only switched to an INNER embed (`!inner`)
    // when a branchId filter is actually requested — in that one case,
    // "member is not assigned to this branch at all" is exactly the
    // condition being filtered OUT, so excluding zero-assignment members
    // is the correct behavior for that specific filter, not a bug.
    const embed = options.branchId
      ? `business_member_branches!inner(branch_id, is_primary, business_branches(id, name, status))`
      : BRANCH_ASSIGNMENT_EMBED;

    let query = supabase
      .from("business_members")
      .select(`id, user_id, status, created_at, role_id, roles(name), ${embed}`)
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });

    if (roleId) {
      query = query.eq("role_id", roleId);
    }
    if (options.status) {
      query = query.eq("status", options.status);
    }
    if (options.branchId) {
      query = query.eq("business_member_branches.branch_id", options.branchId);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load staff: ${error.message}`);
    }

    return ((data ?? []) as unknown as RawMemberRow[]).map((row) => toStaffMemberRow(row, user.id));
  }
);

export const getStaffMember = cache(async (businessId: string, memberId: string): Promise<StaffMemberRow> => {
  const user = await requireUser();
  // Codex adversarial review, application-layer round 2, Low 3: a
  // malformed route identifier (e.g. /staff/not-a-uuid) must never reach
  // Postgres as a raw comparison value — mirrors lib/branches/dal.ts's
  // getBranch own guard exactly.
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(memberId)) {
    notFound();
  }
  // Low 6 — see listStaffMembers' own header comment for the full
  // reasoning. Collapsed into the same generic 404 a nonexistent memberId
  // gets below, matching this app's established non-disclosure
  // philosophy (getBranch/getExpense do the same for their own
  // .view-gated resource).
  if (!(await hasPermission(businessId, PERMISSION.STAFF_VIEW))) {
    notFound();
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_members")
    .select(`id, user_id, status, created_at, role_id, roles(name), ${BRANCH_ASSIGNMENT_EMBED}`)
    .eq("business_id", businessId)
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load staff member: ${error.message}`);
  }
  if (!data) {
    notFound();
  }

  return toStaffMemberRow(data as unknown as RawMemberRow, user.id);
});

// Invitations ---------------------------------------------------------
//
// No request-ledger fields (creation_key) are ever selected — that column
// is internal mutation-control metadata, and business_invitation_requests
// (the private ledger table itself) has no grant to `authenticated` at
// all, so it is structurally unreachable from here regardless.
const INVITATION_COLUMNS =
  "id, business_id, email, role_id, status, expires_at, invited_by, accepted_at, revoked_at, created_at";

export type InvitationRow = {
  id: string;
  business_id: string;
  email: string;
  role_id: string;
  role_name: string;
  status: string;
  expires_at: string;
  invited_by: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  branches: { branch_id: string; is_primary: boolean; branch_name: string }[];
};

type RawInvitationRow = {
  id: string;
  business_id: string;
  email: string;
  role_id: string;
  roles: { name: string } | null;
  status: string;
  expires_at: string;
  invited_by: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  // branch_id/is_primary only — deliberately NOT embedding
  // business_branches(name) here. business_invitation_branches' own SELECT
  // policy is gated on staff.invite (matches this function's own
  // authorization), but PostgREST enforces EACH embedded table's RLS
  // independently — a nested business_branches embed would still be
  // gated on branches.view, silently returning null for every row for
  // exactly the staff.invite-only-no-branches.view caller this function
  // exists to serve (Codex adversarial review, application-layer round 2,
  // Medium 1 — the same root cause as the invite form's own branch
  // picker, just manifesting here in the invitation LIST instead). Names
  // are resolved separately below via get_invitation_branch_options,
  // which is gated on staff.invite alone.
  business_invitation_branches: { branch_id: string; is_primary: boolean }[] | null;
};

// Callers of this function must have already verified staff.invite
// themselves (the page/action calling in — see
// app/[businessId]/staff/page.tsx and
// app/[businessId]/staff/invitations/page.tsx) — this DAL, like every
// other DAL in this app, is permission-agnostic; RLS
// (business_invitations_select, gated on staff.invite at the database
// layer too) is the actual technical backstop, never bypassed by this
// function's own logic.
export const listInvitations = cache(async (businessId: string): Promise<InvitationRow[]> => {
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_invitations")
    .select(`${INVITATION_COLUMNS}, roles(name), business_invitation_branches(branch_id, is_primary)`)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load invitations: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as RawInvitationRow[];

  // Branch NAMES are resolved via the staff.invite-gated RPC, not the
  // branches.view-gated table — see RawInvitationRow's own comment above.
  // This only ever returns ACTIVE branches, so a branch referenced by an
  // older invitation that has SINCE been deactivated deliberately falls
  // back to a generic label below, exactly like a snapshot of
  // now-stale-but-once-valid data — never blank, never a raw id.
  const options = await listInvitationBranchOptions(businessId);
  const nameById = new Map(options.map((b) => [b.id, b.name] as const));

  return rows.map((row) => ({
    id: row.id,
    business_id: row.business_id,
    email: row.email,
    role_id: row.role_id,
    role_name: row.roles?.name ?? "—",
    status: row.status,
    expires_at: row.expires_at,
    invited_by: row.invited_by,
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    branches: (row.business_invitation_branches ?? []).map((b) => ({
      branch_id: b.branch_id,
      is_primary: b.is_primary,
      branch_name: nameById.get(b.branch_id) ?? "Inactive branch",
    })),
  }));
});

// Invitation branch options — the staff.invite-only branch picker ---------
//
// Codex adversarial review, application-layer round 2, Medium 1:
// business_branches' own SELECT RLS policy requires branches.view, which
// a caller who holds staff.invite WITHOUT branches.view (a real, intended
// permission combination — see branches_staff_permissions.sql's seeded
// matrix, which never implies one from the other) does not have. This
// calls the new, narrowly-scoped public.get_invitation_branch_options RPC
// (20260828080800_invitation_branch_options_rpc.sql — the ONE additive
// migration this remediation added) instead of the ordinary
// business_branches table — authorized on staff.invite alone, returning
// only {id, name, code} for ACTIVE branches in this business. This is
// the ONLY safe path to that data for an invite-only caller; it is never
// acceptable to reach for a service-role client here (see that
// migration's own header comment for the full reasoning).
export type InvitationBranchOption = { id: string; name: string; code: string | null };

export const listInvitationBranchOptions = cache(
  async (businessId: string): Promise<InvitationBranchOption[]> => {
    await requireUser();
    const supabase = await createClient();

    const { data, error } = await supabase.rpc("get_invitation_branch_options", { p_business_id: businessId });
    if (error) {
      throw new Error(`Failed to load branch options: ${error.message}`);
    }

    return (data ?? []) as unknown as InvitationBranchOption[];
  }
);
