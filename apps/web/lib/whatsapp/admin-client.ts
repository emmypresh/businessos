import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * SERVER-ONLY, narrowly-scoped service-role client — mirrors
 * lib/billing/admin-client.ts's own exact precedent and rationale. Its
 * only legitimate callers are app/api/webhooks/meta-whatsapp/route.ts
 * (no BusinessOS session exists for a Meta webhook delivery) and the
 * outbound-send Server Action's post-provider-response bookkeeping
 * (binding a provider_message_id / recording a synchronous failure —
 * both restricted to `service_role` EXECUTE specifically, see
 * 20260908080000_whatsapp_application_provider_writer.sql).
 *
 * `import "server-only"` makes any accidental import from a Client
 * Component a build-time error. SUPABASE_SECRET_KEY is read here and
 * nowhere else new — this is the SAME already-established admin-client
 * pattern, not a new secret or a new trust boundary.
 */
export function createWhatsappAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set to process WhatsApp provider events.");
  }
  return createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
