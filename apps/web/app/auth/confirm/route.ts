import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSafeRedirectPath } from "@/lib/safe-redirect";
import { RECOVERY_GRANT_COOKIE, RECOVERY_GRANT_MAX_AGE_SECONDS } from "@/lib/auth/recovery-grant";
import { createRecoveryGrantAdminClient } from "@/lib/auth/recovery-grant-admin-client";

// Phase 1B implements exactly signup-confirmation and password-recovery —
// not email-change, invite, magic-link, or any other flow — so only these
// two real, documented EmailOtpType values are accepted, even though the
// type system permits more. An unrecognized type fails safely rather than
// being forwarded to verifyOtp unchecked.
const ALLOWED_EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["email", "recovery"];

function parseEmailOtpType(value: string | null): EmailOtpType | null {
  if (!value) return null;
  return (ALLOWED_EMAIL_OTP_TYPES as readonly string[]).includes(value)
    ? (value as EmailOtpType)
    : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = parseEmailOtpType(searchParams.get("type"));
  const next = isSafeRedirectPath(searchParams.get("next"), "/");

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      if (type === "recovery") {
        // Mint the recovery-specific, server-verifiable capability that
        // gates updatePassword — claims.amr cannot be used for this (see
        // the migration's header comment: verified empirically that
        // signup-confirmation and recovery sessions, and both again after
        // a token refresh, all record amr method "otp" identically).
        //
        // Read the identity verifyOtp JUST established, from the ordinary
        // cookie-bound client (never the admin one) — this is the
        // authoritative, freshly-verified user_id/session_id, not
        // anything client-supplied.
        const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
        const claims = !claimsError ? claimsData?.claims : null;
        const verifiedUserId = (claims as { sub?: string } | null)?.sub;
        const verifiedSessionId = (claims as { session_id?: string } | null)?.session_id;

        if (!verifiedUserId || !verifiedSessionId) {
          redirect("/login?error=confirmation-failed");
        }

        // issue_recovery_grant is executable ONLY by service_role (see the
        // migration) — no authenticated session, including this one, can
        // call it directly. This admin client is the one narrow,
        // documented exception to "never use the admin client for normal
        // operations," used for exactly this one RPC and nothing else.
        const admin = createRecoveryGrantAdminClient();
        const { data: grantId, error: grantError } = await admin.rpc(
          "issue_recovery_grant",
          { p_user_id: verifiedUserId, p_session_id: verifiedSessionId }
        );
        if (grantError || !grantId) {
          // Fail safe: without a grant, updatePassword will always reject
          // this session anyway, but redirecting to reset-password with a
          // silently-broken promise is worse than surfacing the failure
          // now, at the one point that actually knows it happened.
          redirect("/login?error=confirmation-failed");
        }
        const cookieStore = await cookies();
        cookieStore.set(RECOVERY_GRANT_COOKIE, grantId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: RECOVERY_GRANT_MAX_AGE_SECONDS,
        });
      }
      redirect(next);
    }
  }

  redirect("/login?error=confirmation-failed");
}
