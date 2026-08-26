// Env vars are loaded by tests/integration/setup-env.ts (a Vitest
// setupFile), which runs before this module is imported by any test.
import postgres from "postgres";
import { assertLocalDatabaseUrl } from "./url-safety";

/**
 * Direct Postgres access for test fixture setup ONLY — e.g. forcing a
 * business_members row into a status ('suspended', 'removed') that no
 * Supabase API client (authenticated or service_role) is permitted to
 * write (business_members has no INSERT/UPDATE grant for either role —
 * see create_business_members.sql). Never used to read or assert
 * application behavior; the assertions in every test still go through
 * createUserClient()/RLS/RPCs, exactly as the real app would.
 */
export function createTestDbClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must be set in .env.test.local");
  }
  // Real URL parsing with exact hostname/protocol/port/database-name
  // checks — see url-safety.ts for why a substring check is unsafe.
  assertLocalDatabaseUrl(url);
  return postgres(url, { max: 1 });
}
