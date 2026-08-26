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
    // Non-browser test client: no storage to persist to, nothing to
    // auto-refresh a live session for, and no URL to ever contain a
    // session fragment. `detectSessionInUrl` defaults to true in
    // supabase-js (a browser-oriented default); disabling it here is not
    // a behavior change for this client — a Node test process is never
    // navigated to a URL a session could appear in — only a narrowing of
    // what supabase-js sets up internally, part of this session's audit
    // of every non-browser client's auth config (never applied to
    // lib/supabase/client.ts / server.ts, the real app's clients, which
    // are untouched).
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
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
    // Non-browser test client. `persistSession` only governs writing the
    // session to an external store so a DIFFERENT/later client instance
    // can restore it — the CURRENT instance keeps its session in memory
    // regardless of this flag, which is all every test here ever relies
    // on (each test signs in explicitly on its own client instance; none
    // depend on a session surviving into a new instance via storage).
    // `false` is both more correct for a client with no real storage
    // backing in Node and, per this session's audit, removes one more
    // category of resource supabase-js might otherwise set up trying to
    // persist to a storage adapter that doesn't meaningfully exist here.
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
