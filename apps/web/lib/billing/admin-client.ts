import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * SERVER-ONLY, narrowly-scoped service-role client — mirrors
 * lib/auth/recovery-grant-admin-client.ts's own exact precedent and
 * exact rationale for why this is safe: its only legitimate caller is
 * app/api/webhooks/paystack/route.ts, and its only legitimate use is
 * invoking the six public.*_paystack_* wrappers whose EXECUTE grant is
 * restricted to `service_role` specifically
 * (20260905080200_billing_provider_writer.sql) — a Paystack webhook
 * carries no BusinessOS user session at all, so there is no
 * authenticated/anon JWT this call could ever be made with instead.
 *
 * `import "server-only"` makes any accidental import from a Client
 * Component a build-time error. SUPABASE_SECRET_KEY (never a
 * NEXT_PUBLIC_ variable) is read here and nowhere else that isn't
 * already an established exception to this codebase's "no admin client"
 * rule.
 */
export function createBillingAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set to process a billing provider event."
    );
  }
  return createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
