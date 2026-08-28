// Shared fixtures for Phase 1F (branches + staff/invitations) integration
// tests. Mirrors tests/integration/helpers/sales.ts's/expenses.ts's
// pattern exactly.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { randomUuid } from "./inventory";
import { createTestDbClient } from "./db-client";

type Client = SupabaseClient<Database>;

export async function getDefaultBranchId(client: Client, businessId: string) {
  const { data, error } = await client
    .from("business_branches")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_default", true)
    .single();
  if (error || !data) throw new Error(`no default branch: ${error?.message}`);
  return data.id as string;
}

export async function createBranch(
  client: Client,
  businessId: string,
  overrides: { name?: string; code?: string; creationKey?: string } = {}
) {
  const { data, error } = await client.rpc("create_business_branch", {
    p_business_id: businessId,
    p_creation_key: overrides.creationKey ?? randomUuid(),
    p_name: overrides.name ?? `Branch ${randomUuid()}`,
    p_code: overrides.code,
  });
  if (error || !data) throw new Error(`create_business_branch failed: ${error?.message}`);
  return data as string;
}

export function invitationPayload(
  businessId: string,
  email: string,
  role: string,
  overrides: {
    creationKey?: string;
    branchIds?: string[];
    primaryBranchId?: string;
  } = {}
) {
  return {
    p_business_id: businessId,
    p_creation_key: overrides.creationKey ?? randomUuid(),
    p_email: email,
    p_role: role,
    p_branch_ids: overrides.branchIds ?? [],
    p_primary_branch_id: overrides.primaryBranchId,
  };
}

export async function inviteMember(
  client: Client,
  businessId: string,
  email: string,
  role: string,
  overrides: Parameters<typeof invitationPayload>[3] = {}
) {
  // Codex adversarial review, Finding 3: create_business_invitation now
  // requires at least one branch and a primary among them (an invitation
  // can never be accepted into a zero-branch, no-primary membership — the
  // same LOCKED INVARIANT active members are held to). Tests that exist
  // to exercise invite/accept semantics UNRELATED to branches (role
  // hierarchy, idempotency, expiry, revocation, email matching, etc.)
  // should not each have to know that — so this helper defaults to the
  // business's own default branch as BOTH the sole assignment and the
  // primary whenever the caller doesn't explicitly override branchIds.
  // Tests that specifically exercise branch behavior (foreign branch,
  // inactive branch, empty/no-primary rejection) always pass their own
  // explicit branchIds/primaryBranchId and are unaffected by this default.
  //
  // Looked up via a PRIVILEGED direct-SQL connection, never through
  // `client` itself — `client` here is often a caller with only
  // staff.invite (e.g. an ADMIN with no branches.view), and
  // business_branches' own SELECT policy requires branches.view, so a
  // client-side lookup would spuriously fail for exactly the callers this
  // default exists to make invite-hierarchy tests not have to think about.
  // This is fixture setup (finding a valid id to pass to the RPC), never
  // an assertion, matching this project's own createTestDbClient()
  // convention exactly.
  let effectiveOverrides = overrides;
  if (overrides.branchIds === undefined) {
    const sql = createTestDbClient();
    let defaultBranchId: string;
    try {
      const rows = await sql<{ id: string }[]>`
        select id from public.business_branches
        where business_id = ${businessId} and is_default = true
      `;
      if (!rows[0]) throw new Error(`no default branch for business ${businessId}`);
      defaultBranchId = rows[0].id;
    } finally {
      await sql.end();
    }
    effectiveOverrides = { ...overrides, branchIds: [defaultBranchId], primaryBranchId: defaultBranchId };
  }
  const { data, error } = await client.rpc(
    "create_business_invitation",
    invitationPayload(businessId, email, role, effectiveOverrides)
  );
  if (error || !data) throw new Error(`create_business_invitation failed: ${error?.message}`);
  return data as string;
}

export async function acceptInvitation(client: Client, invitationId: string) {
  const { data, error } = await client.rpc("accept_business_invitation", {
    p_invitation_id: invitationId,
  });
  if (error || !data) throw new Error(`accept_business_invitation failed: ${error?.message}`);
  return data as string;
}

/**
 * Forces an invitation into the past directly via Postgres — there is no
 * caller-controlled expiry parameter (expires_at is server-authoritative,
 * always now() + 7 days — see create_business_invitation's own header
 * comment), so an expired-invitation fixture can only be constructed by
 * reaching around the RPC boundary, exactly like membership-status.test.ts's
 * own direct-SQL justification for business_members.status.
 */
export async function expireInvitation(invitationId: string) {
  const sql = createTestDbClient();
  try {
    await sql`
      update public.business_invitations
      set expires_at = now() - interval '1 hour'
      where id = ${invitationId}
    `;
  } finally {
    await sql.end();
  }
}

export function randomEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
