// Shared fixtures for Phase 1C (products + inventory) integration tests.
// Mirrors the pattern already used by membership-status.test.ts: business
// membership with a specific role has no app-level invite RPC yet, so
// additional members are inserted directly via the raw Postgres test
// client — never as an assertion of application behavior, only as fixture
// setup, exactly like that existing test already does for status.
import { createConfirmedTestUser, createUserClient } from "./admin-client";
import { createTestDbClient } from "./db-client";

const PASSWORD = "Password1234";

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createOwnerAndBusiness(prefix: string) {
  const email = `${unique(prefix)}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  const client = createUserClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  const { data: business, error } = await client.rpc("create_business", {
    p_name: prefix,
    p_slug: unique(prefix),
  });
  if (error || !business) throw new Error(`create_business failed: ${error?.message}`);

  return { userId: user.id, email, client, businessId: business.id as string };
}

export async function getDefaultLocationId(client: ReturnType<typeof createUserClient>, businessId: string) {
  const { data, error } = await client
    .from("inventory_locations")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_default", true)
    .single();
  if (error || !data) throw new Error(`no default location: ${error?.message}`);
  return data.id as string;
}

export async function addMemberWithRole(
  businessId: string,
  userId: string,
  roleName: string,
  status: "active" | "suspended" | "removed" | "invited" = "active"
) {
  const sql = createTestDbClient();
  try {
    const [member] = await sql<{ id: string }[]>`
      insert into public.business_members (business_id, user_id, role_id, status)
      select ${businessId}, ${userId}, roles.id, ${status}
      from public.roles where roles.name = ${roleName}
      returning id
    `;
    // Phase 1G: a REAL staff member (onboarded via accept_business_invitation,
    // the only other way a business_members row is ever created) always
    // ends up with a real branch assignment — the invited branch(es), copied
    // atomically at acceptance. This raw-SQL fixture bypasses that whole
    // flow, so without this it would otherwise simulate a member with ZERO
    // branch assignments — a state no real invited member is ever actually
    // in (only the pre-Phase-1G-vintage, one-off auto-created OWNER row
    // used to be in that state, and even that gap is now closed by
    // ensure_member_branch_access.sql). Defaults to the business's own
    // default branch, as primary, exactly mirroring that migration's own
    // backfill — any test that needs a DIFFERENT branch set calls
    // replace_member_branches itself afterward (a wholesale replace, so
    // this default is simply overwritten, never additive).
    await sql`
      insert into public.business_member_branches (business_id, member_id, branch_id, is_primary, assigned_by)
      select ${businessId}, ${member.id}, bb.id, true, ${userId}
      from public.business_branches bb
      where bb.business_id = ${businessId} and bb.is_default = true
    `;
  } finally {
    await sql.end();
  }
}

export async function createMemberWithRole(businessId: string, prefix: string, roleName: string) {
  const email = `${unique(prefix + "-" + roleName.toLowerCase())}@example.test`;
  const user = await createConfirmedTestUser(email, PASSWORD);
  await addMemberWithRole(businessId, user.id, roleName);
  const client = createUserClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return { userId: user.id, email, client };
}

export function randomUuid() {
  return crypto.randomUUID();
}

// Every seeded role (SALES, ACCOUNTANT, ...) happens to bundle several
// Phase 1D permissions together, so no seeded role can prove two
// permissions are checked independently rather than one implying the
// other. This inserts a genuinely deliberate, one-off role directly into
// the same reference tables the approved migration seeds (public.roles /
// public.role_permissions) — fixture setup only, exactly like
// addMemberWithRole already does for business_members, never an
// assertion of application behavior and never a schema change. The role
// name is unique per call so parallel/repeated test runs never collide.
export async function createRoleWithPermissions(permissionKeys: string[]) {
  const roleName = unique("test-role");
  const sql = createTestDbClient();
  try {
    const [role] = await sql<{ id: string }[]>`
      insert into public.roles (name, description)
      values (${roleName}, 'Test-fixture role: deliberately constructed nonstandard permission set, never a real product role.')
      returning id
    `;
    if (permissionKeys.length > 0) {
      await sql`
        insert into public.role_permissions (role_id, permission_id)
        select ${role.id}, p.id
        from public.permissions p
        where p.key = any(${permissionKeys})
      `;
    }
    return roleName;
  } finally {
    await sql.end();
  }
}

export async function createMemberWithCustomPermissions(
  businessId: string,
  prefix: string,
  permissionKeys: string[]
) {
  const roleName = await createRoleWithPermissions(permissionKeys);
  return createMemberWithRole(businessId, prefix, roleName);
}
