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
    await sql`
      insert into public.business_members (business_id, user_id, role_id, status)
      select ${businessId}, ${userId}, roles.id, ${status}
      from public.roles where roles.name = ${roleName}
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
