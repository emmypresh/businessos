"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isSafeRedirectPath } from "@/lib/safe-redirect";
import { RECOVERY_GRANT_COOKIE, clearRecoveryGrantCookie } from "@/lib/auth/recovery-grant";
import {
  SignUpSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from "@/lib/validation/auth";

export type ActionState =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      success?: boolean;
    }
  | undefined;

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:3000";
}

export async function signUp(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = SignUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${siteUrl()}/auth/confirm?next=/onboarding`,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return { success: true };
}

export async function logIn(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: "Invalid email or password." };
  }

  // `next` came from the login page's ?next= query param, round-tripped
  // through a hidden form field — untrusted the moment it's a URL a user
  // could have edited. Never redirect() with it unvalidated.
  const next = isSafeRedirectPath(formData.get("next") as string | null, "/");
  redirect(next);
}

export async function logOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // The recovery-grant cookie (if any) is not useful after logout and
  // must not survive it — cleanup only, not a security boundary (see
  // clearRecoveryGrantCookie's own comment); a harmless no-op if absent.
  const cookieStore = await cookies();
  clearRecoveryGrantCookie(cookieStore);
  redirect("/login");
}

export async function requestPasswordReset(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = ForgotPasswordSchema.safeParse({
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    { redirectTo: `${siteUrl()}/auth/confirm?next=/reset-password` }
  );

  if (error) {
    // Never surfaced to the client: doing so would let a caller distinguish
    // "email not registered" from "email sent", i.e. enumerate accounts.
    console.error("resetPasswordForEmail failed", error.message);
  }

  return { success: true };
}

export async function updatePassword(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = ResetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();

  // getClaims() (not getUser()): the mandated check for "is there a
  // legitimate session" here, per Global Constraints — getSession() is
  // never used for authorization anywhere in this app.
  const { data, error: claimsError } = await supabase.auth.getClaims();
  const claims = !claimsError ? data?.claims : null;

  if (!claims) {
    redirect("/forgot-password?error=session-expired");
  }

  // A valid session alone is not enough — claims.amr cannot distinguish a
  // recovery-derived session from signup confirmation or an ordinary
  // login (verified empirically: all record amr method "otp" or
  // "password" without ever surfacing which OTP `type` was used, and that
  // holds across a token refresh too — see the migration's header
  // comment for the full account). The actual gate is a single-use,
  // session-bound grant minted by app/auth/confirm/route.ts the moment it
  // verifies a real type=recovery OTP, consumed here atomically via the
  // consume_recovery_grant RPC. No grant cookie, an already-consumed
  // grant, an expired grant, or a grant issued for a *different* session
  // (e.g. this same user's separate ordinary login) all fail the same
  // way: this call returns false, and this endpoint cannot be used to
  // change the password.
  const cookieStore = await cookies();
  const grantId = cookieStore.get(RECOVERY_GRANT_COOKIE)?.value;

  if (!grantId) {
    // Nothing to clear (there was never a cookie), but call it anyway —
    // a harmless no-op — so this branch doesn't silently diverge from
    // every other rejection path below.
    clearRecoveryGrantCookie(cookieStore);
    return {
      error:
        "This link has expired or was already used. Request a new password reset email.",
    };
  }

  const { data: consumed, error: consumeError } = await supabase.rpc(
    "consume_recovery_grant",
    { p_grant_id: grantId }
  );

  if (consumeError || !consumed) {
    // Whatever this cookie was — fabricated, expired, already consumed,
    // or issued for a different user/session — it's rejected and must not
    // linger in the browser to be resubmitted.
    clearRecoveryGrantCookie(cookieStore);
    return {
      error:
        "This link has expired or was already used. Request a new password reset email.",
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    // The grant was successfully consumed above (single-use, already
    // marked spent in the database) even though updateUser itself failed
    // — that capability is gone either way, so the cookie pointing at it
    // must go too; the user has to restart recovery from the top.
    clearRecoveryGrantCookie(cookieStore);
    return { error: error.message };
  }

  // The grant is already consumed (single-use, enforced at the database
  // layer above) — clearing the cookie here is cleanup, not the security
  // boundary. The recovery session's job is done: sign it out and require
  // a fresh login with the new password, rather than silently continuing
  // the session into the app.
  clearRecoveryGrantCookie(cookieStore);
  await supabase.auth.signOut();
  redirect("/login?reset=success");
}
