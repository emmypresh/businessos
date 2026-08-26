// Env vars are loaded by tests/integration/setup-env.ts (a Vitest
// setupFile), which runs before this module is imported by any test.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { assertLocalSupabaseUrl } from "./url-safety";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_TEST_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_TEST_SECRET_KEY must be set in .env.test.local (see .env.test.local.example)"
    );
  }
  // Real URL parsing with exact hostname/protocol/port checks — see
  // url-safety.ts for why a substring check (e.g. url.includes("localhost"))
  // is unsafe (it accepts "localhost.attacker.example").
  assertLocalSupabaseUrl(url);
  return createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function createConfirmedTestUser(email: string, password: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message}`);
  }
  return data.user;
}

export async function deleteTestUser(userId: string) {
  const admin = createAdminClient();
  await admin.auth.admin.deleteUser(userId);
}

export function createUserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env.test.local"
    );
  }
  assertLocalSupabaseUrl(url);
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: true },
  });
}
