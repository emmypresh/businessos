import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * SERVER-ONLY, narrowly-scoped service-role client. This is the ONE
 * intentional exception to this codebase's rule against using an admin
 * client for normal application operations — and it stays an exception:
 * do not reach for this to replace an ordinary authenticated query
 * anywhere else. Its only legitimate caller is
 * app/auth/confirm/route.ts, and its only legitimate use is invoking
 * `issue_recovery_grant`, a function whose EXECUTE grant is restricted to
 * `service_role` specifically so that no ordinary authenticated session —
 * reachable only via the anon/publishable key and a user's own JWT — can
 * mint a recovery capability for itself. See the migration
 * (20260826070506_password_recovery_grants.sql) for the full security
 * rationale.
 *
 * `import "server-only"` makes any accidental import from a Client
 * Component a build-time error. SUPABASE_SECRET_KEY (never a
 * NEXT_PUBLIC_ variable) is read here and nowhere else in `app/`/`lib/`.
 */
export function createRecoveryGrantAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set to issue a recovery grant."
    );
  }
  return createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
